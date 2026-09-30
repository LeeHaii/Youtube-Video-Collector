import importlib.util
import io
import json
from pathlib import Path
import struct
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("collector_native_host", ROOT / "tools" / "collector_native_host.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class FragmentedReader(io.BytesIO):
    def read(self, size=-1):
        return super().read(min(2, size))


class NativeHostTests(unittest.TestCase):
    def test_same_url_fixtures_as_electron(self):
        fixtures = json.loads((ROOT / "tests" / "fixtures" / "collector-links.json").read_text())
        for fixture in fixtures:
            with self.subTest(url=fixture["url"]):
                if fixture.get("invalid"):
                    with self.assertRaises(host.HostError):
                        host.parse_youtube_url(fixture["url"])
                else:
                    self.assertEqual(host.parse_youtube_url(fixture["url"])["seconds"], fixture["seconds"])

    def test_fragmented_utf8_round_trip(self):
        stream = io.BytesIO()
        value = {"message": "marker \u65e5\u672c"}
        host.write_message(stream, value)
        self.assertEqual(host.read_message(FragmentedReader(stream.getvalue())), value)

    def test_invalid_and_incomplete_framing(self):
        for packet in [b"", struct.pack("<I", 999999), struct.pack("<I", 10) + b"{}", struct.pack("<I", 1) + b"{"]:
            with self.subTest(packet=packet), self.assertRaises(host.HostError):
                host.read_message(io.BytesIO(packet))

    def test_protocol_error_is_a_valid_response(self):
        output = io.BytesIO()
        host.run(io.BytesIO(struct.pack("<I", 1) + b"{"), output, "")
        output.seek(0)
        self.assertEqual(host.read_message(output)["code"], "invalid_request")

    def test_unregistered_extension_is_rejected_before_delivery(self):
        request = {"version": 1, "type": "ping", "requestId": "test"}
        source, output = io.BytesIO(), io.BytesIO()
        host.write_message(source, request)
        source.seek(0)
        with patch.object(host, "load_configuration", side_effect=host.HostError("unauthorized", "Not registered")), patch.object(host, "deliver") as deliver:
            host.run(source, output, "chrome-extension://unknown/")
            deliver.assert_not_called()
        output.seek(0)
        self.assertEqual(host.read_message(output)["code"], "unauthorized")

    def test_only_renderer_acknowledgement_becomes_success(self):
        request = {"version": 1, "type": "open-video", "requestId": "test", "url": "https://youtu.be/6IHKf0lk0Yc?t=118"}
        source, output = io.BytesIO(), io.BytesIO()
        host.write_message(source, request)
        source.seek(0)
        with patch.object(host, "load_configuration", return_value={}), patch.object(host, "deliver", side_effect=host.HostError("startup_timeout", "Timed out")):
            host.run(source, output, "origin")
        output.seek(0)
        response = host.read_message(output)
        self.assertEqual(response["requestId"], "test")
        self.assertEqual(response["status"], "error")

    def test_rejects_invalid_types(self):
        for value in [{"version": True}, {"version": 1, "requestId": "../bad", "type": "ping"}, [], None]:
            with self.subTest(value=value), self.assertRaises(host.HostError):
                host.validate_request(value)


if __name__ == "__main__":
    unittest.main()

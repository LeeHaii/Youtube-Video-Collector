import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path


# The unit tests exercise downloader orchestration without making network calls.
# A tiny import stub lets them run before the pinned build dependencies are installed.
try:
    import yt_dlp  # noqa: F401
except ModuleNotFoundError:
    yt_dlp_module = types.ModuleType("yt_dlp")

    class PlaceholderYoutubeDL:
        pass

    yt_dlp_module.YoutubeDL = PlaceholderYoutubeDL
    yt_dlp_version_module = types.ModuleType("yt_dlp.version")
    yt_dlp_version_module.__version__ = "test"
    sys.modules["yt_dlp"] = yt_dlp_module
    sys.modules["yt_dlp.version"] = yt_dlp_version_module


MODULE_PATH = Path(__file__).parents[1] / "tools" / "5_sec_downloader.py"
SPEC = importlib.util.spec_from_file_location("five_sec_downloader", MODULE_PATH)
downloader = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = downloader
SPEC.loader.exec_module(downloader)


class DownloaderTests(unittest.TestCase):
    def test_output_streams_are_configured_for_immediate_piped_logs(self):
        calls = []

        class FakeStream:
            def reconfigure(self, **kwargs):
                calls.append(kwargs)

        stream = FakeStream()
        self.assertIs(downloader.configure_output_stream(stream), stream)
        self.assertEqual(calls, [{
            "encoding": "utf-8",
            "line_buffering": True,
            "write_through": True,
        }])

    def test_error_classification_keeps_403_separate_from_429(self):
        cases = {
            "ffmpeg exited with code 3436169992": downloader.ERROR_FORBIDDEN,
            "HTTP Error 403: Forbidden": downloader.ERROR_FORBIDDEN,
            "HTTP Error 429: Too Many Requests": downloader.ERROR_RATE_LIMIT,
            "Sign in to confirm your age": downloader.ERROR_AGE_RESTRICTION,
            "Sign in to confirm you are not a bot": downloader.ERROR_AUTHENTICATION,
            "Requested format is not available": downloader.ERROR_FORMAT,
            "This video is unavailable": downloader.ERROR_UNAVAILABLE,
            "connection reset": downloader.ERROR_GENERIC,
        }
        for message, expected in cases.items():
            with self.subTest(message=message):
                self.assertEqual(downloader.classify_error(message), expected)

    def test_ydl_options_use_supported_cache_and_sleep_keys(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            logger = downloader.DownloaderLogger(lambda _message: None)
            options = downloader.build_ydl_options(
                "clip.%(ext)s",
                10,
                15,
                downloader.DOWNLOAD_PROFILES[0],
                Path(temporary_directory) / "ffmpeg.exe",
                Path(temporary_directory) / "cache",
                2.5,
                logger,
                {"name": "node", "path": Path(temporary_directory) / "node.exe"},
            )

        self.assertEqual(options["sleep_interval_requests"], 2.5)
        self.assertIn("cachedir", options)
        self.assertNotIn("sleep_requests", options)
        self.assertNotIn("no-cache-dir", options)
        self.assertNotIn("http_headers", options)
        self.assertEqual(options["js_runtimes"]["node"]["path"], str(Path(temporary_directory) / "node.exe"))

    def test_forbidden_download_retries_with_safari_hls(self):
        attempts = []

        class FakeSession:
            def __init__(self, _url, profile, *_args):
                self.profile = profile

            def download(self, _start, _end, _output):
                attempts.append(self.profile.name)
                if self.profile.name == "standard":
                    raise RuntimeError("ffmpeg exited with code 3436169992")

            def diagnostics(self):
                return "server returned 403"

            def close(self):
                pass

        outcome = downloader.download_clip(
            "https://www.youtube.com/watch?v=test",
            10,
            5,
            "clip.%(ext)s",
            Path("ffmpeg.exe"),
            Path("cache"),
            None,
            0,
            {},
            log_callback=lambda _message: None,
            session_factory=FakeSession,
            sleep_func=lambda _seconds: None,
        )

        self.assertTrue(outcome.ok)
        self.assertEqual(outcome.attempts, 2)
        self.assertEqual(attempts, ["standard", "safari-hls"])

    def test_reused_session_preserves_yt_dlp_normalized_output_template(self):
        processed_templates = []

        class FakeYoutubeDL:
            def __init__(self, options):
                self.params = dict(options)
                self.params["outtmpl"] = {"default": options["outtmpl"]}

            def extract_info(self, _url, download=False):
                self.assert_download_flag = download
                return {"id": "test"}

            def process_ie_result(self, _info, download=True):
                processed_templates.append((self.params["outtmpl"]["default"], download))

            def close(self):
                pass

        original_youtube_dl = downloader.YoutubeDL
        downloader.YoutubeDL = FakeYoutubeDL
        try:
            with tempfile.TemporaryDirectory() as temporary_directory:
                session = downloader.VideoDownloadSession(
                    "https://www.youtube.com/watch?v=test",
                    downloader.DOWNLOAD_PROFILES[0],
                    Path(temporary_directory) / "ffmpeg.exe",
                    Path(temporary_directory) / "cache",
                    0,
                    None,
                    lambda _message: None,
                )
                session.download(0, 5, "first.%(ext)s")
                session.download(5, 10, "second.%(ext)s")
        finally:
            downloader.YoutubeDL = original_youtube_dl

        self.assertEqual(processed_templates, [
            ("first.%(ext)s", True),
            ("second.%(ext)s", True),
        ])

    def test_successful_fallback_profile_is_reused_first(self):
        attempts = []

        class CachedSafariSession:
            def download(self, _start, _end, _output):
                attempts.append("safari-hls")

            def diagnostics(self):
                return ""

            def close(self):
                pass

        outcome = downloader.download_clip(
            "https://www.youtube.com/watch?v=test",
            20,
            5,
            "clip.%(ext)s",
            Path("ffmpeg.exe"),
            Path("cache"),
            None,
            0,
            {"safari-hls": CachedSafariSession()},
            log_callback=lambda _message: None,
            session_factory=lambda *_args: self.fail("cached fallback should be reused"),
            sleep_func=lambda _seconds: None,
        )

        self.assertTrue(outcome.ok)
        self.assertEqual(outcome.attempts, 1)
        self.assertEqual(attempts, ["safari-hls"])

    def test_partial_processing_keeps_stable_clip_numbers_and_exit_code(self):
        calls = []

        def fake_download(_url, _timestamp, _duration, output_template, *_args, **_kwargs):
            calls.append(Path(output_template).name)
            if len(calls) == 1:
                return downloader.ClipOutcome(downloader.ERROR_FORBIDDEN)
            return downloader.ClipOutcome("OK")

        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory)
            csv_path = temporary_path / "input.csv"
            csv_path.write_text(
                "https://www.youtube.com/watch?v=test,0.05;0.10\n",
                encoding="utf-8",
            )
            old_local_app_data = os.environ.get("LOCALAPPDATA")
            os.environ["LOCALAPPDATA"] = str(temporary_path / "app-data")
            try:
                summary = downloader.process_clips(
                    str(csv_path),
                    str(temporary_path / "output"),
                    Path("ffmpeg.exe"),
                    None,
                    clip_sleep_min=0,
                    clip_sleep_max=0,
                    row_sleep_min=0,
                    row_sleep_max=0,
                    log_callback=lambda _message: None,
                    download_clip_func=fake_download,
                    sleep_func=lambda _seconds: None,
                )
            finally:
                if old_local_app_data is None:
                    os.environ.pop("LOCALAPPDATA", None)
                else:
                    os.environ["LOCALAPPDATA"] = old_local_app_data

        self.assertEqual(calls, ["1.1.1.%(ext)s", "1.1.2.%(ext)s"])
        self.assertEqual(summary.total, 2)
        self.assertEqual(summary.succeeded, 1)
        self.assertEqual(summary.failed, 1)
        self.assertEqual(summary.exit_code(), downloader.EXIT_PARTIAL_FAILURE)


if __name__ == "__main__":
    unittest.main()

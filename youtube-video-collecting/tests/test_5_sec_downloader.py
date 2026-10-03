import importlib.util
import contextlib
import copy
import io
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


# The unit tests exercise downloader orchestration without making network calls.
# A tiny import stub lets them run before the pinned build dependencies are installed.
try:
    import yt_dlp  # noqa: F401
    REAL_YT_DLP_AVAILABLE = True
except ModuleNotFoundError:
    REAL_YT_DLP_AVAILABLE = False
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
    def test_resolution_profiles_preserve_auto_and_do_not_mutate_globals(self):
        self.assertIs(downloader.profiles_for_resolution(), downloader.DOWNLOAD_PROFILES)
        for height in downloader.SUPPORTED_HEIGHTS:
            profiles = downloader.profiles_for_resolution(height)
            for original, selected in zip(downloader.DOWNLOAD_PROFILES, profiles):
                self.assertEqual(selected.name, original.name)
                self.assertEqual(selected.player_clients, original.player_clients)
                self.assertEqual(selected.max_height, height)
                self.assertIsNone(original.max_height)
                self.assertEqual(original.format_selector, downloader.DEFAULT_FORMAT)
        for invalid in (0, -720, 999, "720", True):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                downloader.profiles_for_resolution(invalid)

    def test_cli_preserves_legacy_arguments_and_defaults(self):
        args = downloader.parse_arguments(["input file.csv", "output folder"])
        self.assertEqual((args.clip_sleep_min, args.clip_sleep_max, args.row_sleep_min, args.row_sleep_max), (1, 2, 10, 15))
        self.assertIsNone(args.max_height)
        self.assertIsNone(args.stop_flag_path)
        args = downloader.parse_arguments(["input file.csv", "output folder", "0", "0.5", "2", "3", "stop flag.txt"])
        self.assertEqual((args.clip_sleep_min, args.clip_sleep_max, args.row_sleep_min, args.row_sleep_max), (0, 0.5, 2, 3))
        self.assertEqual(args.stop_flag_path, "stop flag.txt")
        self.assertIsNone(args.max_height)

    def test_cli_accepts_resolution_with_or_without_optional_positionals(self):
        for height in downloader.SUPPORTED_HEIGHTS:
            for positional in ([], ["1", "2", "10", "15", "stop flag.txt"]):
                args = downloader.parse_arguments(["input.csv", "output", *positional, "--resolution", str(height)])
                self.assertEqual(args.max_height, height)
                self.assertEqual(args.stop_flag_path, "stop flag.txt" if positional else None)

    def test_invalid_arguments_fail_before_download_setup(self):
        for arguments in (["input.csv", "output", "--resolution", "999"], ["input.csv", "output", "bad-sleep"]):
            with patch.object(sys, "argv", ["downloader", *arguments]), patch.object(downloader, "find_ffmpeg_exe") as find_ffmpeg:
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                    downloader.main()
                self.assertEqual(raised.exception.code, downloader.EXIT_FATAL)
                find_ffmpeg.assert_not_called()

    def test_help_exits_without_download_setup(self):
        with patch.object(sys, "argv", ["downloader", "--help"]), patch.object(downloader, "find_js_runtime") as runtime:
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as raised:
                downloader.main()
            self.assertEqual(raised.exception.code, downloader.EXIT_SUCCESS)
            runtime.assert_not_called()

    def test_explicit_resolution_survives_all_retries_and_cached_reuse(self):
        created, attempts = [], []

        class FakeSession:
            def __init__(self, _url, profile, *_args):
                self.profile = profile
                created.append(profile)

            def download(self, _start, _end, _output):
                attempts.append(self.profile.name)
                if self.profile.name != "embedded":
                    raise RuntimeError("HTTP Error 403: Forbidden")

            def diagnostics(self):
                return ""

            def close(self):
                pass

        sessions = {}
        with tempfile.TemporaryDirectory() as directory:
            for timestamp in (0, 10):
                outcome = downloader.download_clip(
                    "https://www.youtube.com/watch?v=test", timestamp, 5,
                    str(Path(directory) / f"{timestamp}.%(ext)s"), Path("ffmpeg.exe"), Path("cache"), None, 0, sessions,
                    session_factory=FakeSession, sleep_func=lambda _: None, log_callback=lambda _: None,
                    profiles=downloader.profiles_for_resolution(720),
                )
                self.assertTrue(outcome.ok)
        self.assertEqual(attempts, ["standard", "safari-hls", "embedded", "embedded"])
        self.assertEqual(len(created), 3)
        self.assertTrue(all(profile.max_height == 720 for profile in created))
        self.assertTrue(all(profile.format_selector.endswith("best[height<=720]") for profile in created))
        downloader.close_sessions(sessions)

    def test_process_passes_one_profile_set_per_explicit_run_and_keeps_auto_callback_contract(self):
        calls = []

        def fake_download(*_args, log_callback, stop_event, stop_flag_path, sleep_func, **kwargs):
            calls.append(kwargs)
            return downloader.ClipOutcome("OK")

        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            csv_path = base / "input.csv"
            csv_path.write_text("https://www.youtube.com/watch?v=test,0.05;0.10\n", encoding="utf-8")
            with patch.object(downloader, "app_data_directory", return_value=base / "app-data"):
                for height in (2160, None):
                    summary = downloader.process_clips(
                        str(csv_path), str(base / "output"), Path("ffmpeg.exe"), None, 0, 0, 0, 0,
                        download_clip_func=fake_download, log_callback=lambda _: None,
                        sleep_func=lambda _: None, max_height=height,
                    )
                    self.assertEqual(summary.succeeded, 2)
        self.assertIs(calls[0]["profiles"], calls[1]["profiles"])
        self.assertEqual(calls[0]["profiles"][0].max_height, 2160)
        self.assertEqual(calls[2:], [{}, {}])

    def test_stop_prevents_explicit_download(self):
        with tempfile.TemporaryDirectory() as directory:
            stop = Path(directory) / "stop.flag"
            stop.write_text("STOP")
            outcome = downloader.download_clip(
                "https://example.test", 0, 5, "unused.%(ext)s", Path("ffmpeg.exe"), Path("cache"), None, 0, {},
                stop_flag_path=str(stop), session_factory=lambda *_: self.fail("download must not start"),
                profiles=downloader.profiles_for_resolution(720),
            )
        self.assertEqual(outcome.status, "CANCELED")

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
        extracted = []
        logs = []

        class FakeYoutubeDL:
            def __init__(self, options):
                self.params = dict(options)
                self.params["outtmpl"] = {"default": options["outtmpl"]}

            def extract_info(self, _url, download=False):
                extracted.append(_url)
                self.assert_download_flag = download
                return {"id": "test", "width": 1280, "height": 720}

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
                    downloader.profiles_for_resolution(720)[0],
                    Path(temporary_directory) / "ffmpeg.exe",
                    Path(temporary_directory) / "cache",
                    0,
                    None,
                    logs.append,
                )
                session.download(0, 5, "first.%(ext)s")
                session.download(5, 10, "second.%(ext)s")
                self.assertEqual(session.options["format_sort"], ["height", "+hasaud"])
        finally:
            downloader.YoutubeDL = original_youtube_dl

        self.assertEqual(processed_templates, [
            ("first.%(ext)s", True),
            ("second.%(ext)s", True),
        ])
        self.assertEqual(len(extracted), 1)
        self.assertEqual(logs, ["      Selected source: 1280x720 (standard)\n"])

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


@unittest.skipUnless(REAL_YT_DLP_AVAILABLE, "install pinned yt-dlp dependencies to verify real format selection")
class RealFormatSelectionTests(unittest.TestCase):
    @staticmethod
    def video(height, **overrides):
        return {
            "format_id": f"v{height}", "url": f"https://media.invalid/v{height}.mp4",
            "ext": "mp4", "vcodec": "avc1", "acodec": "none", "width": height * 16 // 9 if height else None,
            "height": height, **overrides,
        }

    @staticmethod
    def audio():
        return {"format_id": "audio", "url": "https://media.invalid/audio.m4a", "ext": "m4a", "vcodec": "none", "acodec": "aac"}

    def select(self, height, formats):
        with tempfile.TemporaryDirectory() as directory:
            options = downloader.build_ydl_options(
                "unused.%(ext)s", 0, 5, downloader.profiles_for_resolution(height)[0],
                Path(directory) / "ffmpeg.exe", Path(directory) / "cache", 0,
                downloader.DownloaderLogger(lambda _: None), None,
            )
            options["cachedir"] = False
            with downloader.YoutubeDL(options) as ydl:
                return ydl.process_ie_result({
                    "id": "synthetic", "title": "Synthetic format selection", "extractor": "test",
                    "formats": copy.deepcopy(formats),
                }, download=False)

    def test_every_cap_picks_largest_qualifying_video_with_audio(self):
        formats = [self.video(height) for height in downloader.SUPPORTED_HEIGHTS] + [self.audio()]
        for height in downloader.SUPPORTED_HEIGHTS:
            with self.subTest(height=height):
                selected = self.select(height, formats)
                self.assertEqual(selected["height"], height)
                self.assertEqual(selected["requested_formats"][1]["format_id"], "audio")

    def test_4k_choice_uses_1080_max_source_and_prefers_height_over_quality_rank(self):
        selected = self.select(2160, [
            self.video(480, quality=100, preference=100),
            self.video(1080, quality=0, preference=-1), self.audio(),
        ])
        self.assertEqual(selected["height"], 1080)

    def test_lower_source_is_not_upscaled(self):
        selected = self.select(720, [self.video(480), self.audio()])
        self.assertEqual((selected["width"], selected["height"]), (853, 480))

    def test_combined_stream_fallback_obeys_cap(self):
        selected = self.select(720, [self.video(1080, acodec="aac"), self.video(480, acodec="aac")])
        self.assertEqual(selected["height"], 480)
        self.assertEqual(selected["acodec"], "aac")

    def test_higher_combined_stream_wins_over_lower_separate_stream(self):
        selected = self.select(2160, [self.video(720), self.video(1080, acodec="aac"), self.audio()])
        self.assertEqual(selected["height"], 1080)
        self.assertEqual(selected["acodec"], "aac")

    def test_equal_height_prefers_separate_video_and_audio(self):
        selected = self.select(720, [self.video(720, format_id="combined", acodec="aac"), self.video(720), self.audio()])
        self.assertEqual(selected["requested_formats"][0]["format_id"], "v720")
        self.assertEqual(selected["requested_formats"][1]["format_id"], "audio")

    def test_unknown_or_above_cap_streams_cannot_escape(self):
        for formats in ([self.video(1080), self.audio()], [self.video(None, acodec="aac")]):
            with self.subTest(formats=formats), self.assertRaises(Exception) as raised:
                self.select(720, formats)
            self.assertEqual(downloader.classify_error(str(raised.exception)), downloader.ERROR_FORMAT)

    def test_portrait_selection_uses_pixel_height(self):
        selected = self.select(720, [self.video(1280, width=720), self.video(640, width=360), self.audio()])
        self.assertEqual((selected["width"], selected["height"]), (360, 640))

    def test_auto_retains_unrestricted_fallback_after_capped_selection(self):
        self.assertEqual(self.select(720, [self.video(480), self.audio()])["height"], 480)
        self.assertEqual(self.select(None, [self.video(2160, acodec="aac")])["height"], 2160)


if __name__ == "__main__":
    unittest.main()

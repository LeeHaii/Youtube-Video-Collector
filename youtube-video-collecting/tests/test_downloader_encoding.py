"""Encoding policy and real yt-dlp range-download regressions; no external network."""
import copy
import functools
import http.server
import os
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from test_5_sec_downloader import downloader, REAL_YT_DLP_AVAILABLE


class EncodingTests(unittest.TestCase):
    def test_output_arguments_encode_on_download_side_and_preserve_fps(self):
        policy = downloader.EncodingPolicy(3840, 2160, 60, "HLG", True)
        args = downloader.encoding_arguments(policy)
        self.assertEqual(args[args.index("-pix_fmt") + 1], "yuv420p")
        self.assertIn("transferin=arib-std-b67", args[args.index("-vf") + 1])
        self.assertIn("tonemap=", args[args.index("-vf") + 1])
        self.assertNotIn("-r", args)
        self.assertNotIn("-level", args)
        self.assertNotIn("fps=", args[args.index("-vf") + 1])
        sdr = downloader.encoding_arguments(downloader.EncodingPolicy(1920, 1080, 60, "SDR", True))
        self.assertNotIn("-vf", sdr)
        self.assertEqual(args[args.index("-f") + 1], "mp4")

    def test_selected_video_ignores_other_available_hdr_formats(self):
        video = {"url": "https://example.test/v", "vcodec": "avc1", "acodec": "none", "dynamic_range": "SDR",
                 "width": 1280, "height": 720, "fps": 30}
        info = {"requested_formats": [video, {"vcodec": "none", "acodec": "opus"}],
                "formats": [{**video, "dynamic_range": "HLG", "height": 2160}]}
        data = {"streams": [{"codec_type": "video", "width": 1280, "height": 720,
                             "avg_frame_rate": "30", "color_transfer": "bt709"}]}
        with patch.object(downloader, "probe_media", return_value=data) as probe:
            ydl = unittest.mock.Mock()
            ydl.cookiejar.get_cookies_for_url.return_value = []
            ydl._calc_headers.return_value = {}
            policy = downloader.resolve_encoding_policy(info, Path("ffprobe"), ydl)
        self.assertEqual(policy.dynamic_range, "SDR")
        self.assertTrue(policy.has_audio)
        self.assertEqual(probe.call_args.args[1], video["url"])

    @unittest.skipUnless(REAL_YT_DLP_AVAILABLE, "requires real yt-dlp header preparation")
    def test_probe_includes_yt_dlp_default_headers_missing_from_extraction_metadata(self):
        info = {"url": "https://source.test/video", "vcodec": "av1", "acodec": "none"}
        data = {"streams": [{"codec_type": "video", "width": 320, "height": 180,
                             "avg_frame_rate": "60", "color_transfer": "bt709"}]}
        with downloader.YoutubeDL({"quiet": True, "http_headers": {"User-Agent": "regression-test-agent"}}) as ydl, \
                patch.object(downloader, "probe_media", return_value=data) as probe:
            downloader.resolve_encoding_policy(info, Path("ffprobe"), ydl)
        self.assertEqual(probe.call_args.kwargs["headers"]["User-Agent"], "regression-test-agent")

    def test_conflicting_or_missing_metadata_is_probed_and_10bit_sdr_is_not_tonemapped(self):
        info = {"url": "local.mp4", "width": 320, "height": 180, "fps": 30, "vcodec": "h264", "acodec": "aac",
                "dynamic_range": "SDR", "color_transfer": "arib-std-b67"}
        data = {"streams": [{"codec_type": "video", "width": 320, "height": 180, "avg_frame_rate": "30000/1001",
                             "pix_fmt": "yuv420p10le", "color_transfer": "bt709", "color_primaries": "bt2020"}]}
        for dynamic in ("SDR", None):
            with self.subTest(dynamic=dynamic), patch.object(downloader, "probe_media", return_value=data) as probe:
                policy = downloader.resolve_encoding_policy({**info, "dynamic_range": dynamic}, Path("ffprobe"), None)
                self.assertFalse(policy.hdr)
                self.assertAlmostEqual(policy.fps, 29.97003, places=4)
                probe.assert_called_once()

    def test_unknown_transfer_is_not_guessed_from_bit_depth(self):
        data = {"streams": [{"codec_type": "video", "width": 320, "height": 180, "avg_frame_rate": "30",
                             "pix_fmt": "yuv420p10le"}]}
        with patch.object(downloader, "probe_media", return_value=data), self.assertRaises(downloader.EncodingError):
            downloader.resolve_encoding_policy({"url": "local.mp4"}, Path("ffprobe"), None)

    def test_blocked_direct_probe_uses_bounded_lossless_sample_and_cleans_up(self):
        data = {"streams": [{"codec_type": "video", "color_transfer": "arib-std-b67"}]}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(downloader, "probe_media", side_effect=[RuntimeError("403 Forbidden"), data]) as probe, \
                patch.object(downloader, "copy_source_sample") as sample:
            actual = downloader.probe_selected_source({"url": "https://source.test/v"}, Path("ffprobe"), {}, "",
                                                      ffmpeg_executable=Path("ffmpeg"), cache_directory=Path(directory), start=887,
                                                      ydl=unittest.mock.Mock())
            self.assertEqual(actual, data)
            self.assertEqual(sample.call_args.args[2], 887)
            self.assertTrue(probe.call_args.kwargs["local"])
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_sample_failure_restores_the_active_session_options(self):
        ydl = unittest.mock.Mock()
        ydl.params = {"outtmpl": {"default": "clip.%(ext)s"}, "download_ranges": lambda *_: [],
                      "force_keyframes_at_cuts": True, "external_downloader_args": {"ffmpeg_o": ["-c:v", "libx264"]}}
        original = dict(ydl.params)
        ydl.process_ie_result.side_effect = RuntimeError("connection reset")
        with self.assertRaisesRegex(RuntimeError, "connection reset"):
            downloader.copy_source_sample(ydl, {"url": "https://source.test/v"}, 887, Path("sample.mkv"))
        for key, value in original.items():
            self.assertIs(ydl.params[key], value)

    def test_remote_probe_preserves_headers_and_network_error_category_without_leaking_query(self):
        failure = subprocess.CompletedProcess([], 1, "", "Server returned 403 Forbidden https://media.test/v?secret=token")
        with patch.object(downloader, "media_command", return_value=failure) as command:
            with self.assertRaises(RuntimeError) as caught:
                downloader.probe_media(Path("ffprobe"), "https://media.test/v?secret=token", headers={"Referer": "https://site.test/"})
        self.assertNotIsInstance(caught.exception, downloader.EncodingError)
        self.assertEqual(downloader.classify_error(str(caught.exception)), downloader.ERROR_FORBIDDEN)
        self.assertNotIn("token", str(caught.exception))
        self.assertIn("Referer: https://site.test/\r\n", command.call_args.args[0])

    def test_capability_check_is_cached_and_missing_filters_fail_clearly(self):
        downloader.check_encoding_tools.cache_clear()
        def result(args, **_kwargs):
            names = " V libx264\n A aac" if "-encoders" in args else " T zscale\n T tonemap\n T sidedata"
            return subprocess.CompletedProcess(args, 0, names, "")
        try:
            with patch.object(downloader, "find_ffprobe_exe", return_value=Path("ffprobe")), \
                    patch.object(downloader, "media_command", side_effect=result) as command:
                for _ in range(2):
                    downloader.check_encoding_tools(Path("ffmpeg"))
                self.assertEqual(command.call_count, 3)
            downloader.check_encoding_tools.cache_clear()
            with patch.object(downloader, "find_ffprobe_exe", return_value=Path("ffprobe")), \
                    patch.object(downloader, "media_command", return_value=subprocess.CompletedProcess([], 0, "", "")), \
                    self.assertRaisesRegex(downloader.EncodingError, "libx264"):
                downloader.check_encoding_tools(Path("ffmpeg"))
        finally:
            downloader.check_encoding_tools.cache_clear()


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def copyfile(self, source, outputfile):
        try:
            super().copyfile(source, outputfile)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # A bounded probe or cut can finish before the HTTP response does.
            pass


@unittest.skipUnless(REAL_YT_DLP_AVAILABLE and downloader.find_ffmpeg_exe(), "requires pinned yt-dlp and full FFmpeg")
class RangeEncodingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="downloader-encoding-")
        cls.base = Path(cls.directory.name)
        cls.ffmpeg = downloader.find_ffmpeg_exe()
        cls.ffprobe = downloader.check_encoding_tools(cls.ffmpeg)
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(cls.base)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_port}"
        for kind, transfer, pixel_format in (("hlg", "arib-std-b67", "yuv420p10le"),
                                             ("pq", "smpte2084", "yuv420p10le"),
                                             ("sdr10", "bt709", "yuv420p10le"),
                                             ("sdr", "bt709", "yuv420p")):
            hdr = kind in ("hlg", "pq")
            # Convert an SDR test pattern into HDR before encoding; don't just relabel it.
            graph = (f"zscale=transferin=bt709:primariesin=bt709:matrixin=bt709:rangein=limited:"
                     f"transfer={transfer}:primaries={'bt2020' if hdr else 'bt709'}:"
                     f"matrix={'bt2020nc' if hdr else 'bt709'}:range=limited,format={pixel_format}")
            cls.run_ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=60:duration=7",
                            "-f", "lavfi", "-i", "sine=frequency=440:duration=7", "-vf", graph,
                            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-c:a", "aac",
                            "-color_trc", transfer, "-color_primaries", "bt2020" if hdr else "bt709",
                            "-colorspace", "bt2020nc" if hdr else "bt709", "-movflags", "+faststart", str(cls.base / f"{kind}.mp4")])
        cls.run_ffmpeg(["-i", str(cls.base / "sdr.mp4"), "-c:v", "libvpx-vp9", "-deadline", "realtime",
                        "-cpu-used", "8", "-c:a", "libopus", str(cls.base / "combined.webm")])
        cls.run_ffmpeg(["-i", str(cls.base / "hlg.mp4"), "-map", "0:v:0", "-c", "copy", "-movflags", "+faststart", str(cls.base / "video.mp4")])
        cls.run_ffmpeg(["-i", str(cls.base / "hlg.mp4"), "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart", str(cls.base / "audio.m4a")])

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.directory.cleanup()

    @classmethod
    def run_ffmpeg(cls, args):
        result = downloader.media_command([str(cls.ffmpeg), "-hide_banner", "-loglevel", "error", "-y", *args], timeout=90)
        if result.returncode:
            raise AssertionError(result.stderr)

    def download(self, kind, dynamic=None, separate=False):
        source = "video.mp4" if separate else f"{kind}.mp4" if kind != "combined" else "combined.webm"
        metadata = {"id": kind, "title": kind, "extractor": "test", "duration": 7,
                    "width": 320, "height": 180, "fps": 60, "dynamic_range": dynamic,
                    "formats": [{"format_id": "video", "url": f"{self.origin}/{source}", "ext": Path(source).suffix[1:],
                                 "vcodec": "vp9" if kind == "combined" else "h264", "acodec": "none" if separate else "aac",
                                 "width": 320, "height": 180, "fps": 60, "dynamic_range": dynamic}]}
        if separate:
            metadata["formats"].append({"format_id": "audio", "url": f"{self.origin}/audio.m4a", "ext": "m4a",
                                        "vcodec": "none", "acodec": "aac"})
        logs = []
        session = downloader.VideoDownloadSession("https://example.test/fixture", downloader.profiles_for_resolution(2160)[0],
                                                  self.ffmpeg, self.base / "cache", 0, None, logs.append)
        try:
            session.ydl.extract_info = lambda *_args, **_kwargs: session.ydl.process_ie_result(copy.deepcopy(metadata), download=False)
            with patch.object(downloader, "resolve_encoding_policy", wraps=downloader.resolve_encoding_policy) as resolve:
                for index in range(2):
                    template = str(self.base / f"output-{kind}-{separate}-{index}.%(ext)s")
                    session.download(index, index + 5, template)
                    self.run_ffmpeg(["-i", template.replace("%(ext)s", "mp4"), "-f", "null", "-"])
                self.assertEqual(resolve.call_count, 1)
            return session.encoding_policy, logs
        finally:
            session.close()

    def test_strict_pipeline_rejects_real_below_minimum_source(self):
        outcome = downloader.download_clip(self.origin + '/sdr.mp4', 0, 5,
            str(self.base / 'strict-low.%(ext)s'), self.ffmpeg, self.base / 'strict-cache', None, 0, {},
            profiles=downloader.DOWNLOAD_PROFILES[:1], log_callback=lambda _: None, sleep_func=lambda _: None)
        self.assertEqual(outcome.status, 'QUALITY_UNAVAILABLE', outcome)
        self.assertFalse((self.base / 'strict-low.mp4').exists())

    def test_strict_pipeline_downloads_real_hd_and_verified_reuse(self):
        self.run_ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:size=1920x1080:rate=30:duration=7',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7', '-c:v', 'libx264', '-preset', 'ultrafast',
            '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', str(self.base / 'hd.mp4')])
        template = str(self.base / 'strict-hd.%(ext)s')
        for reused in (False, True):
            outcome = downloader.download_clip(self.origin + '/hd.mp4', 0, 5, template,
                self.ffmpeg, self.base / 'strict-cache', None, 0, {}, profiles=downloader.DOWNLOAD_PROFILES[:1],
                log_callback=lambda _: None, sleep_func=lambda _: None)
            self.assertTrue(outcome.ok, outcome)
            self.assertEqual(outcome.record['reused'], reused)
            self.assertEqual(outcome.record['outputDimensions'], [1920, 1080])

    def test_strict_pipeline_retains_hdr_sources_and_tone_maps_them(self):
        for name in ('hlg', 'pq'):
            outcome = downloader.download_clip(self.origin + f'/{name}.mp4', 0, 5,
                str(self.base / f'strict-hdr-{name}.%(ext)s'), self.ffmpeg, self.base / 'strict-cache', None, 0, {},
                quality_policy=downloader.QualityPolicy(144, 360), profiles=downloader.DOWNLOAD_PROFILES[:1],
                log_callback=lambda _: None, sleep_func=lambda _: None)
            self.assertTrue(outcome.ok, outcome)
            self.assertEqual(outcome.record['outputPixelFormat'], 'yuv420p')
            self.assertEqual(outcome.record['outputFps'], 60)
            self.assertIn(outcome.record['encoding']['dynamic_range'], ('HLG', 'PQ'))

    def test_strict_rotated_source_preserves_display_dimensions(self):
        self.run_ffmpeg(['-display_rotation:v:0', '90', '-i', str(self.base / 'sdr.mp4'), '-c', 'copy', '-movflags', '+faststart',
                         str(self.base / 'rotated.mp4')])
        outcome = downloader.download_clip(self.origin + '/rotated.mp4', 0, 5,
            str(self.base / 'strict-rotated.%(ext)s'), self.ffmpeg, self.base / 'strict-cache', None, 0, {},
            quality_policy=downloader.QualityPolicy(144, 360), profiles=downloader.DOWNLOAD_PROFILES[:1],
            log_callback=lambda _: None, sleep_func=lambda _: None)
        self.assertTrue(outcome.ok, outcome)
        self.assertEqual(outcome.record['outputDimensions'], [180, 320])

    def test_hlg_and_pq_combined_sources_preserve_60fps_and_convert_sdr(self):
        for kind, dynamic in (("hlg", "HLG"), ("pq", "HDR10")):
            with self.subTest(kind=kind):
                policy, logs = self.download(kind, dynamic)
                self.assertTrue(policy.hdr)
                self.assertEqual(policy.fps, 60)
                self.assertTrue(any("tone mapped" in log for log in logs))

    def test_unknown_metadata_and_10bit_sdr_sources(self):
        for kind, hdr in (("hlg", True), ("sdr10", False), ("sdr", False)):
            with self.subTest(kind=kind):
                policy, _ = self.download(kind)
                self.assertEqual(policy.hdr, hdr)

    def test_combined_webm_is_finalized_as_mp4(self):
        self.download("combined", "SDR")
        self.assertFalse(list(self.base.glob("output-combined*.webm")))

    def test_separate_hdr_video_and_audio(self):
        policy, _ = self.download("hlg", "HLG", separate=True)
        self.assertTrue(policy.has_audio)
        self.assertTrue(policy.hdr)

    def test_blocked_direct_probe_fallback_preserves_hdr_and_60fps(self):
        original = downloader.probe_media
        def blocked(ffprobe, source, **kwargs):
            if source.startswith("http://"):
                raise RuntimeError("403 Forbidden")
            return original(ffprobe, source, **kwargs)
        with patch.object(downloader, "probe_media", side_effect=blocked):
            policy, _ = self.download("hlg", "HDR10", separate=True)
        self.assertEqual(policy.dynamic_range, "HLG")
        self.assertEqual(policy.fps, 60)

    def test_validator_rejects_the_original_unconverted_hdr_encoding(self):
        policy = downloader.EncodingPolicy(320, 180, 60, "HLG", True)
        with self.assertRaisesRegex(downloader.EncodingError, "8-bit"):
            downloader.validate_output(self.base / "hlg.mp4", policy, 7, self.ffprobe)

    def test_clip_near_end_is_validated_against_remaining_duration(self):
        info = {"id": "tail", "title": "tail", "extractor": "test", "duration": 7,
                "url": f"{self.origin}/sdr.mp4", "ext": "mp4", "vcodec": "h264", "acodec": "aac",
                "width": 320, "height": 180, "fps": 60, "dynamic_range": "SDR"}
        session = downloader.VideoDownloadSession("https://example.test/tail", downloader.profiles_for_resolution(2160)[0],
                                                  self.ffmpeg, self.base / "cache", 0, None, lambda _: None)
        try:
            session.ydl.extract_info = lambda *_a, **_kw: session.ydl.process_ie_result(copy.deepcopy(info), download=False)
            session.download(6, 11, str(self.base / "tail.%(ext)s"))
        finally:
            session.close()


if __name__ == "__main__":
    unittest.main()

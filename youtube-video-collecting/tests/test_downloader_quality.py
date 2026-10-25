import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from test_5_sec_downloader import downloader as d
from downloader_quality import QualityPolicy, QualityUnavailable, VideoQualityState, candidates, format_selector, source_identity
from downloader_output import OutputTransaction, OutputConflict, RunLock, atomic_json
from downloader_control import OperationControl, DownloadCanceled, run_media


def video(edge=1080, fps=30, combined=True, **extra):
    return {'format_id': str(edge), 'width': edge * 16 // 9, 'height': edge, 'fps': fps,
            'vcodec': 'avc1', 'acodec': 'aac' if combined else 'none', 'protocol': 'https',
            'url': 'https://media.invalid/source', **extra}


class ControlledSession:
    inventories = {}
    failures = {}
    calls = []
    def __init__(self, url, profile, *_):
        self.url, self.profile = url, profile
        self.inventory_info = None
        self.info = {'duration': 100}
    def discover(self, policy):
        self.inventory_info = {'formats': self.inventories.get(self.profile.name, [])}
        return candidates(self.inventory_info['formats'], policy)
    def select(self, candidate, start):
        self.encoding_policy = d.EncodingPolicy(candidate['width'], candidate['height'], candidate['fps'], 'SDR', True)
        return self.encoding_policy
    def download(self, start, end, output):
        self.calls.append((self.profile.name, start, self.encoding_policy.height))
        failure = self.failures.get((self.profile.name, start))
        if failure:
            raise failure
        Path(output.replace('%(ext)s', 'mp4')).write_bytes(b'controlled media bytes')
    def source_record(self):
        from dataclasses import asdict
        return {'encoding': asdict(self.encoding_policy), 'profile': self.profile.name}
    def close(self):
        pass


class QualityTests(unittest.TestCase):
    def setUp(self):
        ControlledSession.inventories = {'standard': [video()], 'safari-hls': [video()], 'embedded': []}
        ControlledSession.failures = {}
        ControlledSession.calls = []
        self.directory = tempfile.TemporaryDirectory()
        self.base = Path(self.directory.name)
        self.addCleanup(self.directory.cleanup)

    def run_clip(self, start=0, sessions=None, state=None, policy=None, **kwargs):
        return d.download_clip('https://www.youtube.com/watch?v=test', start, 5,
            str(self.base / f'{start}.%(ext)s'), Path('ffmpeg'), self.base, None, 0,
            sessions if sessions is not None else {}, session_factory=ControlledSession,
            log_callback=lambda _: None, sleep_func=lambda _: None,
            quality_state=state, quality_policy=policy or QualityPolicy(), **kwargs)

    def test_combined_hd_beats_separate_low_and_requires_real_audio(self):
        low = video(360, combined=False)
        audio = {'format_id': 'a', 'vcodec': 'none', 'acodec': 'aac', 'url': 'https://media.invalid/a'}
        ranked = candidates([low, video(), audio], QualityPolicy(144, 1080))
        self.assertEqual(ranked[0]['height'], 1080)
        self.assertEqual(candidates([video(combined=False)], QualityPolicy()), [])

    def test_portrait_unknown_above_cap_and_minimum(self):
        p = QualityPolicy()
        ranked = candidates([video(width=1080, height=1920), video(720), video(2160)], p)
        self.assertEqual([(f['width'], f['height']) for f in ranked], [(1080, 1920)])
        for width, height in ((256, 144), (1920, 800), (0, 1080), (3840, 2160)):
            with self.assertRaises(QualityUnavailable): p.check(width, height)
        with self.assertRaises(ValueError): QualityPolicy(1080, 720)

    def test_inventory_compares_profiles_before_acceptance(self):
        ControlledSession.inventories['standard'] = [video(360)]
        result = self.run_clip()
        self.assertTrue(result.ok, result)
        self.assertEqual(ControlledSession.calls, [('safari-hls', 0, 1080)])

    def test_hd_then_403_cannot_switch_to_cached_low_profile(self):
        ControlledSession.inventories['safari-hls'] = [video(360)]
        sessions, state = {}, VideoQualityState()
        self.assertTrue(self.run_clip(0, sessions, state).ok)
        ControlledSession.failures[('standard', 10)] = RuntimeError('HTTP Error 403: Forbidden')
        failed = self.run_clip(10, sessions, state)
        self.assertFalse(failed.ok)
        self.assertEqual(failed.status, 'FORBIDDEN')
        self.assertFalse((self.base / '10.mp4').exists())
        self.assertTrue(self.run_clip(20, sessions, state).ok)
        self.assertTrue(all(edge == 1080 for _, _, edge in ControlledSession.calls))

    def test_equivalent_hd_fallback_recovers_after_bounded_refresh(self):
        ControlledSession.failures[('standard', 0)] = RuntimeError('HTTP Error 403: Forbidden')
        result = self.run_clip()
        self.assertTrue(result.ok, result)
        self.assertEqual(ControlledSession.calls, [('standard', 0, 1080), ('standard', 0, 1080), ('safari-hls', 0, 1080)])

    def test_locked_4k_and_fps_survive_new_sessions_and_lower_inventory(self):
        policy = QualityPolicy(1080, 2160)
        ControlledSession.inventories = {'standard': [video(2160, fps=60)]}
        state = VideoQualityState()
        self.assertTrue(self.run_clip(0, state=state, policy=policy).ok)
        ControlledSession.inventories = {'standard': [video(1080, fps=30)]}
        result = self.run_clip(10, state=state, policy=policy)
        self.assertEqual(result.status, 'QUALITY_UNAVAILABLE')
        self.assertEqual(state.target, (2160, 60))
        with self.assertRaises(QualityUnavailable): policy.check(3840, 2160, 30, state.target)

    def test_no_minimum_source_and_rate_limit_are_distinct(self):
        ControlledSession.inventories = {'standard': [video(144)]}
        self.assertEqual(self.run_clip().status, 'QUALITY_UNAVAILABLE')
        ControlledSession.inventories = {'standard': [video()]}
        ControlledSession.failures[('standard', 10)] = RuntimeError('HTTP Error 429: Too many requests')
        self.assertEqual(self.run_clip(10).status, 'RATE_LIMIT')
        self.assertEqual(len(ControlledSession.calls), 1)

    def test_output_validation_failure_does_not_try_another_rendition(self):
        ControlledSession.failures[('standard', 0)] = d.EncodingError('Output validation failed')
        result = self.run_clip()
        self.assertEqual(result.status, 'VALIDATION_FAILED')
        self.assertEqual(len(ControlledSession.calls), 1)

    def test_existing_conflict_matching_reuse_and_tampered_hash(self):
        (self.base / '0.mp4').write_bytes(b'old unrelated media')
        self.assertEqual(self.run_clip().status, 'OUTPUT_CONFLICT')
        self.assertEqual((self.base / '0.mp4').read_bytes(), b'old unrelated media')
        self.assertTrue(self.run_clip(replace_existing=True).ok)
        with patch.object(d, 'validate_output') as validate, patch.object(d, 'check_encoding_tools', return_value=Path('ffprobe')):
            reused = self.run_clip()
            self.assertTrue(reused.ok)
            self.assertTrue(reused.record['reused'])
            validate.assert_called_once()
        (self.base / '0.mp4').write_bytes(b'tampered')
        self.assertEqual(self.run_clip().status, 'OUTPUT_CONFLICT')

    def test_pending_transaction_never_reuses_and_cleanup_preserves_old_files(self):
        dest = self.base / 'clip.mp4'
        dest.write_bytes(b'completed old file')
        atomic_json(dest.with_suffix('.quality.json'), {'state': 'pending'})
        with self.assertRaises(OutputConflict): OutputTransaction(dest, {}).existing()
        d.cleanup_partial_outputs(str(self.base / 'clip.%(ext)s'))
        self.assertTrue(dest.exists())
        with RunLock(self.base, 'one'):
            with self.assertRaises(OutputConflict):
                with RunLock(self.base, 'two'): pass

    def test_canonical_video_identity_and_secret_redaction(self):
        urls = ['https://youtu.be/abcdefghijk?t=10', 'https://youtube.com/shorts/abcdefghijk', 'https://youtube.com/embed/abcdefghijk', 'https://youtube.com/watch?v=abcdefghijk&list=secret']
        self.assertEqual(len({source_identity(url) for url in urls}), 1)
        clean = d.sanitize_diagnostic('Authorization: Bearer secret\nCookie: SID=password\nhttps://media.test/v?signature=secret')
        self.assertNotIn('secret', clean)
        self.assertNotIn('password', clean)
        self.assertNotIn('secret', d.sanitize_diagnostic(json.dumps({'headers': {'Cookie': 'SID=secret', 'Authorization': 'Bearer secret'}, 'po_token': 'secret'})))

    def test_deadline_and_cancel_terminate_real_children(self):
        for stopped, seconds, expected in ((lambda: False, 0.3, TimeoutError), (lambda: True, 10, DownloadCanceled)):
            before = time.monotonic()
            with self.assertRaises(expected):
                with OperationControl(stopped, seconds):
                    run_media([sys.executable, '-c', 'import time; time.sleep(20)'], timeout=30)
            self.assertLess(time.monotonic() - before, 3)

    def test_cache_cannot_cross_source_identity_or_quality_policy(self):
        sessions = {}
        self.assertTrue(self.run_clip(0, sessions=sessions).ok)
        ControlledSession.inventories = {'standard': [video(2160)]}
        self.assertTrue(self.run_clip(10, sessions=sessions, policy=QualityPolicy(2160, 2160)).ok)
        ControlledSession.inventories = {'standard': [video(360)]}
        other = d.download_clip('https://www.youtube.com/watch?v=other', 20, 5,
            str(self.base / 'other.%(ext)s'), Path('ffmpeg'), self.base, None, 0, sessions,
            session_factory=ControlledSession, log_callback=lambda _: None, sleep_func=lambda _: None)
        self.assertEqual(other.status, 'QUALITY_UNAVAILABLE')
        self.assertFalse((self.base / 'other.mp4').exists())

    def test_processing_preserves_target_across_repeated_pairs_and_rows(self):
        class ChangingSession(ControlledSession):
            def select(self, candidate, start):
                encoding = super().select(candidate, start)
                if start >= 10:
                    self.encoding_policy = d.EncodingPolicy(1920, 1080, 30, 'SDR', True)
                return self.encoding_policy
        ChangingSession.inventories = {'standard': [video(fps=60)]}
        csv = self.base / 'repeated.csv'
        url = 'https://www.youtube.com/watch?v=test'
        csv.write_text(f'{url},0.00,{url},0.10\n{url},0.20\n', encoding='utf-8')
        with patch.object(d, 'app_data_directory', return_value=self.base / 'cache'):
            summary = d.process_clips(str(csv), str(self.base / 'output'), Path('ffmpeg'), None,
                0, 0, 0, 0, session_factory=ChangingSession, log_callback=lambda _: None, sleep_func=lambda _: None)
        self.assertEqual((summary.succeeded, summary.count('QUALITY_UNAVAILABLE')), (1, 2))
        self.assertEqual(summary.processed, 3)
        self.assertFalse((self.base / 'output/.downloader.lock').exists())
        records = [json.loads(line) for line in next((self.base / 'output').glob('run-*.jsonl')).read_text(encoding='utf-8').splitlines()]
        self.assertEqual([r['status'] for r in records], ['OK', 'QUALITY_UNAVAILABLE', 'QUALITY_UNAVAILABLE'])
        self.assertEqual(len({r['clipId'] for r in records}), 3)
        self.assertTrue(all(r['url'] == url for r in records), 'Canonical video ID must survive diagnostic redaction for retry export')

    def test_all_named_maximums_reach_processing_without_legacy_validation_conflict(self):
        csv = self.base / 'empty.csv'
        csv.write_text('', encoding='utf-8')
        for maximum in (144, 240, 360, 480, 720, 1080, 1440, 2160):
            args = d.parse_arguments([str(csv), str(self.base / str(maximum)), '--max-quality', str(maximum)])
            with patch.object(d, 'app_data_directory', return_value=self.base / 'cache'):
                summary = d.process_clips(str(csv), str(self.base / str(maximum)), Path('ffmpeg'), None,
                    0, 0, 0, 0, max_height=args.max_height, quality_policy=args.quality_policy, log_callback=lambda _: None)
            self.assertEqual(summary.exit_code(), 0)

    def test_cli_and_capability_contract(self):
        self.assertEqual(d.parse_arguments(['a.csv', 'out']).quality_policy, QualityPolicy())
        self.assertEqual(d.parse_arguments(['a.csv', 'out', '--resolution', '720']).quality_policy, QualityPolicy(720, 720))
        self.assertEqual(d.parse_arguments(['a.csv', 'out', '--resolution', 'auto']).quality_policy, QualityPolicy(1080, None))
        self.assertEqual(d.capabilities()['schemaVersion'], 2)


if __name__ == '__main__': unittest.main()

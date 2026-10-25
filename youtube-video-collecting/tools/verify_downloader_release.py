"""Exercise the built Windows executable with real local media and persisted reports.

Usage: python tools/verify_downloader_release.py path/to/5_sec_downloader.exe output-directory
Requires FFmpeg/FFprobe and a supported JS runtime; no external network is used.
"""
import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def copyfile(self, source, outputfile):
        try:
            super().copyfile(source, outputfile)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('executable', type=Path)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    executable, base = args.executable.resolve(), args.directory.resolve()
    base.mkdir(parents=True, exist_ok=True)
    media = base / 'sources'
    media.mkdir(exist_ok=True)
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise RuntimeError('FFmpeg is required')
    for name, size in [('hd', '1920x1080'), ('low', '256x144'), ('portrait', '1080x1920')]:
        subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
            f'color=c=blue:size={size}:rate=30:duration=7', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart',
            str(media / f'{name}.mp4')], check=True, timeout=30)
    env = {**os.environ, 'LOCALAPPDATA': str(base / 'app-data'), 'YVC_DISABLE_RUNTIME_DOWNLOAD': '1'}
    capabilities = json.loads(subprocess.check_output([str(executable), '--capabilities-json'], env=env, text=True, timeout=20))
    assert capabilities['schemaVersion'] == 2 and capabilities['ejs'], capabilities
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(media)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f'http://127.0.0.1:{server.server_port}'
    def run(label, sources, output):
        csv = base / f'{label}.csv'
        csv.write_text(''.join(f'{origin}/{source}.mp4,0.00\n' for source in sources), encoding='utf-8')
        output.mkdir(exist_ok=True)
        result = subprocess.run([str(executable), str(csv), str(output), '0', '0', '0', '0',
            '--min-quality', '1080', '--max-quality', '1080'], env=env, capture_output=True,
            text=True, encoding='utf-8', errors='replace', timeout=240)
        (base / f'{label}.stdout.txt').write_text(result.stdout, encoding='utf-8')
        (base / f'{label}.stderr.txt').write_text(result.stderr, encoding='utf-8')
        records = [json.loads(line.split('CLIP_RESULT: ', 1)[1]) for line in result.stdout.splitlines() if 'CLIP_RESULT: ' in line]
        summaries = [json.loads(line.split('DOWNLOAD_SUMMARY: ', 1)[1]) for line in result.stdout.splitlines() if 'DOWNLOAD_SUMMARY: ' in line]
        assert len(summaries) == 1, result.stdout[-3000:]
        return result.returncode, records, summaries[0]
    try:
        output = base / 'mixed-output'
        code, records, summary = run('mixed', ['hd', 'low', 'portrait'], output)
        assert code == 2 and [r['status'] for r in records] == ['OK', 'QUALITY_UNAVAILABLE', 'OK'], records
        assert summary['succeeded'] == 2 and summary['qualityUnavailable'] == 1, summary
        assert records[0]['outputDimensions'] == [1920, 1080] and records[2]['outputDimensions'] == [1080, 1920]
        assert not (output / '2/2.1.1.mp4').exists()
        code, records, summary = run('reuse', ['hd', 'low', 'portrait'], output)
        assert code == 2 and all(r.get('reused') for r in records if r['status'] == 'OK'), records
        original = (output / '1/1.1.1.mp4').read_bytes()
        code, records, _ = run('conflict', ['portrait'], output)
        assert code == 2 and records[0]['status'] == 'OUTPUT_CONFLICT', records
        assert (output / '1/1.1.1.mp4').read_bytes() == original
        code, records, summary = run('success', ['hd'], base / 'success-output')
        assert code == 0 and summary['succeeded'] == 1 and records[0]['state'] == 'committed', records
        print(json.dumps({'status': 'passed', 'cases': ['HD delivery', 'real below-minimum rejection', 'portrait HD',
              'verified reuse', 'stale-source conflict', 'clean success summary'], 'build': capabilities}, indent=2))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    main()

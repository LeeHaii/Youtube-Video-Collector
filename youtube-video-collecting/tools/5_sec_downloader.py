import random
import sys
import threading
import subprocess
import os
import shutil
from pathlib import Path
import time
import io

# Force UTF-8 encoding for stdout (fixes emoji printing on Windows)
if sys.stdout.encoding != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
if sys.stderr.encoding != 'utf-8':
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# Determine project root that works when running normally or when bundled by PyInstaller
if getattr(sys, "frozen", False):
    # When frozen by PyInstaller, resources are available in sys._MEIPASS
    ROOT = Path(getattr(sys, "_MEIPASS", "."))
else:
    ROOT = Path(__file__).parent.parent

CLIP_DURATION = 5.0  # seconds

from urllib.parse import urlparse, parse_qs
import csv

def ffmpeg_available() -> bool:
    """Return True if ffmpeg is available on PATH or bundled with the exe."""
    # check bundled location first
    if getattr(sys, "frozen", False):
        bundled = Path(getattr(sys, "_MEIPASS", ".")) / "ffmpeg" / "bin" / "ffmpeg.exe"
        if bundled.exists():
            return True
    return shutil.which("ffmpeg") is not None


def clean_youtube_url(url: str) -> str:
    try:
        parsed = urlparse(url)
        params = parse_qs(parsed.query)
        if "v" in params:
            video_id = params["v"][0]
            return f"https://www.youtube.com/watch?v={video_id}"
    except:
        pass
    return url


from yt_dlp import YoutubeDL

def download_clip(
    url: str,
    start_time: float,
    duration: float,
    output_template: str,
    log_callback=print,
    stop_event=None,
) -> None:
    """
    Download a clip.
    """
    start = int(start_time)
    end = int(start_time + duration)

    ydl_opts = {
        "format": "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",

        "outtmpl": output_template,

        # 🔑 THIS is the critical part
        "download_ranges": lambda info_dict, ydl: [
            {"start_time": start, "end_time": end}
        ],

        "merge_output_format": "mp4",

        "postprocessor_args": [
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "192k",
        ],

        "quiet": True,
        "no_warnings": True,
        "no-cache-dir": True,
        "socket_timeout": 30,
        "sleep_requests": random.uniform(1.5, 3.0),
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        },
    }

    log_callback(f"    Downloading {start}-{end}s ... ")

    with YoutubeDL(ydl_opts) as ydl:
        ydl.cache.remove()
        ydl.download([url])

    log_callback("OK\n")



def parse_input_csv(csv_path: str):
    rows = []

    def convert_timestamp(ts: str) -> float:
        parts = ts.split(".")
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        elif len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        else:
            return float(ts)

    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        for row in reader:
            if not any(row):
                rows.append([])
                continue

            pairs = []
            for i in range(0, len(row), 2):
                if i + 1 >= len(row):
                    continue

                url = row[i].strip()
                ts_raw = row[i + 1].strip()

                if not url or not ts_raw:
                    continue

                # Clean URL to remove playlist parameters
                url = clean_youtube_url(url)

                timestamps = [
                    convert_timestamp(t.strip())
                    for t in ts_raw.split(";")
                    if t.strip()
                ]

                pairs.append((url, timestamps))

            rows.append(pairs)

    return rows


def process_clips(csv_path: str, output_base_dir: str, clip_sleep_min: float = 1.0, clip_sleep_max: float = 2.0, row_sleep_min: float = 10.0, row_sleep_max: float = 15.0, log_callback=print, stop_event=None) -> None:
    rows = parse_input_csv(csv_path)

    # Filter out empty rows and count only non-empty rows
    non_empty_rows = [(idx, pairs) for idx, pairs in enumerate(rows) if pairs]

    log_callback(f"Processing {len(non_empty_rows)} non-empty rows\n")
    log_callback(f"⏱️  Clip Sleep: {clip_sleep_min}-{clip_sleep_max}s | Row Sleep: {row_sleep_min}-{row_sleep_max}s\n\n")

    total_clips = sum(len(ts) for _, pairs in non_empty_rows for _, ts in pairs)
    clips_done = 0

    for output_row_num, (_, pairs) in enumerate(non_empty_rows, start=1):
        if stop_event and stop_event.is_set():
            log_callback("Processing canceled by user.\n")
            return

        log_callback(f"Row {output_row_num}:\n")
        row_start_time = time.perf_counter()
        clip_count = 1

        row_out = os.path.join(output_base_dir, str(output_row_num))
        os.makedirs(row_out, exist_ok=True)
        urlIndex = 0

        for url, timestamps in pairs:
            log_callback(f"  URL: {url} with {len(timestamps)} timestamp(s)\n")

            urlIndex += 1
            for ts in timestamps:
                if stop_event and stop_event.is_set():
                    log_callback("Processing canceled by user.\n")
                    return

                clips_done += 1
                # Save as x.y without extension (yt-dlp will add it)
                output_template = os.path.join(
                    row_out, f"{output_row_num}.{urlIndex}.{clip_count}"
                )

                log_callback(f"    [{clips_done}/{total_clips}] {int(ts)}s ")
                try:
                    download_clip(
                        url,
                        ts,
                        CLIP_DURATION,
                        output_template,
                        log_callback=log_callback,
                        stop_event=stop_event,
                    )
                    clip_count += 1
                    stampsleep = random.uniform(clip_sleep_min, clip_sleep_max)
                    log_callback(f"         Pausing before next clip in {stampsleep.__round__(2)}s\n")
                    time.sleep(stampsleep)  # brief pause between downloads
                except Exception as e:
                    log_callback(f"Error: {str(e)[:200]}\n")
            clip_count = 1
        row_end_time = time.perf_counter()
        row_duration = row_end_time - row_start_time
        log_callback(f"Row {output_row_num}: completed in {row_duration.__round__(2)}s\n")
        rowsleep = random.uniform(row_sleep_min, row_sleep_max)
        log_callback(f"         Pausing before next row in {rowsleep.__round__(2)}s\n\n")
        time.sleep(rowsleep)  # brief pause between rows


def find_ffmpeg_exe():
    """Find ffmpeg executable in common installation locations."""
    # If running as a PyInstaller bundle, prefer the bundled ffmpeg
    if getattr(sys, "frozen", False):
        meipass = Path(getattr(sys, "_MEIPASS", "."))
        bundled = meipass / "ffmpeg" / "bin" / "ffmpeg.exe"
        if bundled.exists():
            return bundled

    # Search common installation locations
    local_winget = Path(os.environ.get('LOCALAPPDATA', '')) / 'Microsoft' / 'WinGet' / 'Packages'
    candidates = [local_winget, Path(os.environ.get('LOCALAPPDATA', '')) / 'Programs' / 'Gyan', Path('C:/Program Files/Gyan')]
    for base in candidates:
        if base.exists():
            for p in base.rglob('ffmpeg.exe'):
                return p
    
    # Fallback to PATH lookup
    path = shutil.which('ffmpeg')
    if path:
        return Path(path)
    return None


def main():
    """CLI entry point for 5-Sec Downloader."""
    if len(sys.argv) < 3:
        print("Usage: python 5_sec_downloader.py <csv_path> <output_path> [clip_sleep_min] [clip_sleep_max] [row_sleep_min] [row_sleep_max]")
        print("Example: python 5_sec_downloader.py input.csv ./output 1 2 10 15")
        sys.exit(1)
    
    csv_path = sys.argv[1]
    output_path = sys.argv[2]
    
    # Parse optional sleep interval arguments with defaults
    clip_sleep_min = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
    clip_sleep_max = float(sys.argv[4]) if len(sys.argv) > 4 else 2.0
    row_sleep_min = float(sys.argv[5]) if len(sys.argv) > 5 else 10.0
    row_sleep_max = float(sys.argv[6]) if len(sys.argv) > 6 else 15.0
    
    # Validate inputs
    if not Path(csv_path).exists():
        print(f"ERROR: Input CSV file not found: {csv_path}")
        sys.exit(1)
    
    if not Path(output_path).exists():
        print(f"ERROR: Output folder does not exist: {output_path}")
        sys.exit(1)
    
    # Check for ffmpeg
    ff = find_ffmpeg_exe()
    if ff is None:
        print("ERROR: ffmpeg not found. Please install ffmpeg and add to PATH.")
        print("Install via winget: winget install --id Gyan.FFmpeg -e")
        sys.exit(1)
    
    # Ensure ffmpeg directory is on PATH for subprocesses
    os.environ['PATH'] = str(ff.parent) + os.pathsep + os.environ.get('PATH', '')
    
    try:
        print(f"🚀 Starting 5-Sec Download...")
        print(f"   CSV: {csv_path}")
        print(f"   Output: {output_path}")
        print(f"   Clip Sleep: {clip_sleep_min}-{clip_sleep_max}s")
        print(f"   Row Sleep: {row_sleep_min}-{row_sleep_max}s\n")
        
        process_clips(csv_path, output_path, clip_sleep_min, clip_sleep_max, row_sleep_min, row_sleep_max, log_callback=print)
        
        print("\n✅ Processing completed successfully!")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ ERROR: {str(e)}")
        sys.exit(1)


if __name__ == "__main__":
    main()

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

from urllib.parse import urlparse, parse_qs
from yt_dlp import YoutubeDL


def clean_youtube_url(url: str) -> str:
    """Clean YouTube URL to get just the video ID."""
    try:
        parsed = urlparse(url)
        params = parse_qs(parsed.query)
        if "v" in params:
            video_id = params["v"][0]
            return f"https://www.youtube.com/watch?v={video_id}"
    except:
        pass
    return url


def trim_youtube_video(
    url: str,
    start_time: float,
    end_time: float,
    output_path: str,
    log_callback=print,
) -> str:
    """
    Download and trim a YouTube video to a specific time range.
    
    Args:
        url: YouTube video URL
        start_time: Start time in seconds
        end_time: End time in seconds
        output_path: Directory to save the trimmed video
        log_callback: Function to call with log messages
    
    Returns:
        Path to the trimmed video file
    """
    start = int(start_time)
    end = int(end_time)

    # Generate output filename with timestamps
    timestamp = int(time.time())
    output_filename = f"trimmed_{start}-{end}_{timestamp}.mp4"
    output_file = os.path.join(output_path, output_filename)
    
    log_callback(f"🎬 Trimming video from {start}s to {end}s...")
    log_callback(f"📁 Output: {output_file}\n")

    ydl_opts = {
        "format": "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        "outtmpl": output_file.replace('.mp4', ''),
        
        # Critical: Only download the specified time range
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
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        },
    }

    try:
        log_callback("⏳ Downloading and processing video...")
        
        with YoutubeDL(ydl_opts) as ydl:
            ydl.cache.remove()
            info = ydl.extract_info(url, download=True)
            
        # The actual output filename (yt-dlp adds .mp4)
        if os.path.exists(output_file):
            actual_output = output_file
        else:
            # yt-dlp may have added the extension
            for ext in ['.mp4', '.mkv', '.webm']:
                test_path = output_file.replace('.mp4', '') + ext
                if os.path.exists(test_path):
                    actual_output = test_path
                    break
            else:
                actual_output = output_file

        log_callback(f"✅ Video trimmed successfully!")
        log_callback(f"OUTPUT_FILE:{actual_output}")
        
        return actual_output

    except Exception as e:
        log_callback(f"❌ Error during trimming: {str(e)[:200]}")
        raise


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
    """CLI entry point for YouTube Trimmer."""
    if len(sys.argv) < 5:
        print("Usage: python youtube_trimmer.py <url> <start_seconds> <end_seconds> <output_path>")
        print("Example: python youtube_trimmer.py 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' 10 30 ./output")
        sys.exit(1)
    
    url = sys.argv[1]
    output_path = sys.argv[4]
    
    try:
        start_seconds = float(sys.argv[2])
        end_seconds = float(sys.argv[3])
    except ValueError:
        print("ERROR: Start and end times must be numbers (in seconds)")
        sys.exit(1)
    
    # Validate inputs
    if not url.strip():
        print("ERROR: YouTube URL cannot be empty")
        sys.exit(1)
    
    if not Path(output_path).exists():
        print(f"ERROR: Output folder does not exist: {output_path}")
        sys.exit(1)
    
    if start_seconds >= end_seconds:
        print("ERROR: Start time must be less than end time")
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
        print(f"🎬 YouTube Trimmer Starting...")
        print(f"   URL: {url}")
        print(f"   Time Range: {start_seconds}s - {end_seconds}s")
        print(f"   Output: {output_path}\n")
        
        output_file = trim_youtube_video(
            clean_youtube_url(url),
            start_seconds,
            end_seconds,
            output_path,
            log_callback=print
        )
        
        print(f"\n✅ Trimming completed successfully!")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ ERROR: {str(e)}")
        sys.exit(1)


if __name__ == "__main__":
    main()

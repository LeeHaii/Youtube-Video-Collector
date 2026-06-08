import sys
import threading
import subprocess
import os
import shutil
import tempfile
from pathlib import Path
import time
import io
import traceback

# CRITICAL: Force PyInstaller to bundle websockets for YouTube SABR bypass!
try:
    import websockets
except ImportError:
    pass

# Force UTF-8 encoding for stdout/stderr
if sys.stdout.encoding != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
if sys.stderr.encoding != 'utf-8':
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

if getattr(sys, "frozen", False):
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


def make_netscape_cookie_file(cookie_str: str) -> str:
    """Converts a raw semicolon-separated Cookie string into a valid Netscape format file."""
    fd, temp_path = tempfile.mkstemp(suffix='.txt', prefix='yt_cookies_')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write("# Netscape HTTP Cookie File\n")
        f.write("# This file is generated automatically by Youtube Trimmer\n\n")
        
        pairs = cookie_str.split(';')
        for pair in pairs:
            if '=' in pair:
                try:
                    name, value = pair.strip().split('=', 1)
                    if not name or not value:
                        continue
                    f.write(f".youtube.com\tTRUE\t/\tTRUE\t0\t{name}\t{value}\n")
                except Exception:
                    continue
    return temp_path


def trim_youtube_video(
    url: str,
    start_time: float,
    end_time: float,
    output_path: str,
    cookie_header: str = '',
    log_callback=print,
) -> str:
    """Download and trim a YouTube video to a specific time range."""
    start = int(start_time)
    end = int(end_time)

    timestamp = int(time.time())
    output_filename = f"trimmed_{start}-{end}_{timestamp}.mp4"
    output_file = os.path.join(output_path, output_filename)
    temp_file = os.path.join(output_path, f"temp_{timestamp}.mp4")
    
    log_callback(f"🎬 Trimming video from {start}s to {end}s...")
    log_callback(f"📁 Output: {output_file}")
    
    # Check if our environment injection worked
    log_callback(f"⚙️ Node.js Injected Path: {os.environ.get('YT_NODE_PATH_LOG', 'NOT FOUND - JS Puzzles May Fail')}\n")

    format_fallbacks = [
        "best[height<=2160]", 
        "best[height<=1080]",  
        "best",
        "worst",
    ]

    http_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    }
    
    cookie_file_path = None
    if cookie_header and cookie_header.strip():
        try:
            cookie_file_path = make_netscape_cookie_file(cookie_header)
            log_callback(f"🔐 Successfully converted and loaded authentication cookies...")
        except Exception as e:
            log_callback(f"⚠️ Warning: Failed to parse cookies: {str(e)}")
            cookie_file_path = None
    else:
        log_callback(f"💭 No cookies provided, will attempt extraction from browser if available...")

    try:
        log_callback("⏳ Downloading video...")
        downloaded = False
        last_error = ""
        
        for fmt in format_fallbacks:
            try:
                log_callback(f"  Trying download format option: {fmt}...")
                
                node_exe = shutil.which("node") or os.path.join(os.environ.get('YT_NODE_PATH_LOG', ''), 'node.exe')
                
                ydl_opts = {
                    "format": fmt,
                    "outtmpl": temp_file.replace('.mp4', ''),
                    "merge_output_format": "mp4",
                    "quiet": False,
                    "no_warnings": False,
                    "no_cache_dir": True,
                    "socket_timeout": 30,
                    "http_headers": http_headers,
                    "external_downloader_args": {"ffmpeg": ["-loglevel", "panic"]},
                    
                    # FIX 1: Tell yt-dlp to download the required remote EJS solver scripts
                    "remote_components": ["ejs:github"], 
                    
                    "extractor_args": {
                        "youtube": {
                            # FIX 2: Swap the blocked 'tv' client out for 'android' or 'ios'
                            "player_client": ["android", "web"], 
                            "js_args": ["--node-binary", node_exe] 
                        }
                    }
                }
                
                if cookie_file_path:
                    ydl_opts["cookiefile"] = cookie_file_path
                else:
                    ydl_opts["cookiesfrombrowser"] = ("chrome", None, None, None)
                
                with YoutubeDL(ydl_opts) as ydl:
                    ydl.cache.remove()
                    ydl.extract_info(url, download=True)
                
                downloaded = True
                break
            except Exception as e:
                last_error = f"{repr(e)}\n{traceback.format_exc()}"
                continue
        
        if not downloaded:
            raise Exception(f"Could not download video with any format. Details:\n{last_error}")
        
        actual_temp = temp_file
        if not os.path.exists(actual_temp):
            for ext in ['.mp4', '.mkv', '.webm']:
                test_path = temp_file.replace('.mp4', '') + ext
                if os.path.exists(test_path):
                    actual_temp = test_path
                    break
        
        if not os.path.exists(actual_temp):
            raise Exception(f"Downloaded file not found")
        
        log_callback(f"✅ Downloaded successfully, trimming with ffmpeg...")
        
        ff = find_ffmpeg_exe()
        if ff is None:
            raise Exception("ffmpeg not found for trimming")
        
        cmd = [
            str(ff), "-i", actual_temp,
            "-ss", str(start), "-to", str(end),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-y", output_file
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            raise Exception(f"ffmpeg trim failed: {result.stderr[:200]}")
        
        if os.path.exists(actual_temp):
            try: os.remove(actual_temp)
            except: pass
        
        log_callback(f"✅ Video trimmed successfully!")
        log_callback(f"OUTPUT_FILE:{output_file}")
        return output_file

    except Exception as e:
        if cookie_file_path and os.path.exists(cookie_file_path):
            try: os.remove(cookie_file_path)
            except: pass
        if os.path.exists(temp_file):
            try: os.remove(temp_file)
            except: pass
        log_callback(f"❌ Error during trimming:\n{str(e)}")
        raise
    finally:
        if cookie_file_path and os.path.exists(cookie_file_path):
            try: os.remove(cookie_file_path)
            except: pass


def find_ffmpeg_exe():
    if getattr(sys, "frozen", False):
        meipass = Path(getattr(sys, "_MEIPASS", "."))
        bundled = meipass / "ffmpeg" / "bin" / "ffmpeg.exe"
        if bundled.exists(): return bundled

    local_winget = Path(os.environ.get('LOCALAPPDATA', '')) / 'Microsoft' / 'WinGet' / 'Packages'
    candidates = [local_winget, Path(os.environ.get('LOCALAPPDATA', '')) / 'Programs' / 'Gyan', Path('C:/Program Files/Gyan')]
    for base in candidates:
        if base.exists():
            for p in base.rglob('ffmpeg.exe'): return p
    
    path = shutil.which('ffmpeg')
    if path: return Path(path)
    return None


def find_node_exe():
    """Aggressively hunt for Node.js so yt-dlp can solve YouTube's n-signature puzzles natively."""
    path = shutil.which('node')
    if path: return Path(path).parent
    
    local_app_data = os.environ.get('LOCALAPPDATA', '')
    app_data = os.environ.get('APPDATA', '')
    
    candidates = [
        Path('C:/Program Files/nodejs'),
        Path('C:/Program Files (x86)/nodejs'),
    ]
    
    # Check both NVM locations just in case
    for base_dir in [app_data, local_app_data]:
        nvm_dir = Path(base_dir) / 'nvm'
        if nvm_dir.exists():
            for p in nvm_dir.glob('v*'):
                candidates.append(p)
                
    for base in candidates:
        if base.exists() and (base / 'node.exe').exists():
            return base
    return None


def main():
    if len(sys.argv) < 5:
        sys.exit(1)
    
    url = sys.argv[1]
    output_path = sys.argv[4]
    cookie_header = ''

    if '--cookie-header' in sys.argv:
        cookie_index = sys.argv.index('--cookie-header')
        if cookie_index + 1 < len(sys.argv):
            cookie_header = sys.argv[cookie_index + 1]

    try:
        start_seconds = float(sys.argv[2])
        end_seconds = float(sys.argv[3])
    except ValueError:
        sys.exit(1)
        
    ff = find_ffmpeg_exe()
    if ff is None:
        sys.exit(1)
        
    node_path = find_node_exe()
    
    # Inject both FFmpeg and Node.js directly into the executable's active environment PATH
    current_path = os.environ.get('PATH', '')
    new_path = str(ff.parent) + os.pathsep + current_path
    if node_path:
        new_path = str(node_path) + os.pathsep + new_path
        os.environ['YT_NODE_PATH_LOG'] = str(node_path) # Export variable solely so we can log it up top
        
    os.environ['PATH'] = new_path
    
    try:
        trim_youtube_video(
            clean_youtube_url(url), start_seconds, end_seconds, output_path,
            cookie_header=cookie_header, log_callback=print
        )
        sys.exit(0)
    except Exception as e:
        sys.exit(1)


if __name__ == "__main__":
    main()
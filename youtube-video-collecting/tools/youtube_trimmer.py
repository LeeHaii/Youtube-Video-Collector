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
    """Download a specific time range of a YouTube video directly from the server."""
    start = int(start_time)
    end = int(end_time)

    timestamp = int(time.time())
    output_filename = f"trimmed_{start}-{end}_{timestamp}.mp4"
    output_file = os.path.join(output_path, output_filename)
    
    # Grab the Node.js path injected by our hunting function
    node_env = os.environ.get('YT_NODE_PATH_LOG', '')
    node_exe_path = None
    if node_env:
        potential_node = Path(node_env) / "node.exe"
        if potential_node.exists():
            node_exe_path = str(potential_node)
            
    log_callback(f"🎬 Requesting targeted segment from {start}s to {end}s...")
    log_callback(f"📁 Target Output: {output_file}")
    log_callback(f"⚙️ Node.js Injected Path: {node_exe_path if node_exe_path else 'NOT FOUND - JS Puzzles May Fail'}\n")

    format_fallbacks = [
        "bestvideo[height<=2160]+bestaudio/best[height<=2160]", 
        "bestvideo[height<=1080]+bestaudio/best[height<=1080]",  
        "bestvideo+bestaudio/best",
        "worst",
    ]

    http_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
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
        log_callback("⏳ Connecting to stream chunks...")
        downloaded = False
        last_error = ""
        
        for fmt in format_fallbacks:
            try:
                log_callback(f"  Trying download format option: {fmt}...")
                
                ydl_opts = {
                    "format": fmt,
                    # Write directly to the final path, auto-handling extensions
                    "outtmpl": os.path.join(output_path, f"trimmed_{start}-{end}_{timestamp}.%(ext)s"),
                    "merge_output_format": "mp4",
                    "quiet": False,
                    "no_warnings": False,
                    "socket_timeout": 30,
                    "http_headers": http_headers,
                    
                    # == THIS IS THE FIX ==
                    # Forces yt-dlp to request only the necessary bytes
                    "download_ranges": lambda info, ydl, s=start, e=end: [{'start_time': s, 'end_time': e}],
                    "force_keyframes_at_cuts": True,
                    # =====================

                    "external_downloader_args": {"ffmpeg": ["-loglevel", "panic"]},

                    # ALLOW CACHING: yt-dlp must be able to cache the JS solver script
                    "no_cache_dir": False,
                    
                    # RUNTIME OVERRIDE: Explicitly force yt-dlp to use Node.js
                    "js_runtimes": {
                        "node": {
                            "path": node_exe_path
                        } if node_exe_path else {}
                    },

                    # REMOTE EJS: Authorize yt-dlp to download the newest challenge solvers
                    "remote_components": ["ejs:github", "ejs:npm"],

                    "extractor_args": {
                        "youtube": {
                            "player_client": ["default", "-android", "-android_sdkless", "-android_creator"],
                        }
                    }
                }
                
                if cookie_file_path:
                    ydl_opts["cookiefile"] = cookie_file_path
                else:
                    try:
                        ydl_opts["cookiesfrombrowser"] = ("chrome", None, None, None)
                    except Exception:
                        pass
                
                with YoutubeDL(ydl_opts) as ydl:
                    ydl.extract_info(url, download=True)
                
                downloaded = True
                break
            except Exception as e:
                last_error = f"{repr(e)}\n{traceback.format_exc()}"
                continue
        
        if not downloaded:
            raise Exception(f"Could not fetch segment with any format. Details:\n{last_error}")
        
        # Verify the file was created cleanly
        actual_output = output_file
        if not os.path.exists(actual_output):
            for ext in ['.mkv', '.webm']:
                test_path = output_file.replace('.mp4', ext)
                if os.path.exists(test_path):
                    actual_output = test_path
                    break
        
        if not os.path.exists(actual_output):
            raise Exception("Downloaded fragment target could not be verified on disk.")
        
        log_callback(f"✅ Video segment downloaded successfully!")
        log_callback(f"OUTPUT_FILE:{actual_output}")
        return actual_output

    except Exception as e:
        log_callback(f"❌ Error during segment extraction:\n{str(e)}")
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
    
    # If not found, dynamically download portable FFmpeg to LOCALAPPDATA
    local_app_data = os.environ.get('LOCALAPPDATA', '')
    if local_app_data:
        portable_ffmpeg_dir = Path(local_app_data) / 'YoutubeVideoCollector' / 'FFmpeg'
        existing_exe = next(portable_ffmpeg_dir.rglob('ffmpeg.exe'), None)
        if existing_exe:
            return existing_exe
            
        print("🎬 FFmpeg not found! Downloading portable FFmpeg (~30MB) (one-time setup)...")
        portable_ffmpeg_dir.mkdir(parents=True, exist_ok=True)
        import urllib.request
        import zipfile
        
        ffmpeg_url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
        zip_path = portable_ffmpeg_dir / "ffmpeg.zip"
        try:
            urllib.request.urlretrieve(ffmpeg_url, zip_path)
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(portable_ffmpeg_dir)
            
            extracted_exe = next(portable_ffmpeg_dir.rglob('ffmpeg.exe'), None)
            if extracted_exe:
                print("✅ Portable FFmpeg downloaded successfully!")
                return extracted_exe
        except Exception as e:
            print(f"❌ Failed to download portable FFmpeg: {e}")
        finally:
            if zip_path.exists():
                try: zip_path.unlink()
                except: pass
                
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
    
    for base_dir in [app_data, local_app_data]:
        nvm_dir = Path(base_dir) / 'nvm'
        if nvm_dir.exists():
            for p in nvm_dir.glob('v*'):
                candidates.append(p)
                
    for base in candidates:
        if base.exists() and (base / 'node.exe').exists():
            return base
            
    # If not found, dynamically download a portable node.exe to LOCALAPPDATA
    if local_app_data:
        portable_node_dir = Path(local_app_data) / 'YoutubeVideoCollector' / 'Node'
        portable_node_exe = portable_node_dir / 'node.exe'
        if portable_node_exe.exists():
            return portable_node_dir
            
        print("🌍 Node.js not found! Downloading portable Node.js (~60MB) for JS challenges (one-time setup)...")
        portable_node_dir.mkdir(parents=True, exist_ok=True)
        import urllib.request
        node_url = "https://nodejs.org/dist/v20.11.1/win-x64/node.exe"
        try:
            urllib.request.urlretrieve(node_url, portable_node_exe)
            print("✅ Portable Node.js downloaded successfully!")
            return portable_node_dir
        except Exception as e:
            print(f"❌ Failed to download portable Node.js: {e}")
            if portable_node_exe.exists():
                portable_node_exe.unlink()
                
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
        os.environ['YT_NODE_PATH_LOG'] = str(node_path) 
        
    os.environ['PATH'] = new_path
    
    try:
        trim_youtube_video(
            clean_youtube_url(url), start_seconds, end_seconds, output_path,
            cookie_header=cookie_header, log_callback=print
        )
        sys.exit(0)
    except Exception:
        sys.exit(1)


if __name__ == "__main__":
    main()
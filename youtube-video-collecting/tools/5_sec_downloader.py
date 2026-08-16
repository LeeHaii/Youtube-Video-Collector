import copy
import csv
import hashlib
import io
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

from yt_dlp import YoutubeDL
from yt_dlp.version import __version__ as YT_DLP_VERSION


def configure_output_stream(stream):
    """Make piped Electron logs UTF-8 and immediately visible line by line."""
    if stream is None:
        return stream
    try:
        stream.reconfigure(encoding="utf-8", line_buffering=True, write_through=True)
        return stream
    except (AttributeError, ValueError):
        buffer = getattr(stream, "buffer", None)
        if buffer is None:
            return stream
        return io.TextIOWrapper(
            buffer,
            encoding="utf-8",
            line_buffering=True,
            write_through=True,
        )


# A PyInstaller child process writes to a pipe, which is block-buffered by default.
sys.stdout = configure_output_stream(sys.stdout)
sys.stderr = configure_output_stream(sys.stderr)


CLIP_DURATION = 5.0
MAX_CLIP_ATTEMPTS = 3

EXIT_SUCCESS = 0
EXIT_FATAL = 1
EXIT_PARTIAL_FAILURE = 2
EXIT_CANCELED = 3

ERROR_FORBIDDEN = "FORBIDDEN"
ERROR_RATE_LIMIT = "RATE_LIMIT"
ERROR_AGE_RESTRICTION = "AGE_RESTRICTION"
ERROR_AUTHENTICATION = "AUTHENTICATION"
ERROR_UNAVAILABLE = "UNAVAILABLE"
ERROR_FORMAT = "FORMAT"
ERROR_GENERIC = "ERROR"

ERROR_HEADERS = {
    ERROR_FORBIDDEN: "FORBIDDEN_ERRORS",
    ERROR_RATE_LIMIT: "RATE_LIMIT_ERRORS",
    ERROR_AGE_RESTRICTION: "AGE_RESTRICTION_ERRORS",
    ERROR_AUTHENTICATION: "AUTHENTICATION_ERRORS",
    ERROR_UNAVAILABLE: "UNAVAILABLE_ERRORS",
    ERROR_FORMAT: "FORMAT_ERRORS",
    ERROR_GENERIC: "OTHER_ERRORS",
}

RETRYABLE_ERRORS = {
    ERROR_FORBIDDEN,
    ERROR_RATE_LIMIT,
    ERROR_AUTHENTICATION,
    ERROR_FORMAT,
    ERROR_GENERIC,
}

DEFAULT_FORMAT = "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"


@dataclass(frozen=True)
class DownloadProfile:
    name: str
    player_clients: Tuple[str, ...] = ()
    format_selector: str = DEFAULT_FORMAT


DOWNLOAD_PROFILES = (
    DownloadProfile("standard"),
    # web_safari exposes HLS formats that currently do not require a GVS PO token.
    DownloadProfile("safari-hls", ("web_safari",)),
    # Last-resort token-free path for videos that allow embedded playback.
    DownloadProfile("embedded", ("web_embedded",)),
)


@dataclass
class ClipOutcome:
    status: str
    message: str = ""
    attempts: int = 1

    @property
    def ok(self) -> bool:
        return self.status == "OK"


@dataclass
class ProcessingSummary:
    total: int
    succeeded: int = 0
    canceled: bool = False
    errors: Dict[str, Dict[str, List[float]]] = field(default_factory=dict)

    @property
    def failed(self) -> int:
        return sum(
            len(timestamps)
            for urls in self.errors.values()
            for timestamps in urls.values()
        )

    @property
    def processed(self) -> int:
        return self.succeeded + self.failed

    def add_failure(self, category: str, url: str, timestamp: float) -> None:
        urls = self.errors.setdefault(category, {})
        urls.setdefault(url, []).append(timestamp)

    def count(self, category: str) -> int:
        return sum(len(timestamps) for timestamps in self.errors.get(category, {}).values())

    def payload(self) -> Dict[str, object]:
        return {
            "total": self.total,
            "processed": self.processed,
            "succeeded": self.succeeded,
            "failed": self.failed,
            "canceled": self.canceled,
            "forbidden": self.count(ERROR_FORBIDDEN),
            "rateLimited": self.count(ERROR_RATE_LIMIT),
            "ageRestricted": self.count(ERROR_AGE_RESTRICTION),
            "authentication": self.count(ERROR_AUTHENTICATION),
            "unavailable": self.count(ERROR_UNAVAILABLE),
            "format": self.count(ERROR_FORMAT),
            "other": self.count(ERROR_GENERIC),
        }

    def exit_code(self) -> int:
        if self.canceled:
            return EXIT_CANCELED
        if self.failed:
            return EXIT_PARTIAL_FAILURE
        return EXIT_SUCCESS


def clean_youtube_url(url: str) -> str:
    try:
        parsed = urlparse(url)
        params = parse_qs(parsed.query)
        if "v" in params:
            return f"https://www.youtube.com/watch?v={params['v'][0]}"
    except (TypeError, ValueError):
        pass
    return url


def parse_input_csv(csv_path: str):
    rows = []

    def convert_timestamp(timestamp: str) -> float:
        parts = timestamp.split(".")
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        return float(timestamp)

    with open(csv_path, newline="", encoding="utf-8-sig") as csv_file:
        reader = csv.reader(csv_file)
        for row in reader:
            if not any(cell.strip() for cell in row):
                rows.append([])
                continue

            pairs = []
            for index in range(0, len(row), 2):
                if index + 1 >= len(row):
                    continue

                url = row[index].strip()
                timestamps_raw = row[index + 1].strip()
                if not url or not timestamps_raw:
                    continue

                timestamps = [
                    convert_timestamp(value.strip())
                    for value in timestamps_raw.split(";")
                    if value.strip()
                ]
                if timestamps:
                    pairs.append((clean_youtube_url(url), timestamps))
            rows.append(pairs)

    return rows


def sanitize_diagnostic(message: str) -> str:
    # Signed googlevideo URLs contain IP/session data; retain the host but redact queries.
    message = re.sub(r"(https?://[^\s?]+)\?[^\s]+", r"\1?<redacted>", str(message))
    return " ".join(message.replace("\r", " ").replace("\n", " ").split())[:800]


def classify_error(message: str) -> str:
    error = str(message).lower()

    if "429" in error or "too many requests" in error or "rate limit" in error:
        return ERROR_RATE_LIMIT
    if (
        "3436169992" in error
        or "0xccc fcb08".replace(" ", "") in error
        or "http error 403" in error
        or "403 forbidden" in error
        or "server returned 403" in error
        or "access denied" in error
    ):
        return ERROR_FORBIDDEN
    if "age-restricted" in error or "confirm your age" in error or "inappropriate for some users" in error:
        return ERROR_AGE_RESTRICTION
    if (
        "sign in to confirm" in error
        or "not a bot" in error
        or "login required" in error
        or "authentication" in error
        or "cookies" in error
    ):
        return ERROR_AUTHENTICATION
    if "requested format is not available" in error or "no video formats" in error:
        return ERROR_FORMAT
    if (
        "video unavailable" in error
        or "this video is unavailable" in error
        or "private video" in error
        or "has been removed" in error
    ):
        return ERROR_UNAVAILABLE
    return ERROR_GENERIC


class DownloaderLogger:
    def __init__(self, log_callback: Callable[[str], None]):
        self.log_callback = log_callback
        self.messages: List[str] = []

    def clear(self) -> None:
        self.messages.clear()

    def _record(self, level: str, message: str) -> None:
        clean = sanitize_diagnostic(message)
        if not clean:
            return
        self.messages.append(clean)
        self.messages = self.messages[-20:]
        if level in ("warning", "error"):
            icon = "⚠️" if level == "warning" else "❌"
            self.log_callback(f"      {icon} yt-dlp: {clean}\n")

    def debug(self, message: str) -> None:
        # yt-dlp routes normal informational messages through debug when a logger is used.
        if str(message).startswith("[debug]"):
            self._record("debug", message)

    def info(self, message: str) -> None:
        self._record("info", message)

    def warning(self, message: str) -> None:
        self._record("warning", message)

    def error(self, message: str) -> None:
        self._record("error", message)

    def recent_text(self) -> str:
        return " | ".join(self.messages[-8:])


def _parse_version_tuple(output: str) -> Tuple[int, ...]:
    match = re.search(r"(\d+)(?:\.(\d+))?(?:\.(\d+))?", output)
    if not match:
        return ()
    return tuple(int(part or 0) for part in match.groups())


def _runtime_version(executable: Path) -> Tuple[Tuple[int, ...], str]:
    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        result = subprocess.run(
            [str(executable), "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=creation_flags,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return (), ""
    lines = (result.stdout or result.stderr or "").strip().splitlines()
    output = lines[0] if lines else ""
    return _parse_version_tuple(output), output


def _unique_existing_paths(paths) -> List[Path]:
    result = []
    seen = set()
    for value in paths:
        if not value:
            continue
        path = Path(value)
        key = str(path).lower()
        if key not in seen and path.is_file():
            seen.add(key)
            result.append(path)
    return result


def app_data_directory() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "YoutubeVideoCollector"
    return Path.home() / ".youtube-video-collector"


def _download_portable_node(log_callback: Callable[[str], None]) -> Optional[Path]:
    if os.name != "nt" or os.environ.get("YVC_DISABLE_RUNTIME_DOWNLOAD") == "1":
        return None

    node_directory = app_data_directory() / "Node22"
    node_executable = node_directory / "node.exe"
    if node_executable.is_file():
        version, _ = _runtime_version(node_executable)
        if version >= (22, 0):
            return node_executable

    base_url = "https://nodejs.org/download/release/latest-v22.x"
    download_path = node_directory / "node.exe.download"
    try:
        node_directory.mkdir(parents=True, exist_ok=True)
        log_callback("🌐 No supported JS runtime found; downloading portable Node.js 22 LTS (~90 MB, one time)...\n")

        with urllib.request.urlopen(f"{base_url}/SHASUMS256.txt", timeout=30) as response:
            checksums = response.read().decode("utf-8")
        expected_hash = None
        for line in checksums.splitlines():
            if line.strip().endswith("win-x64/node.exe"):
                expected_hash = line.split()[0].lower()
                break
        if not expected_hash:
            raise RuntimeError("Node.js checksum was not published")

        digest = hashlib.sha256()
        with urllib.request.urlopen(f"{base_url}/win-x64/node.exe", timeout=120) as response:
            with open(download_path, "wb") as output_file:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    output_file.write(chunk)
                    digest.update(chunk)

        if digest.hexdigest().lower() != expected_hash:
            raise RuntimeError("Node.js checksum verification failed")

        os.replace(download_path, node_executable)
        version, output = _runtime_version(node_executable)
        if version < (22, 0):
            raise RuntimeError(f"Downloaded unsupported Node.js runtime: {output or 'unknown'}")
        log_callback(f"✅ Portable JS runtime installed: {output}\n")
        return node_executable
    except Exception as error:
        try:
            download_path.unlink(missing_ok=True)
        except OSError:
            pass
        log_callback(f"⚠️ Could not install the optional JS runtime: {sanitize_diagnostic(error)}\n")
        return None


def find_js_runtime(log_callback: Callable[[str], None] = print) -> Optional[Dict[str, object]]:
    local_data = app_data_directory()
    deno_candidates = _unique_existing_paths(
        [
            shutil.which("deno"),
            local_data / "Deno" / "deno.exe",
            Path(os.environ.get("USERPROFILE", "")) / ".deno" / "bin" / "deno.exe",
        ]
    )
    for executable in deno_candidates:
        version, output = _runtime_version(executable)
        if version >= (2, 3):
            return {"name": "deno", "path": executable, "version": output}

    node_candidates = _unique_existing_paths(
        [
            shutil.which("node"),
            local_data / "Node22" / "node.exe",
            Path("C:/Program Files/nodejs/node.exe"),
            Path("C:/Program Files (x86)/nodejs/node.exe"),
        ]
    )
    for executable in node_candidates:
        version, output = _runtime_version(executable)
        if version >= (22, 0):
            return {"name": "node", "path": executable, "version": output}

    downloaded = _download_portable_node(log_callback)
    if downloaded:
        _, output = _runtime_version(downloaded)
        return {"name": "node", "path": downloaded, "version": output}
    return None


def ejs_version() -> Optional[str]:
    try:
        return metadata.version("yt-dlp-ejs")
    except metadata.PackageNotFoundError:
        try:
            __import__("yt_dlp_ejs")
            return "bundled"
        except ImportError:
            return None


def find_ffmpeg_exe() -> Optional[Path]:
    if getattr(sys, "frozen", False):
        bundled = Path(getattr(sys, "_MEIPASS", ".")) / "ffmpeg" / "bin" / "ffmpeg.exe"
        if bundled.exists():
            return bundled

    local_app_data = Path(os.environ.get("LOCALAPPDATA", ""))
    candidates = [
        local_app_data / "Microsoft" / "WinGet" / "Packages",
        local_app_data / "Programs" / "Gyan",
        Path("C:/Program Files/Gyan"),
        app_data_directory() / "FFmpeg",
    ]
    for base in candidates:
        if base.exists():
            found = next(base.rglob("ffmpeg.exe"), None)
            if found:
                return found

    executable = shutil.which("ffmpeg")
    return Path(executable) if executable else None


def build_ydl_options(
    output_template: str,
    start: int,
    end: int,
    profile: DownloadProfile,
    ffmpeg_executable: Path,
    cache_directory: Path,
    request_sleep: float,
    logger: DownloaderLogger,
    js_runtime: Optional[Dict[str, object]],
) -> Dict[str, object]:
    options: Dict[str, object] = {
        "format": profile.format_selector,
        "outtmpl": output_template,
        "download_ranges": lambda info_dict, ydl: [
            {"start_time": start, "end_time": end}
        ],
        "force_keyframes_at_cuts": True,
        "merge_output_format": "mp4",
        "postprocessor_args": [
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "192k",
        ],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": False,
        "noprogress": True,
        "logger": logger,
        "cachedir": str(cache_directory),
        "socket_timeout": 30,
        "sleep_interval_requests": request_sleep,
        "retries": 3,
        "extractor_retries": 2,
        "fragment_retries": 3,
        "file_access_retries": 3,
        "ffmpeg_location": str(ffmpeg_executable.parent),
    }

    if js_runtime:
        options["js_runtimes"] = {
            str(js_runtime["name"]): {"path": str(js_runtime["path"])}
        }
    if not ejs_version():
        # Authorized fallback for source/dev environments that have not packaged yt-dlp-ejs yet.
        options["remote_components"] = ["ejs:github", "ejs:npm"]
    if profile.player_clients:
        options["extractor_args"] = {
            "youtube": {"player_client": list(profile.player_clients)}
        }
    return options


class VideoDownloadSession:
    def __init__(
        self,
        url: str,
        profile: DownloadProfile,
        ffmpeg_executable: Path,
        cache_directory: Path,
        request_sleep: float,
        js_runtime: Optional[Dict[str, object]],
        log_callback: Callable[[str], None],
    ):
        self.url = url
        self.profile = profile
        self.logger = DownloaderLogger(log_callback)
        self.options = build_ydl_options(
            "unused.%(ext)s",
            0,
            1,
            profile,
            ffmpeg_executable,
            cache_directory,
            request_sleep,
            self.logger,
            js_runtime,
        )
        self.ydl = YoutubeDL(self.options)
        self.info = None

    def download(self, start: int, end: int, output_template: str) -> None:
        self.logger.clear()
        normalized_template = self.ydl.params.get("outtmpl")
        if isinstance(normalized_template, dict):
            normalized_template["default"] = output_template
        else:
            self.ydl.params["outtmpl"] = output_template
        self.ydl.params["download_ranges"] = lambda info_dict, ydl: [
            {"start_time": start, "end_time": end}
        ]
        if self.info is None:
            self.info = self.ydl.extract_info(self.url, download=False)
        self.ydl.process_ie_result(copy.deepcopy(self.info), download=True)

    def diagnostics(self) -> str:
        return self.logger.recent_text()

    def close(self) -> None:
        self.ydl.close()


def cleanup_partial_outputs(output_template: str) -> None:
    stem = output_template.replace(".%(ext)s", "")
    stem_path = Path(stem)
    if not stem_path.parent.exists():
        return
    for candidate in stem_path.parent.glob(f"{stem_path.name}.*"):
        if candidate.is_file():
            try:
                candidate.unlink()
            except OSError:
                pass


def check_stop_flag(stop_flag_path: Optional[str]) -> bool:
    return bool(stop_flag_path and Path(stop_flag_path).exists())


def stop_requested(stop_event=None, stop_flag_path: Optional[str] = None) -> bool:
    return bool((stop_event and stop_event.is_set()) or check_stop_flag(stop_flag_path))


def interruptible_sleep(
    duration: float,
    stop_event=None,
    stop_flag_path: Optional[str] = None,
    sleep_func: Callable[[float], None] = time.sleep,
) -> bool:
    remaining = max(0.0, duration)
    while remaining > 0:
        if stop_requested(stop_event, stop_flag_path):
            return False
        interval = min(0.25, remaining)
        sleep_func(interval)
        remaining -= interval
    return not stop_requested(stop_event, stop_flag_path)


def retry_delay(category: str, attempt: int) -> float:
    if category == ERROR_RATE_LIMIT:
        base = 15.0
    elif category == ERROR_FORBIDDEN:
        base = 3.0
    else:
        base = 2.0
    return base * (2 ** max(0, attempt - 1)) + random.uniform(0.0, 1.0)


def download_clip(
    url: str,
    start_time: float,
    duration: float,
    output_template: str,
    ffmpeg_executable: Path,
    cache_directory: Path,
    js_runtime: Optional[Dict[str, object]],
    request_sleep: float,
    session_cache: Dict[str, VideoDownloadSession],
    log_callback: Callable[[str], None] = print,
    stop_event=None,
    stop_flag_path: Optional[str] = None,
    session_factory=VideoDownloadSession,
    sleep_func: Callable[[float], None] = time.sleep,
) -> ClipOutcome:
    start = int(start_time)
    end = int(start_time + duration)
    last_category = ERROR_GENERIC
    last_message = "Unknown download failure"
    attempts_used = 0

    profiles = sorted(
        DOWNLOAD_PROFILES[:MAX_CLIP_ATTEMPTS],
        key=lambda profile: profile.name not in session_cache,
    )
    for attempt, profile in enumerate(profiles, start=1):
        attempts_used = attempt
        if stop_requested(stop_event, stop_flag_path):
            return ClipOutcome("CANCELED", "Canceled by user", attempt)

        if attempt > 1:
            cleanup_partial_outputs(output_template)
            delay = retry_delay(last_category, attempt - 1)
            log_callback(
                f"      Retrying with {profile.name} delivery in {delay:.1f}s "
                f"after {last_category.lower()}...\n"
            )
            if not interruptible_sleep(
                delay,
                stop_event,
                stop_flag_path,
                sleep_func=sleep_func,
            ):
                return ClipOutcome("CANCELED", "Canceled by user", attempt)

        log_callback(f"    Downloading {start}-{end}s ({profile.name}) ... ")
        session = session_cache.get(profile.name)
        if session is None:
            session = session_factory(
                url,
                profile,
                ffmpeg_executable,
                cache_directory,
                request_sleep,
                js_runtime,
                log_callback,
            )
            session_cache[profile.name] = session

        try:
            session.download(start, end, output_template)
            log_callback("OK\n")
            return ClipOutcome("OK", attempts=attempt)
        except Exception as error:
            diagnostics = session.diagnostics()
            last_message = sanitize_diagnostic(f"{error} | {diagnostics}")
            last_category = classify_error(last_message)
            log_callback(f"FAILED [{last_category}]: {last_message}\n")
            session.close()
            session_cache.pop(profile.name, None)

            if last_category not in RETRYABLE_ERRORS:
                break

    cleanup_partial_outputs(output_template)
    return ClipOutcome(last_category, last_message, attempts_used)


def close_sessions(session_cache: Dict[str, VideoDownloadSession]) -> None:
    for session in session_cache.values():
        try:
            session.close()
        except Exception:
            pass
    session_cache.clear()


def log_error_summaries(summary: ProcessingSummary, log_callback: Callable[[str], None]) -> None:
    for category, header in ERROR_HEADERS.items():
        urls = summary.errors.get(category)
        if not urls:
            continue
        log_callback(f"📊 ERROR_SUMMARY: {header}\n")
        for url, timestamps in urls.items():
            values = ";".join(str(int(timestamp)) for timestamp in timestamps)
            log_callback(f"  {url}|{values}\n")
    log_callback(
        "📊 DOWNLOAD_SUMMARY: "
        + json.dumps(summary.payload(), ensure_ascii=False, separators=(",", ":"))
        + "\n"
    )


def process_clips(
    csv_path: str,
    output_base_dir: str,
    ffmpeg_executable: Path,
    js_runtime: Optional[Dict[str, object]],
    clip_sleep_min: float = 1.0,
    clip_sleep_max: float = 2.0,
    row_sleep_min: float = 10.0,
    row_sleep_max: float = 15.0,
    log_callback: Callable[[str], None] = print,
    stop_event=None,
    stop_flag_path: Optional[str] = None,
    download_clip_func=download_clip,
    sleep_func: Callable[[float], None] = time.sleep,
) -> ProcessingSummary:
    rows = parse_input_csv(csv_path)
    non_empty_rows = [(index, pairs) for index, pairs in enumerate(rows) if pairs]
    total_clips = sum(len(timestamps) for _, pairs in non_empty_rows for _, timestamps in pairs)
    summary = ProcessingSummary(total=total_clips)
    cache_directory = app_data_directory() / "yt-dlp-cache"
    cache_directory.mkdir(parents=True, exist_ok=True)

    log_callback(f"Processing {len(non_empty_rows)} non-empty rows / {total_clips} clips\n")
    log_callback(
        f"⏱️ Clip Sleep: {clip_sleep_min}-{clip_sleep_max}s | "
        f"Row Sleep: {row_sleep_min}-{row_sleep_max}s\n\n"
    )

    clips_done = 0
    for output_row_num, (_, pairs) in enumerate(non_empty_rows, start=1):
        if stop_requested(stop_event, stop_flag_path):
            summary.canceled = True
            break

        log_callback(f"Row {output_row_num}:\n")
        row_started = time.perf_counter()
        row_output = Path(output_base_dir) / str(output_row_num)
        row_output.mkdir(parents=True, exist_ok=True)

        for url_index, (url, timestamps) in enumerate(pairs, start=1):
            log_callback(f"  URL: {url} with {len(timestamps)} timestamp(s)\n")
            sessions: Dict[str, VideoDownloadSession] = {}
            try:
                for clip_index, timestamp in enumerate(timestamps, start=1):
                    if stop_requested(stop_event, stop_flag_path):
                        summary.canceled = True
                        break

                    clips_done += 1
                    output_template = str(
                        row_output
                        / f"{output_row_num}.{url_index}.{clip_index}.%(ext)s"
                    )
                    log_callback(f"    [{clips_done}/{total_clips}] {int(timestamp)}s\n")

                    outcome = download_clip_func(
                        url,
                        timestamp,
                        CLIP_DURATION,
                        output_template,
                        ffmpeg_executable,
                        cache_directory,
                        js_runtime,
                        random.uniform(1.5, 3.0),
                        sessions,
                        log_callback=log_callback,
                        stop_event=stop_event,
                        stop_flag_path=stop_flag_path,
                        sleep_func=sleep_func,
                    )

                    if outcome.status == "CANCELED":
                        summary.canceled = True
                        break
                    if outcome.ok:
                        summary.succeeded += 1
                    else:
                        summary.add_failure(outcome.status, url, timestamp)

                    if clips_done < total_clips:
                        clip_delay = random.uniform(clip_sleep_min, clip_sleep_max)
                        log_callback(f"         Pausing before next clip for {clip_delay:.2f}s\n")
                        if not interruptible_sleep(
                            clip_delay,
                            stop_event,
                            stop_flag_path,
                            sleep_func=sleep_func,
                        ):
                            summary.canceled = True
                            break
            finally:
                close_sessions(sessions)

            if summary.canceled:
                break

        elapsed = time.perf_counter() - row_started
        log_callback(f"Row {output_row_num}: completed in {elapsed:.2f}s\n")
        if summary.canceled:
            break
        if output_row_num < len(non_empty_rows):
            row_delay = random.uniform(row_sleep_min, row_sleep_max)
            log_callback(f"         Pausing before next row for {row_delay:.2f}s\n\n")
            if not interruptible_sleep(
                row_delay,
                stop_event,
                stop_flag_path,
                sleep_func=sleep_func,
            ):
                summary.canceled = True
                break

    if summary.canceled:
        log_callback("⏹️ Processing canceled by user.\n")
    log_error_summaries(summary, log_callback)
    return summary


def main() -> None:
    if len(sys.argv) < 3:
        print(
            "Usage: 5_sec_downloader <csv_path> <output_path> "
            "[clip_sleep_min] [clip_sleep_max] [row_sleep_min] [row_sleep_max] [stop_flag_path]"
        )
        sys.exit(EXIT_FATAL)

    csv_path = sys.argv[1]
    output_path = sys.argv[2]
    clip_sleep_min = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
    clip_sleep_max = float(sys.argv[4]) if len(sys.argv) > 4 else 2.0
    row_sleep_min = float(sys.argv[5]) if len(sys.argv) > 5 else 10.0
    row_sleep_max = float(sys.argv[6]) if len(sys.argv) > 6 else 15.0
    stop_flag_path = sys.argv[7] if len(sys.argv) > 7 else None

    if not Path(csv_path).is_file():
        print(f"ERROR: Input CSV file not found: {csv_path}")
        sys.exit(EXIT_FATAL)
    if not Path(output_path).is_dir():
        print(f"ERROR: Output folder does not exist: {output_path}")
        sys.exit(EXIT_FATAL)
    if min(clip_sleep_min, clip_sleep_max, row_sleep_min, row_sleep_max) < 0:
        print("ERROR: Sleep intervals cannot be negative")
        sys.exit(EXIT_FATAL)
    if clip_sleep_min > clip_sleep_max or row_sleep_min > row_sleep_max:
        print("ERROR: Minimum sleep interval cannot exceed maximum")
        sys.exit(EXIT_FATAL)

    ffmpeg_executable = find_ffmpeg_exe()
    if ffmpeg_executable is None:
        print("ERROR: ffmpeg not found. Install FFmpeg and add it to PATH.")
        sys.exit(EXIT_FATAL)

    os.environ["PATH"] = str(ffmpeg_executable.parent) + os.pathsep + os.environ.get("PATH", "")

    try:
        print("🚀 Starting 5-Sec Download...")
        print(f"   CSV: {csv_path}")
        print(f"   Output: {output_path}")
        print(f"   yt-dlp: {YT_DLP_VERSION}")
        print(f"   FFmpeg: {ffmpeg_executable}")
        print(f"   EJS solver: {ejs_version() or 'not bundled (remote fallback enabled)'}")
        print(f"   Clip Sleep: {clip_sleep_min}-{clip_sleep_max}s")
        print(f"   Row Sleep: {row_sleep_min}-{row_sleep_max}s")
        if stop_flag_path:
            print(f"   Stop flag: {stop_flag_path}")

        js_runtime = find_js_runtime(print)
        if js_runtime:
            print(f"   JS runtime: {js_runtime['name']} {js_runtime['version']} ({js_runtime['path']})\n")
        else:
            print("   JS runtime: unavailable; Safari/HLS fallback will be used after direct 403 errors\n")

        summary = process_clips(
            csv_path,
            output_path,
            ffmpeg_executable,
            js_runtime,
            clip_sleep_min,
            clip_sleep_max,
            row_sleep_min,
            row_sleep_max,
            log_callback=print,
            stop_flag_path=stop_flag_path,
        )
        exit_code = summary.exit_code()
        if exit_code == EXIT_SUCCESS:
            print(f"\n✅ Processing completed: {summary.succeeded}/{summary.total} clips downloaded.")
        elif exit_code == EXIT_PARTIAL_FAILURE:
            print(
                f"\n⚠️ Processing completed with failures: {summary.succeeded} succeeded, "
                f"{summary.failed} failed."
            )
        else:
            print(
                f"\n⏹️ Processing canceled: {summary.succeeded} succeeded, "
                f"{summary.failed} failed, {summary.total - summary.processed} not processed."
            )
        sys.exit(exit_code)
    except Exception as error:
        print(f"\n❌ FATAL_ERROR: {sanitize_diagnostic(error)}")
        sys.exit(EXIT_FATAL)


if __name__ == "__main__":
    main()

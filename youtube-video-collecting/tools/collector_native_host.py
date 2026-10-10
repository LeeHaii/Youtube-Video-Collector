"""Chrome native messaging host for the Rhymx collector (standard library only)."""
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import struct
import subprocess
import sys
import threading
import time
from urllib.parse import parse_qs, urlsplit

MAX_MESSAGE = 65536
HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"}


class HostError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def read_exact(stream, length):
    data = bytearray()
    while len(data) < length:
        part = stream.read(length - len(data))
        if not part:
            raise HostError("invalid_request", "Incomplete message")
        data.extend(part)
    return bytes(data)


def read_message(stream):
    length = struct.unpack("<I", read_exact(stream, 4))[0]
    if not 0 < length <= MAX_MESSAGE:
        raise HostError("invalid_request", "Invalid message length")
    try:
        return json.loads(read_exact(stream, length).decode("utf-8"))
    except (ValueError, UnicodeError) as error:
        raise HostError("invalid_request", "Invalid JSON message") from error


def write_message(stream, message):
    data = json.dumps(message, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(data) > MAX_MESSAGE:
        raise HostError("invalid_request", "Message is too large")
    packet = struct.pack("<I", len(data)) + data
    while packet:
        written = stream.write(packet)
        if not written:
            raise HostError("delivery_failed", "Could not write message")
        packet = packet[written:]
    stream.flush()


def parse_time(value):
    if value is None or value == "":
        return 0
    if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?s?", value):
        seconds = float(value.rstrip("s"))
    else:
        match = re.fullmatch(r"(?:([0-9]+)h)?(?:([0-9]+)m)?(?:([0-9]+(?:\.[0-9]+)?)s)?", value)
        if not match or not any(match.groups()):
            raise HostError("invalid_url", "Invalid timestamp")
        seconds = float(match[1] or 0) * 3600 + float(match[2] or 0) * 60 + float(match[3] or 0)
    if not math.isfinite(seconds) or seconds < 0 or math.floor(seconds) > 9007199254740991:
        raise HostError("invalid_url", "Invalid timestamp")
    return math.floor(seconds)


def parse_youtube_url(value):
    if not isinstance(value, str) or len(value) > 8192:
        raise HostError("invalid_url", "Invalid URL")
    try:
        url = urlsplit(value)
        if url.scheme != "https" or url.hostname not in HOSTS or url.username or url.password or url.port not in (None, 443):
            raise ValueError("Unsupported YouTube URL")
        params = parse_qs(url.query, keep_blank_values=True)
        if url.hostname.endswith("youtu.be"):
            video_id = url.path[1:]
            if video_id.endswith("/"):
                video_id = video_id[:-1]
        elif url.path == "/watch":
            video_id = params.get("v", [""])[0]
        else:
            video_id = ""
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            raise ValueError("Invalid YouTube video ID")
        fragment = parse_qs(url.fragment, keep_blank_values=True)
        raw = params.get("t", params.get("start", fragment.get("t", [None])))[0]
        seconds = parse_time(raw)
        return {"videoId": video_id, "seconds": seconds,
                "url": f"https://www.youtube.com/watch?v={video_id}&t={seconds}s"}
    except ValueError as error:
        raise HostError("invalid_url", str(error)) from error


def validate_request(request):
    if not isinstance(request, dict) or request.get("version") != 1 or isinstance(request.get("version"), bool):
        raise HostError("invalid_request", "Invalid request version")
    request_id = request.get("requestId")
    if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", request_id):
        raise HostError("invalid_request", "Invalid request ID")
    kind = request.get("type")
    if kind == "ping":
        return {"version": 1, "requestId": request_id, "type": "ping"}
    if kind != "open-video":
        raise HostError("invalid_request", "Unsupported request type")
    video = parse_youtube_url(request.get("url"))
    return {"version": 1, "requestId": request_id, "type": kind, "url": video["url"]}


def load_configuration(origin):
    directory = os.environ.get("RHYMX_BRIDGE_DIR") or str(Path(os.environ["LOCALAPPDATA"]) / "RhymxCollector" / "bridge")
    try:
        config = json.loads((Path(directory) / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise HostError("missing_configuration", "Start the updated collector once to connect the extension") from error
    if origin not in config.get("allowedOrigins", []):
        raise HostError("unauthorized", "This extension is not registered with the collector")
    if not re.fullmatch(r"[a-f0-9]{64}", config.get("token", "")):
        raise HostError("missing_configuration", "Invalid bridge configuration")
    suffix = hashlib.sha256(directory.lower().encode("utf-8")).hexdigest()[:24]
    if config.get("pipeName") != rf"\\.\pipe\rhymx-collector-{suffix}":
        raise HostError("missing_configuration", "Invalid bridge endpoint")
    if not isinstance(config.get("args"), list) or not all(isinstance(arg, str) for arg in config["args"]):
        raise HostError("missing_configuration", "Invalid application arguments")
    return config


def deliver(request, config, timeout=30):
    if os.name != "nt":
        raise HostError("unsupported_platform", "The collector helper requires Windows")
    result = queue.Queue(maxsize=1)
    deadline = time.monotonic() + timeout

    def worker():
        launched = False
        while time.monotonic() < deadline:
            try:
                pipe = open(config["pipeName"], "r+b", buffering=0)
            except OSError as error:
                if getattr(error, "winerror", None) not in (None, 2, 3, 231) and error.errno not in (2, 13, 22):
                    result.put(HostError("delivery_failed", "Could not connect to collector"))
                    return
                if not launched:
                    if request["type"] == "ping":
                        result.put({"version": 1, "requestId": request["requestId"], "status": "installed", "ready": False})
                        return
                    executable = config.get("executable")
                    if not executable or not Path(executable).is_file():
                        result.put(HostError("app_not_found", "Collector executable was not found; reinstall the collector"))
                        return
                    try:
                        subprocess.Popen([executable, *config["args"]], cwd=str(Path(executable).parent),
                                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                         creationflags=subprocess.CREATE_NO_WINDOW, close_fds=True)
                    except OSError:
                        result.put(HostError("app_not_found", "Collector could not be started"))
                        return
                    launched = True
                time.sleep(0.15)
                continue
            try:
                with pipe:
                    write_message(pipe, {**request, "token": config["token"]})
                    response = read_message(pipe)
                if not isinstance(response, dict) or response.get("requestId") != request["requestId"] or response.get("version") != 1:
                    raise HostError("delivery_failed", "Invalid collector response")
                result.put(response)
            except (OSError, HostError) as error:
                result.put(error if isinstance(error, HostError) else HostError("delivery_failed", "Collector disconnected"))
            return
        result.put(HostError("startup_timeout", "Collector did not start in time"))

    threading.Thread(target=worker, daemon=True).start()
    try:
        response = result.get(timeout=timeout)
    except queue.Empty as error:
        raise HostError("startup_timeout", "Collector did not respond in time") from error
    if isinstance(response, HostError):
        raise response
    return response


def run(input_stream, output_stream, origin):
    request_id = None
    try:
        request = read_message(input_stream)
        if isinstance(request, dict):
            candidate = request.get("requestId")
            if isinstance(candidate, str) and len(candidate) <= 80:
                request_id = candidate
        payload = validate_request(request)
        config = load_configuration(origin)
        response = deliver(payload, config)
    except HostError as error:
        response = {"version": 1, "requestId": request_id, "status": "error", "code": error.code, "message": str(error)}
    except Exception:
        response = {"version": 1, "requestId": request_id, "status": "error", "code": "delivery_failed", "message": "Could not deliver link to collector"}
    write_message(output_stream, response)


if __name__ == "__main__":
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    run(sys.stdin.buffer, sys.stdout.buffer, sys.argv[1] if len(sys.argv) > 1 else "")

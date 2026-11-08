"""Scoped cancellation/deadlines for yt-dlp and its external media processes."""
import subprocess
import threading
import time

ACTIVE = None


class DownloadCanceled(RuntimeError):
    pass


class OperationControl:
    def __init__(self, stopped=lambda: False, seconds=180):
        self.stopped = stopped
        self.deadline = time.monotonic() + seconds
        self.processes = []
        self.done = threading.Event()

    def check(self):
        if self.stopped():
            raise DownloadCanceled('Canceled by user')
        if time.monotonic() >= self.deadline:
            raise TimeoutError('Clip operation deadline exceeded')

    def _watch(self):
        while not self.done.wait(0.1):
            try:
                self.check()
            except (DownloadCanceled, TimeoutError):
                for proc in list(self.processes):
                    if proc.poll() is None:
                        try:
                            subprocess.Popen.kill(proc)
                        except OSError:
                            pass

    def __enter__(self):
        global ACTIVE
        ACTIVE = self
        # yt-dlp retains aliases to this class in multiple downloader/JS/PP modules.
        # Patch only its constructor within this single-threaded operation, not its
        # source, so the watchdog owns every child process regardless of the alias.
        from yt_dlp.utils import Popen
        self.popen = Popen
        self.original_init = Popen.__init__
        control = self
        def initialize(proc, *args, **kwargs):
            control.check()
            control.original_init(proc, *args, **kwargs)
            control.processes.append(proc)
        Popen.__init__ = initialize
        self.thread = threading.Thread(target=self._watch, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_):
        global ACTIVE
        self.popen.__init__ = self.original_init
        self.done.set()
        self.thread.join()
        ACTIVE = None


def run_media(arguments, timeout=30):
    control = ACTIVE
    if control:
        control.check()
    with subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, encoding='utf-8', errors='replace',
                          creationflags=subprocess.CREATE_NO_WINDOW if __import__('os').name == 'nt' else 0) as proc:
        if control:
            control.processes.append(proc)
        effective_timeout = min(timeout, max(0.001, control.deadline - time.monotonic())) if control else timeout
        try:
            stdout, stderr = proc.communicate(timeout=effective_timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            if control:
                control.check()
                if effective_timeout < timeout:
                    raise TimeoutError('Clip operation deadline exceeded')
            raise
        if control:
            control.check()
        return subprocess.CompletedProcess(arguments, proc.returncode, stdout, stderr)

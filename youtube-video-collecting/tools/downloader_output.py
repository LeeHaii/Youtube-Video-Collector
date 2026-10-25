"""Run ownership and transactional publication of provenance-verified clips."""
import hashlib
import json
import os
import tempfile
import uuid
from pathlib import Path


class OutputConflict(RuntimeError):
    pass


def file_hash(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with open(temporary, 'x', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class RunLock:
    def __init__(self, directory, run_id):
        self.path = Path(directory) / '.downloader.lock'
        self.run_id = run_id

    def __enter__(self):
        try:
            with open(self.path, 'x', encoding='utf-8') as stream:
                json.dump({'pid': os.getpid(), 'run_id': self.run_id}, stream)
        except FileExistsError as error:
            raise OutputConflict('Output folder is locked by another or interrupted run. After confirming no downloader is running, remove .downloader.lock or choose a fresh folder.') from error
        return self

    def __exit__(self, *_):
        if json.loads(self.path.read_text(encoding='utf-8')).get('run_id') == self.run_id:
            self.path.unlink()


class OutputTransaction:
    def __init__(self, destination, identity, replace_existing=False):
        self.destination = Path(destination)
        self.sidecar = self.destination.with_suffix('.quality.json')
        self.identity = identity
        self.replace_existing = replace_existing

    def existing(self):
        if not self.destination.exists() and not self.sidecar.exists():
            return None
        try:
            record = json.loads(self.sidecar.read_text(encoding='utf-8'))
            if record['state'] != 'committed' or record['identity'] != self.identity or record['sha256'] != file_hash(self.destination):
                raise ValueError('Provenance or content mismatch')
            return record
        except (OSError, ValueError, KeyError, TypeError) as error:
            if not self.replace_existing:
                raise OutputConflict('Existing clip has missing/mismatched provenance. Choose a fresh folder or explicitly enable replacement.') from error
            return None

    def __enter__(self):
        self.directory = tempfile.TemporaryDirectory(prefix='.clip-', dir=self.destination.parent)
        self.template = str(Path(self.directory.name) / 'clip.%(ext)s')
        self.temporary = Path(self.directory.name) / 'clip.mp4'
        return self

    def publish(self, record):
        record = {**record, 'identity': self.identity, 'sha256': file_hash(self.temporary),
                  'size': self.temporary.stat().st_size, 'state': 'pending'}
        # Pending provenance makes a crash between the two replacements non-reusable.
        atomic_json(self.sidecar, record)
        os.replace(self.temporary, self.destination)
        record['state'] = 'committed'
        atomic_json(self.sidecar, record)
        return record

    def __exit__(self, *_):
        self.directory.cleanup()

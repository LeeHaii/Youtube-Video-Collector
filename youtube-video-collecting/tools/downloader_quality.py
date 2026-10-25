"""Quality policy and rendition selection, independent of transport and encoding."""
import hashlib
import json
import math
from dataclasses import asdict, dataclass, field
from urllib.parse import parse_qs, urlparse

PROTOCOL_VERSION = 2
SUPPORTED_QUALITIES = (144, 240, 360, 480, 720, 1080, 1440, 2160)


class QualityUnavailable(RuntimeError):
    pass


def numeric(value):
    try:
        number = float(value)
        return number if math.isfinite(number) and number > 0 else 0
    except (ValueError, TypeError):
        return 0


def source_identity(url):
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower()
    video_id = None
    if host in ('youtu.be', 'www.youtu.be'):
        video_id = parsed.path.strip('/').split('/')[0]
    elif host in ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'):
        video_id = parse_qs(parsed.query).get('v', [None])[0]
        parts = parsed.path.strip('/').split('/')
        if not video_id and len(parts) == 2 and parts[0] in ('shorts', 'embed', 'live'):
            video_id = parts[1]
    if video_id:
        return 'https://www.youtube.com/watch?v=' + video_id
    # Generic HTTP fixtures keep their full identity internally (never logged).
    return url


@dataclass(frozen=True)
class QualityPolicy:
    minimum_edge: int = 1080
    maximum_edge: int | None = 1080
    policy_version: int = PROTOCOL_VERSION
    dimension_basis: str = 'shorter-edge'
    fallback_mode: str = 'strict'

    def __post_init__(self):
        if type(self.minimum_edge) is not int or self.minimum_edge not in SUPPORTED_QUALITIES:
            raise ValueError('Unsupported minimum quality')
        if self.maximum_edge is not None and (type(self.maximum_edge) is not int or self.maximum_edge not in SUPPORTED_QUALITIES):
            raise ValueError('Unsupported maximum quality')
        if self.maximum_edge is not None and self.minimum_edge > self.maximum_edge:
            raise ValueError('Minimum quality cannot exceed maximum quality')
        if self.fallback_mode != 'strict' or self.dimension_basis != 'shorter-edge' or self.policy_version != PROTOCOL_VERSION:
            raise ValueError('Unsupported quality policy')

    def payload(self):
        return asdict(self)

    @property
    def fingerprint(self):
        return hashlib.sha256(json.dumps(self.payload(), sort_keys=True).encode()).hexdigest()

    def check(self, width, height, fps=0, target=None):
        edge = min(numeric(width), numeric(height))
        if not edge or edge < self.minimum_edge or (self.maximum_edge is not None and edge > self.maximum_edge):
            raise QualityUnavailable(f'Source {width}x{height} does not meet {self.minimum_edge}p minimum / {self.maximum_edge or "best available"} maximum')
        if target and (edge < target[0] or numeric(fps) + 0.1 < target[1]):
            raise QualityUnavailable(f'Source {width}x{height} at {fps:g} fps is below locked target {target[0]:g}p at {target[1]:g} fps')
        return edge


def candidates(formats, policy, *, require_audio=True):
    """Return video/audio plans in one resolution comparison; URLs stay in memory."""
    audio = [f for f in formats if f.get('vcodec') == 'none' and f.get('acodec') not in (None, 'none') and not f.get('has_drm')]
    best_audio = audio[-1] if audio else None  # yt-dlp has sorted these worst-to-best
    plans = []
    for index, video in enumerate(formats):
        if video.get('vcodec') == 'none' or video.get('has_drm') or video.get('ext') in ('mhtml', 'jpg', 'png'):
            continue
        width, height = numeric(video.get('width')), numeric(video.get('height'))
        edge = min(width, height)
        # Missing dimensions are retained for probing, never accepted blindly.
        if edge and (edge < policy.minimum_edge or (policy.maximum_edge is not None and edge > policy.maximum_edge)):
            continue
        combined = video.get('acodec') not in (None, 'none')
        if not combined and not best_audio and require_audio:
            continue
        selected = dict(video)
        if not combined and best_audio:
            selected.update(format_id=f'{video["format_id"]}+{best_audio["format_id"]}',
                            requested_formats=[dict(video), dict(best_audio)], ext='mp4',
                            protocol=f'{video.get("protocol", "https")}+{best_audio.get("protocol", "https")}')
        plans.append((edge, numeric(video.get('fps')), index, selected))
    return [item[-1] for item in sorted(plans, key=lambda p: p[:3], reverse=True)]


def format_selector(policy, chosen=None, require_audio=True):
    def select(ctx):
        inventory = candidates(ctx.get('formats', []), policy, require_audio=require_audio)
        if chosen is not None:
            inventory = [f for f in inventory if f['format_id'] == chosen]
        if not inventory:
            raise QualityUnavailable('No accessible video/audio rendition meets the requested quality')
        yield inventory[0]
    return select


@dataclass
class VideoQualityState:
    target: tuple | None = None
    attempts: list = field(default_factory=list)
    discovery_errors: list = field(default_factory=list)

    def accept(self, policy, encoding):
        edge = policy.check(encoding.width, encoding.height, encoding.fps, self.target)
        self.target = (max(edge, self.target[0] if self.target else 0), max(encoding.fps, self.target[1] if self.target else 0))


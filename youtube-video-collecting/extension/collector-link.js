(function (root, factory) {
  const api = factory();
  if (typeof window === 'undefined' && typeof module === 'object' && module.exports) module.exports = api;
  else root.CollectorLink = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be']);

  function parseTime(value) {
    if (value === null || value === '') return 0;
    if (/^\d+(?:\.\d+)?s?$/.test(value)) return Math.floor(Number(value.replace(/s$/, '')));
    const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(value);
    if (!parts || !parts.slice(1).some(Boolean)) throw new Error('Invalid timestamp');
    const seconds = Number(parts[1] || 0) * 3600 + Number(parts[2] || 0) * 60 + Number(parts[3] || 0);
    if (!Number.isSafeInteger(Math.floor(seconds))) throw new Error('Timestamp is too large');
    return Math.floor(seconds);
  }

  function parseYouTubeUrl(input) {
    if (typeof input !== 'string' || input.length > 8192) throw new Error('Invalid URL');
    const url = new URL(input);
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.port) {
      throw new Error('Only HTTPS YouTube links are supported');
    }
    let videoId;
    if (url.hostname.endsWith('youtu.be')) videoId = url.pathname.replace(/^\//, '').replace(/\/$/, '');
    else if (url.pathname === '/watch') videoId = url.searchParams.get('v');
    if (!videoId || !VIDEO_ID.test(videoId)) throw new Error('Invalid YouTube video ID');
    const hash = new URLSearchParams(url.hash.slice(1));
    const rawTime = url.searchParams.get('t') ?? url.searchParams.get('start') ?? hash.get('t');
    const seconds = parseTime(rawTime);
    if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error('Invalid timestamp');
    return { videoId, seconds, url: `https://www.youtube.com/watch?v=${videoId}&t=${seconds}s` };
  }

  function isSheetUrl(input) {
    try {
      const url = new URL(input);
      return url.protocol === 'https:' && url.hostname === 'docs.google.com' &&
        /^\/spreadsheets\/d\/[A-Za-z0-9_-]+\/(?:edit|view|preview)(?:\/|$)/.test(url.pathname);
    } catch { return false; }
  }

  function unwrapGoogleUrl(input) {
    let current = input;
    for (let depth = 0; depth < 3; depth++) {
      const url = new URL(current);
      if (url.protocol !== 'https:' || !['www.google.com', 'google.com'].includes(url.hostname) || url.pathname !== '/url') break;
      const next = url.searchParams.get('q') || url.searchParams.get('url');
      if (!next) break;
      current = next;
    }
    return current;
  }

  function destination(input) {
    try { return parseYouTubeUrl(unwrapGoogleUrl(input)); } catch { return null; }
  }
  return { parseTime, parseYouTubeUrl, isSheetUrl, unwrapGoogleUrl, destination };
});

(function (root, factory) {
  const commonJs = typeof window === 'undefined' && typeof module === 'object' && module.exports;
  const api = factory(commonJs ? require('./collector-link') : root.CollectorLink);
  if (commonJs) module.exports = api;
  else root.CollectorNavigation = api;
})(typeof globalThis === 'object' ? globalThis : this, function (links) {
  function createNavigator({ webview, prepare, status, timeoutMs = 45000, pollMs = 300 }) {
    let generation = 0;
    let timer;
    function cancel() { generation++; clearTimeout(timer); status('', false); }
    return {
      cancel,
      async open(request) {
        const destination = links.parseYouTubeUrl(request.url);
        const ensureTime = () => {
          if (Number.isFinite(request.expiresAt) && Date.now() >= request.expiresAt) throw new Error('Request expired');
        };
        ensureTime();
        cancel();
        const task = generation;
        const ensureActive = () => {
          if (task !== generation) throw new Error('Navigation was superseded');
          ensureTime();
        };
        await prepare(destination, ensureActive);
        ensureActive();
        let actual;
        try { actual = links.parseYouTubeUrl(webview.getURL()); } catch {}
        status(`Opening video at ${destination.seconds}s`, false);
        if (!actual || actual.videoId !== destination.videoId) webview.src = destination.url;
        const deadline = Date.now() + timeoutMs;
        // Every attempt verifies the main video, so an advert or stale page cannot be sought.
        async function seek() {
          if (task !== generation) return;
          try {
            const outcome = await webview.executeJavaScript(`(function() {
              const target = ${JSON.stringify(destination)};
              const current = new URL(location.href);
              if (current.searchParams.get('v') !== target.videoId) return 'loading';
              const player = document.querySelector('#movie_player');
              if (!player || player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) return 'loading';
              const data = typeof player.getVideoData === 'function' ? player.getVideoData() : null;
              if (!data || data.video_id !== target.videoId) return 'loading';
              const video = document.querySelector('video.html5-main-video');
              if (!video || video.readyState < 2 || !Number.isFinite(video.duration) || !video.duration) return 'loading';
              if (target.seconds >= video.duration && target.seconds > 0) return 'out-of-range';
              if (Math.abs(video.currentTime - target.seconds) > 0.75) {
                if (typeof player.seekTo === 'function') player.seekTo(target.seconds, true);
                else video.currentTime = target.seconds;
                return 'seeking';
              }
              return video.seeking ? 'seeking' : 'done';
            })();`);
            if (task !== generation) return;
            if (outcome === 'done') { status('', false); return; }
            if (outcome === 'out-of-range') { status('The requested time is beyond the end of this video.', true); return; }
          } catch {}
          if (task !== generation) return;
          if (Date.now() >= deadline) { status('Could not seek to the requested time. Check the video or try the link again.', true); return; }
          timer = setTimeout(seek, pollMs);
        }
        void seek();
      },
    };
  }
  return { createNavigator };
});

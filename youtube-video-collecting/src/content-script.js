// Content script for YouTube page injection
// This script runs in the YouTube WebView and detects markers

(function () {
  let videoElement = null;
  let timelineMarkers = [];

  // Function to find video element
  function getVideoElement() {
    if (videoElement && videoElement.offsetParent !== null) {
      return videoElement;
    }

    const videos = document.querySelectorAll('video');
    for (let video of videos) {
      if (video.offsetParent !== null) {
        videoElement = video;
        return video;
      }
    }
    return null;
  }

  // Function to format time as mm:ss
  function formatTime(seconds) {
    if (!seconds || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  // Listen for comma key press to add marker
  document.addEventListener('keydown', (e) => {
    if (e.key === ',') {
      const video = getVideoElement();
      if (video) {
        const currentTime = video.currentTime;
        const duration = video.duration;

        if (isFinite(currentTime) && isFinite(duration)) {
          const marker = {
            time: currentTime,
            formatted: formatTime(currentTime),
          };

          timelineMarkers.push(marker);

          // Send marker to main process
          window.electronAPI?.sendMarker?.(marker);

          // Create visual marker on timeline
          createTimelineMarker(currentTime, duration);

          // Visual feedback
          showNotification(marker.formatted);
        }
      }
    }
  });

  // Create visual marker on timeline
  function createTimelineMarker(currentTime, duration) {
    try {
      const progressBar = document.querySelector(
        '[class*="progress"][class*="bar"],' +
          'div[class*="ytp-progress"],' +
          '.ytp-progress-bar'
      );

      if (!progressBar) return;

      const percent = (currentTime / duration) * 100;

      // Create marker element
      const marker = document.createElement('div');
      marker.className = 'yt-collector-marker';
      marker.style.cssText = `
        position: absolute;
        left: ${percent}%;
        width: 3px;
        height: 100%;
        background-color: #ff6b6b;
        cursor: pointer;
        z-index: 1000;
        transform: translateX(-50%);
      `;

      marker.title = `${formatTime(currentTime)}`;
      marker.dataset.time = currentTime;

      // Add hover tooltip
      marker.addEventListener('mouseenter', (e) => {
        const tooltip = document.createElement('div');
        tooltip.style.cssText = `
          position: absolute;
          bottom: 100%;
          background-color: rgba(0, 0, 0, 0.8);
          color: white;
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 12px;
          white-space: nowrap;
          pointer-events: none;
          left: 50%;
          transform: translateX(-50%);
        `;
        tooltip.textContent = formatTime(currentTime);
        marker.appendChild(tooltip);
      });

      marker.addEventListener('mouseleave', () => {
        const tooltip = marker.querySelector('div');
        if (tooltip) tooltip.remove();
      });

      // Click to jump
      marker.addEventListener('click', (e) => {
        e.preventDefault();
        const video = getVideoElement();
        if (video) {
          video.currentTime = currentTime;
        }
      });

      // Right-click to remove
      marker.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        marker.remove();
        timelineMarkers = timelineMarkers.filter((m) => m.time !== currentTime);
      });

      progressBar.appendChild(marker);
    } catch (err) {
      console.error('Error creating timeline marker:', err);
    }
  }

  // Show notification
  function showNotification(text) {
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background-color: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 12px 20px;
      border-radius: 6px;
      font-size: 14px;
      z-index: 10000;
      pointer-events: none;
      animation: slideIn 0.3s ease-out;
    `;
    notification.textContent = `Marker: ${text}`;

    // Add animation
    const style = document.createElement('style');
    style.textContent = `
      @keyframes slideIn {
        from {
          opacity: 0;
          transform: translateX(20px);
        }
        to {
          opacity: 1;
          transform: translateX(0);
        }
      }
    `;
    if (!document.querySelector('style[data-notification]')) {
      style.setAttribute('data-notification', 'true');
      document.head.appendChild(style);
    }

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.style.animation = 'slideOut 0.3s ease-out';
      notification.style.opacity = '0';
      setTimeout(() => notification.remove(), 300);
    }, 2000);
  }

  // Expose API on window for renderer to access
  window.getVideoMarkers = () => timelineMarkers;
  window.clearMarkers = () => {
    timelineMarkers = [];
    document.querySelectorAll('.yt-collector-marker').forEach((m) => m.remove());
  };
  window.getVideoUrl = () => window.location.href;
  window.getMarkerTimestamps = () => timelineMarkers.map((m) => m.time);

  console.log('[YouTube Collector] Content script loaded');
})();

// YouTube Shorts Blocker - runs in webview context
(function () {
  'use strict';

  const config = {
    c_removeFormStartPage: true,
    c_removeFormSubscriptionFeed: true,
    c_removeFormAllFeeds: true,
    c_removeFormFollowUp: true,
    c_removeFormChannel: true,
    c_removeSidebar: true,
    c_disableShortPage: true,
    c_disableShortPageScrolling: true,
    c_removeFormSearch: true,
  };

  function log(message) {
    console.log('[YouTube Shorts Blocker] ' + message);
  }

  const youtubeStartPagePattern = /^https?:\/\/(www\.)?youtube\.com\/?$/;
  const youtubeFeedPagePattern = /^https?:\/\/(www\.)?youtube\.com\/((feed)|(gaming))(?!\/subscriptions.*).*$/;
  const youtubeSubscriptionsPagePattern = /^https?:\/\/(www\.)?youtube\.com\/feed\/subscriptions\/?$/;
  const youtubeWatchPagePattern = /^https?:\/\/(www\.)?youtube\.com\/watch\/?.*$/;
  const youtubeShortPagePattern = /^https?:\/\/(www\.)?youtube\.com\/shorts.*$/;
  const youtubeSearchPagePattern = /^https?:\/\/(www\.)?youtube\.com\/results.*$/;
  const youtubeChannelPagePattern = /^https?:\/\/(www\.)?youtube\.com\/(?!feed.*)(?!watch.*)(?!short.*)(?!playlist.*)(?!podcasts.*)(?!gaming.*)(?!results.*).+$/;
  const youtubeChannelShortsPagePattern = /^(https?:\/\/(?:www\.)?youtube\.com\/(?!feed.*)(?!watch.*)(?!short.*)(?!playlist.*)(?!podcasts.*)(?!gaming.*)(?!results.*).+)\/shorts\/?$/;

  if (config.c_disableShortPageScrolling) {
    function handleScroll(event) {
      if (youtubeShortPagePattern.test(window.location.href)) {
        if (event.target && event.target.closest && (event.target.closest('#comments') || event.target.closest('ytd-engagement-panel-section-list-renderer'))) {
          return;
        }
        log("Scrolling disabled on shorts page.");
        window.location.href = 'https://www.youtube.com/';
        event.preventDefault();
      }
    }
    window.addEventListener('scroll', handleScroll);
    window.addEventListener('wheel', handleScroll);
  }

  function removeFormVideoOverview() {
    const elementsToRemove = document.querySelectorAll('[is-shorts],[is-reel-item-style-avatar-circle],ytd-reel-item-renderer');
    elementsToRemove.forEach(element => {
      if (element.parentNode) element.parentNode.removeChild(element);
    });
  }

  function removeSidebarElement() {
    const elementsToRemove = document.querySelectorAll('.yt-simple-endpoint[title="Shorts"]');
    elementsToRemove.forEach(element => {
      if (element.parentNode && element.parentNode.parentNode) {
        element.parentNode.parentNode.removeChild(element.parentNode);
      }
    });
  }

  function removeReelShelfRenderer() {
    const elementsToRemove = document.querySelectorAll('ytd-reel-shelf-renderer,grid-shelf-view-model');
    elementsToRemove.forEach(element => {
      if (element.parentNode) element.parentNode.removeChild(element);
    });
  }

  function removeByUrl() {
    const elementsToRemove = document.querySelectorAll('ytd-video-renderer:has([href*="/shorts/"])');
    elementsToRemove.forEach(element => {
      if (element.parentNode) element.parentNode.removeChild(element);
    });
  }

  function removeShorts() {
    const currentURL = window.location.href;

    if (config.c_removeSidebar) {
      removeSidebarElement();
    }

    if (youtubeShortPagePattern.test(currentURL) && config.c_disableShortPage) {
      window.location.href = 'https://www.youtube.com/';
      log("Shorts page - redirecting to home.");
      return;
    }

    if (youtubeStartPagePattern.test(currentURL) && config.c_removeFormStartPage) {
      removeFormVideoOverview();
      log("Shorts removed from home page.");
    }

    if (youtubeFeedPagePattern.test(currentURL) && config.c_removeFormAllFeeds) {
      removeReelShelfRenderer();
      removeFormVideoOverview();
      log("Shorts removed from feed.");
    }

    if (youtubeSubscriptionsPagePattern.test(currentURL) && config.c_removeFormSubscriptionFeed) {
      removeFormVideoOverview();
      log("Shorts removed from subscriptions.");
    }

    if (youtubeWatchPagePattern.test(currentURL) && config.c_removeFormFollowUp) {
      removeReelShelfRenderer();
      log("Shorts removed from watch page.");
    }

    if (youtubeChannelPagePattern.test(currentURL) && config.c_removeFormChannel) {
      const match = youtubeChannelShortsPagePattern.exec(currentURL);
      if (match) {
        window.location.href = match[1];
        return;
      }
      removeReelShelfRenderer();
      removeFormVideoOverview();
      const elementsToRemove = document.querySelectorAll('[tab-title="Shorts"]');
      elementsToRemove.forEach(element => {
        element.style.display = "none";
      });
      log("Shorts removed from channel.");
    }

    if (youtubeSearchPagePattern.test(currentURL) && config.c_removeFormSearch) {
      removeReelShelfRenderer();
      removeFormVideoOverview();
      removeByUrl();
      log("Shorts removed from search.");
    }
  }

  let timeoutId;
  function handleMutations(mutationsList, observer) {
    for (let mutation of mutationsList) {
      if (mutation.target.id === "progress" || mutation.target.tagName === "YTD-VIDEO-RENDERER" || 
          (mutation.target.parentElement && (mutation.target.parentElement.id === "page-manager" || mutation.target.parentElement.id === "primary"))) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          removeShorts();
          log("Shorts removed after mutation.");
        }, 300);
        break;
      }
    }
  }

  const observer = new MutationObserver(handleMutations);
  const targetNode = document.querySelector('#page-manager');
  
  if (targetNode) {
    observer.observe(targetNode, { childList: true, attributes: true, subtree: true });
    log("Mutation observer started.");
  }

  removeShorts();
  log("✅ YouTube Shorts Blocker active!");
})();

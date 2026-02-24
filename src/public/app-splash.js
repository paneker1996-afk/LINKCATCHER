(function () {
  var config = window.__LINKCATCHER_SPLASH__ || {};
  if (!config.enabled) {
    return;
  }

  var splash = document.getElementById('app-splash');
  if (!splash) {
    return;
  }

  var tg = window.Telegram && window.Telegram.WebApp;
  var isTelegramMiniApp = Boolean(tg && typeof tg.initData === 'string');
  if (!isTelegramMiniApp) {
    splash.remove();
    return;
  }

  if (config.oncePerSession !== false) {
    try {
      if (sessionStorage.getItem('lc_splash_seen') === '1') {
        splash.remove();
        return;
      }
      sessionStorage.setItem('lc_splash_seen', '1');
    } catch (_error) {
      // Ignore sessionStorage restrictions and continue.
    }
  }

  var video = document.getElementById('app-splash-video');
  var MIN_SHOW_MS = Number(config.minShowMs) > 0 ? Number(config.minShowMs) : 1100;
  var MAX_SHOW_MS = Number(config.maxShowMs) > 0 ? Number(config.maxShowMs) : 2200;
  var FADE_MS = 280;
  var startTs = Date.now();
  var closed = false;

  function hideSplash() {
    if (closed) {
      return;
    }

    closed = true;
    var elapsed = Date.now() - startTs;
    var delay = Math.max(0, MIN_SHOW_MS - elapsed);

    setTimeout(function () {
      splash.classList.add('is-hiding');
      setTimeout(function () {
        splash.remove();
      }, FADE_MS + 30);
    }, delay);
  }

  setTimeout(hideSplash, MAX_SHOW_MS);

  if (video) {
    video.currentTime = 0;
    try {
      var playPromise = video.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(function () {
          // If autoplay is blocked, keep splash briefly and close.
        });
      }
    } catch (_error) {}

    video.addEventListener('ended', hideSplash, { once: true });
    video.addEventListener('error', hideSplash, { once: true });
  }

  try {
    tg.ready();
    tg.expand();
  } catch (_error) {
    // Ignore Telegram API issues and keep fallback timer.
  }
})();

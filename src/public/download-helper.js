(function () {
  function isTelegramMiniApp() {
    return Boolean(window.Telegram && window.Telegram.WebApp);
  }

  function openDownloadOutsideTelegram(url) {
    var tg = window.Telegram && window.Telegram.WebApp;
    if (tg && typeof tg.openLink === 'function') {
      try {
        tg.openLink(url, { try_browser: true, try_instant_view: false });
        return true;
      } catch (_error) {
        // Fallback to window.open below.
      }
    }

    try {
      window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    } catch (_error) {
      return false;
    }
  }

  function extractItemIdFromDownloadHref(href) {
    if (typeof href !== 'string' || href.length === 0) {
      return null;
    }
    var path;
    try {
      path = new URL(href, window.location.origin).pathname;
    } catch (_error) {
      return null;
    }
    var match = path.match(/^\/download\/([a-zA-Z0-9-]{1,100})$/);
    return match ? match[1] : null;
  }

  async function resolveSignedDownloadUrl(href) {
    var itemId = extractItemIdFromDownloadHref(href);
    if (!itemId) {
      return new URL(href, window.location.origin).toString();
    }

    var response = await fetch('/api/download-link/' + encodeURIComponent(itemId), {
      method: 'GET',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error('Не удалось подготовить ссылку для скачивания.');
    }

    var payload = await response.json();
    if (!payload || typeof payload.url !== 'string' || payload.url.trim().length === 0) {
      throw new Error('Некорректный ответ сервера при подготовке скачивания.');
    }

    return new URL(payload.url, window.location.origin).toString();
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    var link = target.closest('a.link-download');
    if (!(link instanceof HTMLAnchorElement)) {
      return;
    }

    var href = link.getAttribute('href');
    if (!href || !isTelegramMiniApp()) {
      return;
    }

    event.preventDefault();
    link.classList.add('is-pending');

    resolveSignedDownloadUrl(href)
      .then(function (downloadUrl) {
        openDownloadOutsideTelegram(downloadUrl);
      })
      .catch(function (_error) {
        var fallbackUrl = new URL(href, window.location.origin).toString();
        openDownloadOutsideTelegram(fallbackUrl);
      })
      .finally(function () {
        link.classList.remove('is-pending');
      });
  });
})();

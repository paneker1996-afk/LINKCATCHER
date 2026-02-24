(function () {
  function isTelegramMiniApp() {
    return Boolean(window.Telegram && window.Telegram.WebApp);
  }

  function showMessage(message) {
    var text = typeof message === 'string' && message.trim() ? message.trim() : 'Операция выполнена.';
    var tg = window.Telegram && window.Telegram.WebApp;
    if (tg && typeof tg.showAlert === 'function') {
      try {
        tg.showAlert(text);
        return;
      } catch (_error) {
        // Fallback to alert below.
      }
    }
    window.alert(text);
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

  function extractItemIdFromTelegramTarget(target) {
    if (!(target instanceof Element)) {
      return null;
    }
    var trigger = target.closest('.link-send-telegram');
    if (!trigger) {
      return null;
    }
    var itemId = trigger.getAttribute('data-telegram-id');
    if (typeof itemId !== 'string' || !itemId.trim()) {
      return null;
    }
    return itemId.trim();
  }

  async function sendItemToTelegram(itemId) {
    var response = await fetch('/api/telegram/send/' + encodeURIComponent(itemId), {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    });

    var payload = null;
    try {
      payload = await response.json();
    } catch (_error) {
      payload = null;
    }

    if (!response.ok) {
      var reason = payload && payload.error ? payload.error : 'Не удалось отправить файл в Telegram.';
      throw new Error(reason);
    }

    return payload && payload.message ? payload.message : 'Файл отправлен в Telegram.';
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    var telegramItemId = extractItemIdFromTelegramTarget(target);
    if (telegramItemId) {
      event.preventDefault();

      var button = target.closest('.link-send-telegram');
      if (button) {
        button.classList.add('is-pending');
        button.setAttribute('aria-busy', 'true');
      }

      sendItemToTelegram(telegramItemId)
        .then(function (message) {
          showMessage(message);
        })
        .catch(function (error) {
          var reason = error instanceof Error ? error.message : 'Не удалось отправить файл в Telegram.';
          showMessage(reason);
        })
        .finally(function () {
          if (button) {
            button.classList.remove('is-pending');
            button.removeAttribute('aria-busy');
          }
        });
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
    link.setAttribute('aria-busy', 'true');

    var itemIdFromLink = extractItemIdFromDownloadHref(href);
    var sendPromise = itemIdFromLink ? sendItemToTelegram(itemIdFromLink) : Promise.reject(new Error('No item id'));

    sendPromise
      .then(function (message) {
        showMessage(message);
      })
      .catch(function () {
        // Fallback: open regular download URL outside Telegram.
        return resolveSignedDownloadUrl(href)
          .then(function (downloadUrl) {
            openDownloadOutsideTelegram(downloadUrl);
          })
          .catch(function () {
            var fallbackUrl = new URL(href, window.location.origin).toString();
            openDownloadOutsideTelegram(fallbackUrl);
          });
      })
      .finally(function () {
        link.classList.remove('is-pending');
        link.removeAttribute('aria-busy');
      });
  });
})();

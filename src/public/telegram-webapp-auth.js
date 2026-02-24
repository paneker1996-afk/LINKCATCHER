(function () {
  var config = window.__LINKCATCHER_TELEGRAM__;
  if (!config || !config.enabled) {
    return;
  }

  var banner = document.getElementById('telegram-auth-banner');
  var body = document.body;

  function setBanner(message, isError) {
    if (!banner) {
      return;
    }

    banner.hidden = false;
    banner.textContent = message;
    banner.classList.toggle('is-error', Boolean(isError));
  }

  function clearBanner() {
    if (!banner) {
      return;
    }

    banner.hidden = true;
    banner.textContent = '';
    banner.classList.remove('is-error');
  }

  function lockUi() {
    body.classList.add('telegram-auth-locked');
  }

  function unlockUi() {
    body.classList.remove('telegram-auth-locked');
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    var controller = new AbortController();
    var timeout = setTimeout(function () {
      controller.abort();
    }, timeoutMs);

    try {
      var merged = Object.assign({}, options || {}, {
        signal: controller.signal
      });
      return await fetch(url, merged);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function getSessionUser(timeoutMs) {
    try {
      var response = await fetchWithTimeout(
        '/api/telegram/me',
        {
          method: 'GET',
          credentials: 'same-origin'
        },
        timeoutMs
      );

      if (!response.ok) {
        return null;
      }

      var payload = await response.json();
      if (!payload || !payload.authenticated || !payload.user) {
        return null;
      }

      return payload.user;
    } catch (_error) {
      return null;
    }
  }

  function dispatchAuthReady(user) {
    window.dispatchEvent(
      new CustomEvent('telegram-auth-ready', {
        detail: {
          user: user
        }
      })
    );
  }

  async function authWithInitData(timeoutMs) {
    var tg = window.Telegram && window.Telegram.WebApp;
    if (!tg) {
      throw new Error('Откройте LinkCatcher через Telegram Mini App.');
    }

    try {
      tg.ready();
      tg.expand();
    } catch (_error) {
      // ignore
    }

    var initData = typeof tg.initData === 'string' ? tg.initData.trim() : '';
    if (!initData) {
      throw new Error('Telegram initData не получен. Откройте Mini App из бота заново.');
    }

    var response = await fetchWithTimeout(
      '/api/telegram/auth',
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          initData: initData
        })
      },
      timeoutMs
    );

    var payload = null;
    try {
      payload = await response.json();
    } catch (_error) {
      payload = null;
    }

    if (!response.ok || !payload || payload.ok !== true) {
      var reason = payload && payload.error ? payload.error : 'Авторизация Telegram не удалась.';
      throw new Error(reason);
    }

    return payload.user || null;
  }

  async function bootstrapTelegramAuth() {
    var timeoutMs = Number(config.requestTimeoutMs) > 0 ? Number(config.requestTimeoutMs) : 12000;

    lockUi();
    setBanner('Проверка Telegram авторизации...', false);

    var existingUser = await getSessionUser(timeoutMs);
    if (existingUser) {
      unlockUi();
      clearBanner();
      dispatchAuthReady(existingUser);
      return;
    }

    try {
      var user = await authWithInitData(timeoutMs);
      unlockUi();
      clearBanner();
      if (user) {
        dispatchAuthReady(user);
      }
    } catch (error) {
      var message = error instanceof Error ? error.message : 'Авторизация Telegram не удалась.';
      setBanner(message, true);
    }
  }

  bootstrapTelegramAuth();
})();

'use strict';

const fs = require('fs');
const path = require('path');

function loadDotEnvIfExists() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed;
    const separatorIndex = normalized.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    if (process.env[key] !== undefined) {
      continue;
    }

    let value = normalized.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnvIfExists();

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const WEBAPP_URL = (process.env.WEBAPP_URL || '').trim();
const TELEGRAM_ENABLED = /^(1|true|yes)$/i.test((process.env.TELEGRAM_ENABLED || 'false').trim());
const BOT_POLL_TIMEOUT_SECONDS = 30;

if (!TELEGRAM_ENABLED) {
  console.log('[telegram-bot] TELEGRAM_ENABLED=false, bot is disabled.');
  process.exit(0);
}

if (!BOT_TOKEN) {
  console.error('[telegram-bot] BOT_TOKEN is required.');
  process.exit(1);
}

if (!WEBAPP_URL || !/^https:\/\//i.test(WEBAPP_URL)) {
  console.error('[telegram-bot] WEBAPP_URL must be an https:// URL.');
  process.exit(1);
}

const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
let offset = 0;
let isShuttingDown = false;

function withQuery(url, params) {
  const result = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    result.searchParams.set(key, String(value));
  }
  return result.toString();
}

async function tgApi(method, payload, timeoutMs) {
  var requestTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000;
  const response = await fetch(`${API_BASE}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(requestTimeoutMs)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram API ${method} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Telegram API ${method} error: ${JSON.stringify(result).slice(0, 500)}`);
  }

  return result.result;
}

function parseStartRef(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const match = text.trim().match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  if (!match) {
    return null;
  }

  const ref = (match[1] || '').trim();
  if (!ref) {
    return null;
  }

  return ref.slice(0, 128);
}

function buildWebAppUrl(ref) {
  if (!ref) {
    return WEBAPP_URL;
  }

  return withQuery(WEBAPP_URL, { ref });
}

async function configureMenuButton(chatId) {
  await tgApi('setChatMenuButton', {
    chat_id: chatId,
    menu_button: {
      type: 'web_app',
      text: 'Открыть LinkCatcher',
      web_app: {
        url: WEBAPP_URL
      }
    }
  });
}

async function handleStartMessage(message) {
  const chatId = message.chat?.id;
  if (!chatId) {
    return;
  }

  const ref = parseStartRef(message.text);
  const webAppUrl = buildWebAppUrl(ref);

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: 'Откройте LinkCatcher в Mini App:',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: 'Открыть LinkCatcher',
            web_app: {
              url: webAppUrl
            }
          }
        ]
      ]
    }
  });

  try {
    await configureMenuButton(chatId);
  } catch (error) {
    console.warn('[telegram-bot] setChatMenuButton(chat scoped) failed:', error instanceof Error ? error.message : error);
  }
}

async function processUpdate(update) {
  const message = update.message;
  if (!message || typeof message.text !== 'string') {
    return;
  }

  if (/^\/start(?:@\w+)?(?:\s+.*)?$/i.test(message.text.trim())) {
    await handleStartMessage(message);
  }
}

async function bootstrap() {
  console.log('[telegram-bot] Starting polling bot...');
  await tgApi('deleteWebhook', { drop_pending_updates: false });
  await tgApi('setMyCommands', {
    commands: [
      {
        command: 'start',
        description: 'Открыть LinkCatcher'
      }
    ]
  });

  try {
    await tgApi('setChatMenuButton', {
      menu_button: {
        type: 'web_app',
        text: 'Открыть LinkCatcher',
        web_app: {
          url: WEBAPP_URL
        }
      }
    });
  } catch (error) {
    console.warn('[telegram-bot] setChatMenuButton(default) failed:', error instanceof Error ? error.message : error);
  }

  while (!isShuttingDown) {
    try {
      const updates = await tgApi(
        'getUpdates',
        {
          offset,
          timeout: BOT_POLL_TIMEOUT_SECONDS,
          allowed_updates: ['message']
        },
        (BOT_POLL_TIMEOUT_SECONDS + 10) * 1000
      );

      if (!Array.isArray(updates) || updates.length === 0) {
        continue;
      }

      for (const update of updates) {
        offset = Math.max(offset, Number(update.update_id || 0) + 1);
        try {
          await processUpdate(update);
        } catch (error) {
          console.error('[telegram-bot] Failed to process update:', error instanceof Error ? error.message : error);
        }
      }
    } catch (error) {
      console.error('[telegram-bot] Polling cycle error:', error instanceof Error ? error.message : error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.log('[telegram-bot] Stopped.');
}

process.on('SIGINT', () => {
  isShuttingDown = true;
});

process.on('SIGTERM', () => {
  isShuttingDown = true;
});

bootstrap().catch((error) => {
  console.error('[telegram-bot] Fatal error:', error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});

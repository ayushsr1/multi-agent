import { requireEnv } from '../config.js';
import { errMsg, log, trunc } from '../util.js';
import type { Notifier } from './types.js';

const telegram = (): Notifier => {
  const token = requireEnv('TELEGRAM_BOT_TOKEN');
  const chatId = requireEnv('TELEGRAM_CHAT_ID');
  return {
    name: 'telegram',
    async notify(title, text) {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: trunc(`${title}\n\n${text}`, 4000) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Telegram ${res.status}`);
    },
  };
};

/** Generic webhook; payload carries `text` (Slack) and `content` (Discord) so either accepts it. */
const webhook = (): Notifier => {
  const url = requireEnv('WEBHOOK_URL');
  return {
    name: 'webhook',
    async notify(title, text) {
      const msg = trunc(`${title}\n\n${text}`, 1900);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, text: msg, content: msg }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Webhook ${res.status}`);
    },
  };
};

const FACTORIES = { telegram, webhook };

/** Sends a test message through each notifier and reports each result separately (the live notifier hides failures). */
export async function testNotifiers(names: (keyof typeof FACTORIES)[]) {
  const out: { name: string; ok: boolean; error?: string }[] = [];
  for (const name of names) {
    try {
      await FACTORIES[name]().notify('Test from your outreach agent', 'If you can read this, notifications work.');
      out.push({ name, ok: true });
    } catch (e) {
      out.push({ name, ok: false, error: errMsg(e) });
    }
  }
  return out;
}

/**
 * Finds your Telegram chat id: send any message to your bot first, then call this.
 * Uses the most recent chat that messaged the bot.
 */
export async function detectTelegramChat(): Promise<{ id: string; name: string }> {
  const token = requireEnv('TELEGRAM_BOT_TOKEN');
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=20`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 404 ? 'Telegram rejected the bot token' : `Telegram ${res.status}`);
  const data = (await res.json()) as {
    result?: { message?: { chat?: { id: number; first_name?: string; title?: string; username?: string } } }[];
  };
  const chats = (data.result ?? []).map((u) => u.message?.chat).filter((c): c is NonNullable<typeof c> => !!c);
  const chat = chats[chats.length - 1];
  if (!chat) throw new Error('No messages found. Open your bot in Telegram, press Start (or send "hi"), then try again.');
  return { id: String(chat.id), name: chat.first_name ?? chat.title ?? chat.username ?? String(chat.id) };
}

/** Fans out to all configured notifiers; always logs to console; never throws. */
export function createNotifier(names: (keyof typeof FACTORIES)[], consoleOnly: boolean): Notifier {
  const targets = consoleOnly ? [] : names.map((n) => FACTORIES[n]());
  return {
    name: 'multi',
    async notify(title, text) {
      log.info('notify', `${title}\n${text}`);
      const results = await Promise.allSettled(targets.map((t) => t.notify(title, text)));
      results.forEach((r, i) => {
        if (r.status === 'rejected') log.warn('notify', `${targets[i].name} failed: ${errMsg(r.reason)}`);
      });
    },
  };
}

import type { Ctx } from '../ctx.js';
import { isSuppressed, kvGet, kvSet, type EmailRow } from '../db.js';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { errMsg, log, now, rand } from '../util.js';

const DAY = 86_400_000;

function localParts(tz: string): { hour: number; weekday: string } {
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }).format(new Date());
  return { hour: Number(f({ hour: 'numeric', hour12: false })) % 24, weekday: f({ weekday: 'short' }) };
}

function inSendWindow(s: Config['sending']): boolean {
  const { hour, weekday } = localParts(s.timezone);
  if (s.weekdaysOnly && (weekday === 'Sat' || weekday === 'Sun')) return false;
  return hour >= s.hours[0] && hour < s.hours[1];
}

/** Warm-up: start low and ramp daily so the sending domain builds reputation. */
export function dailyCap(db: DB, s: Config['sending']): number {
  const first = (db.prepare(`SELECT MIN(sent_at) AS t FROM emails WHERE status IN ('sent','dry_run')`).get() as { t: number | null }).t;
  const days = first ? Math.floor((now() - first) / DAY) : 0;
  return Math.min(s.maxPerDay, s.startPerDay + s.rampPerDay * days);
}

export async function sendNext({ cfg, db, channel, notifier, dry }: Ctx) {
  const s = cfg.sending;
  if (Number(kvGet(db, 'paused_until') ?? 0) > now()) return;
  if (!inSendWindow(s) || Number(kvGet(db, 'next_send_at') ?? 0) > now()) return;

  const sent24 = (db.prepare(`SELECT COUNT(*) AS n FROM emails WHERE status IN ('sent','dry_run') AND sent_at > ?`).get(now() - DAY) as { n: number }).n;
  if (sent24 >= dailyCap(db, s)) return;

  const row = db
    .prepare(
      `SELECT e.*, l.email AS to_email, l.company AS company FROM emails e JOIN leads l ON l.id = e.lead_id
       WHERE e.status = 'queued' ORDER BY e.id LIMIT 1`,
    )
    .get() as (EmailRow & { to_email: string; company: string }) | undefined;
  if (!row) return;

  if (isSuppressed(db, row.to_email)) {
    db.prepare(`UPDATE emails SET status = 'skipped' WHERE id = ?`).run(row.id);
    return;
  }

  const signature = `${cfg.sender.name}${cfg.sender.title ? `\n${cfg.sender.title}` : ''}`;
  const body = `${row.body.trim()}\n\n${signature}\n\n--\n${cfg.sender.footer}`;

  try {
    if (dry) {
      log.info('send', `[dry-run] to ${row.to_email} (${row.company})\nSubject: ${row.subject}\n\n${body}\n`);
      db.prepare(`UPDATE emails SET status = 'dry_run', sent_at = ? WHERE id = ?`).run(now(), row.id);
    } else {
      const { messageId } = await channel.send({ to: row.to_email, subject: row.subject, body });
      db.prepare(`UPDATE emails SET status = 'sent', message_id = ?, sent_at = ? WHERE id = ?`).run(messageId, now(), row.id);
      log.info('send', `sent to ${row.to_email} (${row.company}, angle=${row.angle_id})`);
    }
    db.prepare(`UPDATE leads SET status = 'sent', updated_at = ? WHERE id = ?`).run(now(), row.lead_id);
    kvSet(db, 'send_failures', 0);
    kvSet(db, 'next_send_at', now() + rand(s.minGapMinutes, s.maxGapMinutes) * 60_000);
  } catch (e) {
    const fails = Number(kvGet(db, 'send_failures') ?? 0) + 1;
    kvSet(db, 'send_failures', fails);
    log.error('send', errMsg(e));
    if (fails >= 3) {
      kvSet(db, 'paused_until', now() + 6 * 3_600_000);
      kvSet(db, 'send_failures', 0);
      await notifier.notify('Sending paused', `3 consecutive send failures. Pausing 6h. Last error: ${errMsg(e)}`);
    }
  }
}

import { angleStats } from '../learning/bandit.js';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { dailyCap } from '../stages/send.js';

const DAY = 86_400_000;

/** Everything the dashboard shows, from one read-only database connection. */
export function collectStats(db: DB, cfg: Config | null) {
  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const leads = Object.fromEntries(
    (db.prepare(`SELECT status, COUNT(*) AS n FROM leads GROUP BY status`).all() as { status: string; n: number }[]).map((r) => [r.status, r.n]),
  );
  const outcomes = Object.fromEntries(
    (db.prepare(`SELECT outcome, COUNT(*) AS n FROM emails WHERE status IN ('sent','dry_run') GROUP BY outcome`).all() as { outcome: string; n: number }[]).map((r) => [r.outcome, r.n]),
  );
  const sentToday = count(`SELECT COUNT(*) AS n FROM emails WHERE status IN ('sent','dry_run') AND sent_at > ?`, Date.now() - DAY);

  return {
    leads,
    outcomes,
    emails: {
      sentTotal: count(`SELECT COUNT(*) AS n FROM emails WHERE status IN ('sent','dry_run')`),
      sentToday,
      dailyCap: cfg ? dailyCap(db, cfg.sending) : null,
      queued: count(`SELECT COUNT(*) AS n FROM emails WHERE status = 'queued'`),
    },
    angles: angleStats(db, cfg?.quality.settleDays ?? 7).map((a) => ({
      id: a.id,
      description: a.description,
      source: a.source,
      wins: a.wins,
      losses: a.losses,
    })),
    replies: db
      .prepare(
        `SELECT e.id, e.outcome, e.reply_text AS reply, e.replied_at AS at, e.subject, l.name, l.company, l.email
         FROM emails e JOIN leads l ON l.id = e.lead_id
         WHERE e.outcome IN ('positive','question','other','negative','unsubscribe')
         ORDER BY e.replied_at DESC LIMIT 30`,
      )
      .all(),
    emails_recent: db
      .prepare(
        `SELECT e.id, e.status, e.outcome, e.angle_id AS angle, e.critic_score AS score, e.subject, e.body, e.sent_at AS sentAt,
                e.created_at AS createdAt, l.name, l.company, l.email
         FROM emails e JOIN leads l ON l.id = e.lead_id ORDER BY e.id DESC LIMIT 30`,
      )
      .all(),
    pipeline: db
      .prepare(`SELECT id, name, role, company, status, note FROM leads ORDER BY id DESC LIMIT 40`)
      .all(),
  };
}

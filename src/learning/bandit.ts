import type { AngleRow, DB } from '../db.js';

function normal(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Marsaglia-Tsang gamma sampler; valid for shape >= 1 (always true for Beta(1+w, 1+l)). */
function gamma(shape: number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      x = normal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v ** 3;
    const u = Math.random();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

const beta = (a: number, b: number) => {
  const x = gamma(a);
  return x / (x + gamma(b));
};

interface Stat extends AngleRow {
  wins: number;
  losses: number;
}

/**
 * Win = positive reply or question. Loss = negative/unsubscribe, or no reply after `settleDays`.
 * Bounces, auto-replies and still-pending emails are excluded (not the angle's fault / unknown yet).
 */
export function angleStats(db: DB, settleDays: number): Stat[] {
  const cutoff = Date.now() - settleDays * 86_400_000;
  return db
    .prepare(
      `SELECT a.*,
         COALESCE(SUM(CASE WHEN e.outcome IN ('positive','question') THEN 1 ELSE 0 END), 0) AS wins,
         COALESCE(SUM(CASE WHEN e.outcome IN ('negative','unsubscribe')
                            OR (e.outcome = 'none' AND e.sent_at < @cutoff) THEN 1 ELSE 0 END), 0) AS losses
       FROM angles a
       LEFT JOIN emails e ON e.angle_id = a.id AND e.status = 'sent'
       WHERE a.active = 1
       GROUP BY a.id`,
    )
    .all({ cutoff }) as Stat[];
}

/** Thompson sampling: mostly exploits the best angle, keeps exploring uncertain ones (incl. new explorer ideas). */
export function chooseAngle(db: DB, settleDays: number): AngleRow {
  const stats = angleStats(db, settleDays);
  if (!stats.length) throw new Error('No active angles');
  let best = stats[0];
  let bestDraw = -1;
  for (const s of stats) {
    const draw = beta(1 + s.wins, 1 + s.losses);
    if (draw > bestDraw) [best, bestDraw] = [s, draw];
  }
  return best;
}

/** Keeps the arm list bounded: deactivates proven under-performers once there are too many active angles. */
export function retireWeakAngles(db: DB, settleDays: number, maxActive = 12, minSamples = 12): string[] {
  const stats = angleStats(db, settleDays);
  const excess = stats.length - maxActive;
  if (excess <= 0) return [];
  const retired = stats
    .filter((s) => s.wins + s.losses >= minSamples)
    .sort((a, b) => a.wins / (a.wins + a.losses) - b.wins / (b.wins + b.losses))
    .slice(0, excess)
    .map((s) => s.id);
  for (const id of retired) db.prepare('UPDATE angles SET active = 0 WHERE id = ?').run(id);
  return retired;
}

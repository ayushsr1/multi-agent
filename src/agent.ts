import path from 'node:path';
import { backupDb } from './backup.js';
import { closeBrowser } from './browser.js';
import { createEmailChannel } from './channels/email.js';
import { createNotifier } from './channels/notifiers.js';
import type { Channel } from './channels/types.js';
import { loadConfig, requireEnv, type Config } from './config.js';
import type { Ctx } from './ctx.js';
import { kvGet, kvSet, openDb } from './db.js';
import { initLlm, LlmBusy, resolveModels } from './llm.js';
import { discover } from './stages/discover.js';
import { draft } from './stages/draft.js';
import { enrich } from './stages/enrich.js';
import { explore } from './stages/explore.js';
import { pollReplies } from './stages/replies.js';
import { research } from './stages/research.js';
import { dailyCap, sendNext } from './stages/send.js';
import { errMsg, log } from './util.js';

export const dbPath = (dry: boolean) => path.resolve(dry ? 'data/dry-run.db' : 'data/agent.db');

export interface AgentState {
  status: 'stopped' | 'starting' | 'running' | 'stopping';
  mode: 'live' | 'dry' | null;
  error: string | null;
  since: number | null;
}

let state: AgentState = { status: 'stopped', mode: null, error: null, since: null };
let stopFn: (() => Promise<void>) | undefined;

export const getState = (): AgentState => ({ ...state });

/** Forgets the last start failure (called after settings are saved, since they may have fixed it). */
export const clearAgentError = () => {
  if (state.status === 'stopped') state = { ...state, error: null };
};

const noChannel: Channel = {
  name: 'none',
  send: async () => {
    throw new Error('dry run');
  },
  pollInbound: async () => [],
};

export async function startAgent(dry: boolean): Promise<void> {
  if (state.status !== 'stopped') throw new Error(`Agent is already ${state.status}`);
  state = { status: 'starting', mode: dry ? 'dry' : 'live', error: null, since: null };
  try {
    stopFn = await build(loadConfig(), dry);
    state = { ...state, status: 'running', since: Date.now() };
  } catch (e) {
    state = { status: 'stopped', mode: null, error: errMsg(e), since: null };
    throw e;
  }
}

export async function stopAgent(): Promise<void> {
  if (state.status !== 'running') return;
  state = { ...state, status: 'stopping' };
  try {
    await stopFn?.();
  } finally {
    stopFn = undefined;
    state = { status: 'stopped', mode: null, error: null, since: null };
  }
}

async function build(cfg: Config, dry: boolean): Promise<() => Promise<void>> {
  initLlm(requireEnv('GEMINI_API_KEY'), cfg.llm.requestsPerMinute);
  await resolveModels({ fast: cfg.models.fast, smart: cfg.models.smart });
  log.info('llm', `fast: ${cfg.models.fast.join(' > ')} | smart: ${cfg.models.smart.join(' > ')}`);

  // Dry run uses its own database and never sends or notifies externally.
  const db = openDb(dbPath(dry));
  let ctx: Ctx;
  try {
    ctx = {
      cfg,
      db,
      dry,
      channel: dry ? noChannel : createEmailChannel(cfg.channels.email, db),
      notifier: createNotifier(cfg.notifiers, dry),
    };
  } catch (e) {
    db.close();
    throw e;
  }

  let stopping = false;
  const timers: NodeJS.Timeout[] = [];
  const inflight = new Set<Promise<void>>();

  /** Runs `fn` repeatedly without overlap; alerts the human once if a stage fails 5 times in a row. */
  function every(name: string, ms: number, fn: () => Promise<void>, initialDelayMs = 0) {
    let fails = 0;
    const slot = timers.length;
    const run = async () => {
      if (stopping) return;
      try {
        await fn();
        fails = 0;
      } catch (e) {
        if (e instanceof LlmBusy) {
          log.warn(name, e.message); // quota exhaustion is expected on free tiers; not a stage failure
        } else {
          log.error(name, errMsg(e));
          if (++fails === 5) await ctx.notifier.notify(`Stage "${name}" keeps failing`, errMsg(e));
        }
      }
      if (!stopping) timers[slot] = setTimeout(tick, ms);
    };
    const tick = () => {
      const p = run();
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    };
    timers[slot] = setTimeout(tick, initialDelayMs);
  }

  const backlog = () =>
    (db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE status IN ('new','enriched','researched','drafted')`).get() as { n: number }).n;

  every('discover', 10 * 60_000, async () => {
    if (backlog() >= Math.max(10, dailyCap(db, cfg.sending) * 2)) return;
    await discover(ctx);
  });
  every('enrich', 20_000, () => enrich(ctx), 5_000);
  every('research', 30_000, () => research(ctx), 10_000);
  every('draft', 30_000, () => draft(ctx), 15_000);
  every('send', 30_000, () => sendNext(ctx), 20_000);
  if (!dry) every('replies', 5 * 60_000, () => pollReplies(ctx), 30_000);
  every('explore', 30 * 60_000, () => explore(ctx), 60_000);
  if (!dry && cfg.backup.dir) {
    every(
      'backup',
      60 * 60_000,
      async () => {
        if (Date.now() - Number(kvGet(db, 'last_backup') ?? 0) < cfg.backup.everyHours * 3_600_000) return;
        const file = await backupDb(db, path.resolve(cfg.backup.dir), cfg.backup.keep);
        kvSet(db, 'last_backup', Date.now());
        log.info('backup', `saved ${file}`);
      },
      90_000,
    );
  }

  log.info('agent', `started${dry ? ' (DRY RUN: nothing will be sent)' : ' (LIVE)'}. Goal: ${cfg.goal}`);

  return async () => {
    stopping = true;
    timers.forEach(clearTimeout);
    log.info('agent', 'stopping, waiting for current steps to finish');
    await Promise.allSettled([...inflight]);
    await closeBrowser();
    db.close();
    log.info('agent', 'stopped');
  };
}

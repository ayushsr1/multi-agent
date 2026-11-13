import { spawn } from 'node:child_process';
import { getState, startAgent, stopAgent } from './agent.js';
import { startQuickLoops } from './quick.js';
import { startUi } from './ui/server.js';
import { errMsg, log } from './util.js';

const port = Number(process.env.UI_PORT || process.env.PORT) || 3000;
// Hosting platforms set PORT and route outside traffic in; on a personal computer the page stays local.
const host = process.env.UI_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const url = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://127.0.0.1:${port}`;

const server = await startUi(port, host).catch((e) => {
  console.error(errMsg(e));
  process.exit(1);
});
log.info('ui', `Settings and dashboard: ${url}`);
startQuickLoops();

// The old AI agent is switched off here: it is not part of Quick outreach and it used up the free Gemini quota.
// Only an explicit `npm run dry-run` or `npm run live` starts it.
const mode = process.argv.includes('--live') ? 'live' : process.argv.includes('--dry-run') ? 'dry' : undefined;
const autostart = mode === 'live' ? false : mode === 'dry' ? true : undefined;
if (autostart !== undefined) {
  await startAgent(autostart).catch((e) => log.error('agent', errMsg(e)));
} else if (process.stdout.isTTY && !process.env.NO_OPEN) {
  // Open the page for you. Ignored on machines without a desktop.
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  log.info('app', 'shutting down');
  if (getState().status === 'running') await stopAgent().catch(() => {});
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('unhandledRejection', (e) => log.error('app', `unhandled rejection: ${errMsg(e)}`));

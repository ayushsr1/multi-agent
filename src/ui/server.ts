import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearAgentError, dbPath, getState, startAgent, stopAgent } from '../agent.js';
import { detectTelegramChat, testNotifiers } from '../channels/notifiers.js';
import { verifyEmail } from '../channels/email.js';
import { loadConfig, NeedsSetup, saveConfig, settingsForForm, type Config } from '../config.js';
import { envStatus, isEnvKey, setEnv, type EnvKey } from '../env.js';
import { openDb, type DB } from '../db.js';
import { autoPick, listUsableModels, probeModels } from '../llm.js';
import { errMsg, log, logsSince } from '../util.js';
import { collectStats } from './stats.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: object = {},
  ) {
    super(message);
  }
}

// Read-only connections used by the dashboard (the agent has its own read-write one).
const viewDbs = new Map<string, DB>();
function viewDb(dry: boolean): DB {
  const file = dbPath(dry);
  let db = viewDbs.get(file);
  if (!db) {
    db = openDb(file);
    db.pragma('query_only = ON');
    viewDbs.set(file, db);
  }
  return db;
}

const tryConfig = (): Config | null => {
  try {
    return loadConfig();
  } catch {
    return null;
  }
};

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 200_000) throw new HttpError(413, 'Request too large');
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function readiness() {
  const env = envStatus();
  const cfg = tryConfig();
  return {
    settings: !!cfg,
    gemini: env.GEMINI_API_KEY.set,
    email: env.EMAIL_USER.set && env.EMAIL_PASS.set,
    notifier: !cfg
      ? env.TELEGRAM_BOT_TOKEN.set && env.TELEGRAM_CHAT_ID.set
      : cfg.notifiers.every((n) => (n === 'telegram' ? env.TELEGRAM_BOT_TOKEN.set && env.TELEGRAM_CHAT_ID.set : env.WEBHOOK_URL.set)),
  };
}

type Handler = (req: http.IncomingMessage, url: URL) => Promise<unknown>;

const routes: Record<string, Handler> = {
  'GET /api/settings': async () => ({ ...settingsForForm(), env: envStatus() }),

  'POST /api/settings': async (req) => {
    const body = await readJson(req);
    const secrets = (body.secrets ?? {}) as Record<string, unknown>;
    const updates: Partial<Record<EnvKey, string>> = {};
    for (const [k, v] of Object.entries(secrets)) {
      if (!isEnvKey(k)) throw new HttpError(400, `Unknown setting ${k}`);
      if (typeof v !== 'string') throw new HttpError(400, `${k} must be text`);
      if (v.trim()) updates[k] = v; // blank means "keep what is saved"
    }
    // secretsOnly lets the key tests run before the rest of the form is filled in
    if (body.secretsOnly !== true) {
      const result = saveConfig(body.config);
      if (!result.ok) throw new HttpError(400, 'Some settings need attention', { issues: result.issues });
    }
    try {
      setEnv(updates);
    } catch (e) {
      throw new HttpError(400, errMsg(e));
    }
    clearAgentError();
    return { ok: true, env: envStatus() };
  },

  'GET /api/status': async () => ({ agent: getState(), ready: readiness() }),

  'GET /api/stats': async (_req, url) => {
    const dry = url.searchParams.get('db') === 'dry';
    return collectStats(viewDb(dry), tryConfig());
  },

  'GET /api/logs': async (_req, url) => ({ lines: logsSince(Number(url.searchParams.get('since')) || 0) }),

  'POST /api/agent/start': async (req) => {
    const body = await readJson(req);
    const dry = body.mode !== 'live';
    if (!dry && body.confirm !== true) throw new HttpError(400, 'Live mode needs confirmation');
    try {
      await startAgent(dry);
    } catch (e) {
      throw new HttpError(400, errMsg(e));
    }
    return { agent: getState() };
  },

  'POST /api/agent/stop': async () => {
    await stopAgent();
    return { agent: getState() };
  },

  'POST /api/test/gemini': async () => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new HttpError(400, 'No Gemini API key saved yet');
    let models: string[];
    try {
      models = await listUsableModels(key);
    } catch (e) {
      const msg = errMsg(e);
      // A network failure is not a bad key: say which it is.
      if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed? ?out|proxy/i.test(msg)) {
        throw new HttpError(400, 'Could not reach Google from this computer, so the key was NOT checked. This is a network or company-proxy block, not a problem with your key.');
      }
      throw new HttpError(400, `Google rejected the key: ${msg}`);
    }
    const cfg = settingsForForm().config as { models?: { fast?: string[]; smart?: string[] } };
    const missing = [...(cfg.models?.fast ?? []), ...(cfg.models?.smart ?? [])].filter((m) => !models.includes(m));
    const wanted = [...new Set([...(cfg.models?.fast ?? []), ...(cfg.models?.smart ?? [])])];
    const present = wanted.filter((m) => models.includes(m));
    if (!present.length) wanted.push(...autoPick(models, false), ...autoPick(models, true));
    const probes = await probeModels(key, [...new Set(wanted)]);
    return { ok: probes.some((p) => p.ok), models, missing: [...new Set(missing)], probes };
  },

  'POST /api/test/email': async () => {
    const cfg = tryConfig();
    if (!cfg) throw new HttpError(400, 'Save your settings first');
    try {
      return await verifyEmail(cfg.channels.email);
    } catch (e) {
      throw new HttpError(400, errMsg(e));
    }
  },

  'POST /api/test/notify': async () => {
    const cfg = tryConfig();
    return { results: await testNotifiers(cfg?.notifiers ?? ['telegram']) };
  },

  'POST /api/telegram/detect': async () => {
    try {
      const chat = await detectTelegramChat();
      setEnv({ TELEGRAM_CHAT_ID: chat.id });
      return { ok: true, name: chat.name, id: chat.id };
    } catch (e) {
      throw new HttpError(400, errMsg(e));
    }
  },
};

const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest();

export function startUi(port: number, host = '127.0.0.1'): Promise<http.Server> {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const password = process.env.UI_PASSWORD ?? '';
  if (!isLocal && password.length < 12) {
    return Promise.reject(new Error('Set UI_PASSWORD (at least 12 characters) before making the page reachable from the internet.'));
  }
  const passHash = sha256(password);
  const failures = new Map<string, { count: number; until: number }>();
  // Behind a hosting proxy the real client is the last address the proxy appended.
  const clientIp = (req: http.IncomingMessage) =>
    (!isLocal && String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim()) || req.socket.remoteAddress || '?';
  const passwordOk = (req: http.IncomingMessage) => {
    const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!m) return false;
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    return crypto.timingSafeEqual(sha256(decoded.slice(decoded.indexOf(':') + 1)), passHash);
  };

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: string | object, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        'content-security-policy':
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    try {
      if (password) {
        const ip = clientIp(req);
        const f = failures.get(ip);
        if (f && f.until > Date.now()) throw new HttpError(429, 'Too many wrong passwords. Try again in 15 minutes.');
        if (!passwordOk(req)) {
          if (req.headers.authorization) {
            if (failures.size > 10_000) failures.clear();
            const count = (f?.count ?? 0) + 1;
            failures.set(ip, { count, until: count >= 10 ? Date.now() + 15 * 60_000 : 0 });
          }
          res.writeHead(401, { 'www-authenticate': 'Basic realm="Outreach agent", charset="UTF-8"', 'content-type': 'text/plain' });
          return res.end('Password required');
        }
        failures.delete(ip);
      }
      // Blocks DNS-rebinding on the local-only page. A public page is protected by the password instead.
      if (isLocal && !allowedHosts.has(req.headers.host ?? '')) throw new HttpError(403, 'Forbidden host');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const method = req.method ?? 'GET';

      const asset = method === 'GET' ? STATIC[url.pathname] : undefined;
      if (asset) return send(200, fs.readFileSync(path.join(PUBLIC_DIR, asset.file), 'utf8'), asset.type);

      if (method !== 'GET') {
        // Blocks cross-site requests: the browser must say the request comes from this page, as JSON.
        const origin = req.headers.origin;
        if (origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new HttpError(403, 'Forbidden origin');
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'JSON required');
      }

      const handler = routes[`${method} ${url.pathname}`];
      if (!handler) throw new HttpError(404, 'Not found');
      send(200, (await handler(req, url)) as object);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message, ...e.extra });
      if (e instanceof NeedsSetup) return send(400, { error: e.message });
      log.error('ui', errMsg(e));
      send(500, { error: 'Something went wrong. See the activity log.' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) =>
      reject(new Error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set UI_PORT to another number, e.g. UI_PORT=3100 npm start` : errMsg(e))),
    );
    // Defaults to 127.0.0.1: the page is reachable from other machines only when hosting sets a public host.
    server.listen(port, host, () => resolve(server));
  });
}

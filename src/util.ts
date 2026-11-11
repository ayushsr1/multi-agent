export const now = () => Date.now();
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const rand = (min: number, max: number) => min + Math.random() * (max - min);
export const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '...' : s);
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const stamp = () => new Date().toISOString();

export interface LogLine {
  id: number;
  t: string;
  level: 'info' | 'warn' | 'error';
  stage: string;
  msg: string;
}
const ring: LogLine[] = [];
let seq = 0;
const push = (level: LogLine['level'], stage: string, msg: string) => {
  ring.push({ id: ++seq, t: stamp(), level, stage, msg: msg.slice(0, 3000) });
  if (ring.length > 400) ring.shift();
};
/** Recent log lines newer than `id` (for the UI activity feed). */
export const logsSince = (id: number) => ring.filter((l) => l.id > id);

export const log = {
  info: (stage: string, msg: string) => (push('info', stage, msg), console.log(`${stamp()} [${stage}] ${msg}`)),
  warn: (stage: string, msg: string) => (push('warn', stage, msg), console.warn(`${stamp()} [${stage}] WARN ${msg}`)),
  error: (stage: string, msg: string) => (push('error', stage, msg), console.error(`${stamp()} [${stage}] ERROR ${msg}`)),
};

/** Extracts the first JSON object/array from model output (tolerates code fences and prose). */
export function extractJson(text: string): unknown {
  const t = text.replace(/```(?:json)?/gi, '').trim();
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0);
  if (!starts.length) throw new Error('No JSON found in model output');
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  return JSON.parse(t.slice(Math.min(...starts), end + 1));
}

/** Wraps scraped/third-party text so the model treats it as data, not instructions. */
export const untrusted = (label: string, s: string) => `<untrusted_${label}>\n${s}\n</untrusted_${label}>`;

export const hostOf = (url: string) => new URL(url).hostname.replace(/^www\./, '').toLowerCase();

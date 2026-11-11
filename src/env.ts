import fs from 'node:fs';
import path from 'node:path';

/** Settings kept in .env. `secret` values are never sent back to the browser. */
export const ENV_KEYS = {
  GEMINI_API_KEY: { secret: true },
  EMAIL_USER: { secret: false },
  EMAIL_PASS: { secret: true },
  TELEGRAM_BOT_TOKEN: { secret: true },
  TELEGRAM_CHAT_ID: { secret: false },
  WEBHOOK_URL: { secret: true },
} as const;

export type EnvKey = keyof typeof ENV_KEYS;
export const isEnvKey = (k: string): k is EnvKey => Object.hasOwn(ENV_KEYS, k);

// Same variable dotenv/config reads, so a hosted copy can keep secrets on its persistent disk.
const envPath = () => path.resolve(process.env.DOTENV_CONFIG_PATH ?? '.env');

/** Reports which keys are set; returns the value only for non-secret keys. */
export function envStatus(): Record<EnvKey, { set: boolean; value?: string }> {
  const out = {} as Record<EnvKey, { set: boolean; value?: string }>;
  for (const k of Object.keys(ENV_KEYS) as EnvKey[]) {
    const v = process.env[k] ?? '';
    out[k] = ENV_KEYS[k].secret ? { set: !!v } : { set: !!v, value: v };
  }
  return out;
}

/** Quotes a value so dotenv reads it back exactly. Rejects values that cannot be represented safely. */
function encode(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Values cannot contain line breaks');
  if (/^[A-Za-z0-9_\-.:/@+=]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  throw new Error('Value cannot contain both single and double quotes');
}

/** Updates .env in place (keeping other lines and comments) and applies the values to the running process. */
export function setEnv(updates: Partial<Record<EnvKey, string>>): void {
  const file = envPath();
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  for (const [key, raw] of Object.entries(updates) as [EnvKey, string][]) {
    const value = raw.trim();
    const line = `${key}=${encode(value)}`;
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
    process.env[key] = value;
  }
  const text = lines.join('\n').replace(/\n*$/, '\n');
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import 'dotenv/config';

const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const endpoint = z.object({ host: z.string(), port: z.number(), secure: z.boolean() });
/** A directory setting with a default; expands a leading ~ to the home directory (cross-platform). */
const dirSetting = (def: string) =>
  z
    .string()
    .default(def)
    .transform((v) => v.replace(/^~(?=$|[\\/])/, os.homedir()));
/** A single model id or an ordered fallback list. */
const modelChain = (def: string[]) =>
  z
    .union([z.string(), z.array(z.string()).min(1)])
    .default(def)
    .transform((v) => (Array.isArray(v) ? v : [v]))
    // Google retired Gemini 1.x/2.x for new keys: drop them from saved settings and keep current fallbacks behind the user's choice.
    .transform((v) => [...new Set([...v.filter((m) => !/^gemini-[12]\./.test(m)), ...def])]);

const schema = z.object({
  goal: z.string().min(10),
  audience: z.string().min(5),
  product: z.object({
    name: z.string(),
    url: z.string().optional(),
    description: z.string(),
    pitch: z.string(),
    proofPoints: z.array(z.string()).default([]),
    callToAction: z.string().default('Worth a quick chat?'),
  }),
  sender: z.object({
    name: z.string(),
    title: z.string().optional(),
    footer: z
      .string()
      .default('If this is not relevant, just reply "no thanks" and I will not contact you again.'),
  }),
  discovery: z
    .object({
      batchSize: z.number().default(8),
      hints: z.array(z.string()).default([]),
    })
    .default({}),
  models: z
    .object({
      fast: modelChain(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']),
      smart: modelChain(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash']),
    })
    .default({}),
  llm: z
    .object({
      /** Shared request budget across all stages. Keep within your API key's limits. */
      requestsPerMinute: z.number().default(8),
    })
    .default({}),
  backup: z
    .object({
      /** Folder to write database snapshots to (e.g. your Google Drive for desktop folder). Empty = disabled. */
      dir: dirSetting(''),
      everyHours: z.number().default(24),
      keep: z.number().default(14),
    })
    .default({}),
  quality: z
    .object({
      minFit: z.number().default(6),
      minCriticScore: z.number().default(7),
      maxRevisions: z.number().default(2),
      settleDays: z.number().default(7),
    })
    .default({}),
  sending: z
    .object({
      startPerDay: z.number().default(10),
      rampPerDay: z.number().default(2),
      maxPerDay: z.number().default(40),
      hours: z.tuple([z.number(), z.number()]).default([9, 17]),
      weekdaysOnly: z.boolean().default(true),
      timezone: z.string().default(localTz),
      minGapMinutes: z.number().default(4),
      maxGapMinutes: z.number().default(12),
    })
    .default({}),
  channels: z.object({
    email: z.object({ from: z.string(), smtp: endpoint, imap: endpoint }),
  }),
  notifiers: z.array(z.enum(['telegram', 'webhook'])).default(['telegram']),
  explorer: z
    .object({
      intervalHours: z.number().default(24),
      subreddits: z.array(z.string()).default([]),
      queries: z.array(z.string()).default([]),
      knowledgeDir: dirSetting('knowledge'),
    })
    .default({}),
});

export type Config = z.infer<typeof schema>;

export const CONFIG_PATH = () => path.resolve(process.env.AGENT_CONFIG ?? 'config/agent.yaml');

/** Thrown when no valid settings have been saved yet. The UI shows this message as-is. */
export class NeedsSetup extends Error {}

export function loadConfig(): Config {
  const file = CONFIG_PATH();
  if (!fs.existsSync(file)) throw new NeedsSetup('Not set up yet. Open the Settings tab, fill in your goal, audience and product, and click Save.');
  const parsed = schema.safeParse(YAML.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new NeedsSetup(`Saved settings are incomplete or invalid (${issues}). Fix them in the Settings tab.`);
  }
  return parsed.data;
}

/** The saved settings if present and valid, else blank defaults, so the UI form always has something to show. */
export function settingsForForm(): { config: Record<string, unknown>; saved: boolean } {
  const file = CONFIG_PATH();
  if (fs.existsSync(file)) {
    try {
      const raw = YAML.parse(fs.readFileSync(file, 'utf8'));
      const parsed = schema.safeParse(raw);
      return { config: (parsed.success ? parsed.data : raw) as Record<string, unknown>, saved: parsed.success };
    } catch {
      /* unreadable file: fall through to defaults */
    }
  }
  const s = schema.shape;
  return {
    saved: false,
    config: {
      goal: '',
      audience: '',
      product: s.product.parse({ name: '', description: '', pitch: '' }),
      sender: s.sender.parse({ name: '' }),
      discovery: s.discovery.parse(undefined),
      models: s.models.parse(undefined),
      llm: s.llm.parse(undefined),
      backup: s.backup.parse(undefined),
      quality: s.quality.parse(undefined),
      sending: s.sending.parse(undefined),
      channels: {
        email: {
          from: '',
          smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
          imap: { host: 'imap.gmail.com', port: 993, secure: true },
        },
      },
      notifiers: s.notifiers.parse(undefined),
      explorer: s.explorer.parse(undefined),
    },
  };
}

export type SaveResult = { ok: true } | { ok: false; issues: { path: string; message: string }[] };

/** Validates and writes the settings file. Nothing is written if validation fails. */
export function saveConfig(input: unknown): SaveResult {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  }
  const file = CONFIG_PATH();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `# Written by the settings page. Edit there, or here while the app is stopped.\n${YAML.stringify(parsed.data)}`);
  fs.renameSync(tmp, file);
  return { ok: true };
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return v;
}

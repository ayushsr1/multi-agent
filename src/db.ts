import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { now } from './util.js';

export type DB = Database.Database;

export interface LeadRow {
  id: number;
  name: string;
  role: string;
  company: string;
  website: string | null;
  source_url: string | null;
  why_fit: string | null;
  email: string | null;
  page_text: string | null;
  dossier: string | null;
  status: string;
  note: string | null;
}

export interface EmailRow {
  id: number;
  lead_id: number;
  angle_id: string;
  subject: string;
  body: string;
  critic_score: number | null;
  status: string;
  message_id: string | null;
  sent_at: number | null;
  outcome: string;
}

export interface AngleRow {
  id: string;
  description: string;
  source: string;
  active: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', company TEXT NOT NULL,
  website TEXT, source_url TEXT, why_fit TEXT,
  email TEXT, page_text TEXT, dossier TEXT,
  status TEXT NOT NULL DEFAULT 'new', note TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  angle_id TEXT NOT NULL,
  subject TEXT NOT NULL, body TEXT NOT NULL,
  critic_score REAL, rationale TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  message_id TEXT, sent_at INTEGER,
  outcome TEXT NOT NULL DEFAULT 'none',
  reply_text TEXT, replied_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
CREATE INDEX IF NOT EXISTS idx_emails_msgid ON emails(message_id);
CREATE TABLE IF NOT EXISTS suppression (
  email TEXT PRIMARY KEY, reason TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS angles (
  id TEXT PRIMARY KEY, description TEXT NOT NULL,
  source TEXT NOT NULL, evidence TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

const SEED_ANGLES: [string, string][] = [
  [
    'pain_led',
    'Open with one specific problem this person likely faces right now (grounded in the dossier), then connect it to the product in one sentence.',
  ],
  [
    'trigger_event',
    'Open with a recent, verifiable event or signal about them or their company (launch, hiring, news, post) and explain why it makes this relevant now.',
  ],
  [
    'direct_question',
    'Ask one sharp, specific question about how they handle a problem the product solves. Mention the product only briefly after the question.',
  ],
  [
    'value_first',
    'Lead with one concrete, useful observation or idea tailored to their situation that they can use even if they never reply. Mention the product in one short line.',
  ],
  [
    'proof_led',
    'Lead with one proof point from the product brief (only use proof points actually provided) and tie it to their situation. Never invent customers or numbers.',
  ],
];

export function openDb(file: string): DB {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  const ins = db.prepare(
    `INSERT OR IGNORE INTO angles (id, description, source, active, created_at) VALUES (?, ?, 'seed', 1, ?)`,
  );
  for (const [id, description] of SEED_ANGLES) ins.run(id, description, now());
  return db;
}

export const kvGet = (db: DB, k: string): string | undefined =>
  (db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined)?.v;

export const kvSet = (db: DB, k: string, v: string | number) =>
  void db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));

export const setLead = (db: DB, id: number, fields: Record<string, string | number | null>) => {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE leads SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @_t WHERE id = @_id`).run({
    ...fields,
    _t: now(),
    _id: id,
  });
};

/** Records a processing failure on a lead; after `max` failures it is parked as 'failed' instead of retried forever. */
export const bumpFail = (db: DB, lead: LeadRow, error: string, max = 3) => {
  const n = Number(/^fails:(\d+)/.exec(lead.note ?? '')?.[1] ?? 0) + 1;
  setLead(db, lead.id, n >= max ? { status: 'failed', note: `gave up: ${error.slice(0, 150)}` } : { note: `fails:${n} ${error.slice(0, 150)}` });
};

export const isSuppressed = (db: DB, email: string) =>
  !!db.prepare('SELECT 1 FROM suppression WHERE email = ?').get(email.toLowerCase());

export const suppress = (db: DB, email: string, reason: string) =>
  void db
    .prepare('INSERT OR IGNORE INTO suppression (email, reason, created_at) VALUES (?, ?, ?)')
    .run(email.toLowerCase(), reason, now());

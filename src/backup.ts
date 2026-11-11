import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';

/**
 * Writes a consistent snapshot of the database into `dir` (e.g. a Google Drive for desktop folder) and prunes old ones.
 * Never point the live database itself at a synced folder: sync clients can corrupt SQLite WAL files.
 */
export async function backupDb(db: DB, dir: string, keep: number): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = path.join(dir, `agent-${stamp}.db`);
  await db.backup(file);
  const old = fs
    .readdirSync(dir)
    .filter((f) => /^agent-[\d-]+\.db$/.test(f))
    .sort()
    .slice(0, -Math.max(1, keep));
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

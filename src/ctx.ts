import type { Channel, Notifier } from './channels/types.js';
import type { Config } from './config.js';
import type { DB } from './db.js';

export interface Ctx {
  cfg: Config;
  db: DB;
  channel: Channel;
  notifier: Notifier;
  dry: boolean;
}

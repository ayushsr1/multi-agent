import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Config } from '../config.js';
import { requireEnv } from '../config.js';
import { kvGet, kvSet, type DB } from '../db.js';
import type { Channel, InboundMessage } from './types.js';

const stripBrackets = (id: string) => id.replace(/^<|>$/g, '').trim();

/** Checks the saved email account can log in to both the sending (SMTP) and reading (IMAP) servers. */
export async function verifyEmail(cfg: Config['channels']['email']) {
  const user = requireEnv('EMAIL_USER');
  const pass = requireEnv('EMAIL_PASS');
  const result = { smtp: { ok: false, error: '' }, imap: { ok: false, error: '' } };
  try {
    await nodemailer.createTransport({ ...cfg.smtp, auth: { user, pass }, connectionTimeout: 15_000, greetingTimeout: 15_000 }).verify();
    result.smtp.ok = true;
  } catch (e) {
    result.smtp.error = e instanceof Error ? e.message : String(e);
  }
  try {
    const client = new ImapFlow({ ...cfg.imap, auth: { user, pass }, logger: false, connectionTimeout: 15_000, greetingTimeout: 15_000 });
    await client.connect();
    await client.logout();
    result.imap.ok = true;
  } catch (e) {
    result.imap.error = e instanceof Error ? e.message : String(e);
  }
  return result;
}

/** Generic SMTP + IMAP channel. Works with Gmail (app password), Outlook, Zoho, Fastmail, any custom domain. */
export function createEmailChannel(cfg: Config['channels']['email'], db: DB): Channel {
  const user = requireEnv('EMAIL_USER');
  const pass = requireEnv('EMAIL_PASS');
  const fromAddr = /<([^>]+)>/.exec(cfg.from)?.[1] ?? cfg.from;
  const transport = nodemailer.createTransport({ ...cfg.smtp, auth: { user, pass } });

  return {
    name: 'email',

    async send({ to, subject, body }) {
      const info = await transport.sendMail({
        from: cfg.from,
        to,
        subject,
        text: body,
        headers: { 'List-Unsubscribe': `<mailto:${fromAddr}?subject=unsubscribe>` },
      });
      return { messageId: stripBrackets(info.messageId) };
    },

    async pollInbound() {
      const client = new ImapFlow({ ...cfg.imap, auth: { user, pass }, logger: false });
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const stored = kvGet(db, 'imap_last_uid');
        const mailbox = client.mailbox;
        const uidNext = mailbox && typeof mailbox === 'object' ? mailbox.uidNext : 1;
        if (stored === undefined) {
          // First run: start from now, never process old mail.
          kvSet(db, 'imap_last_uid', uidNext - 1);
          return [];
        }
        const last = Number(stored);
        const out: InboundMessage[] = [];
        let maxUid = last;
        for await (const m of client.fetch(`${last + 1}:*`, { uid: true, source: true }, { uid: true })) {
          if (m.uid <= last || !m.source) continue;
          maxUid = Math.max(maxUid, m.uid);
          const p = await simpleParser(m.source);
          const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
          out.push({
            messageId: p.messageId ? stripBrackets(p.messageId) : null,
            inReplyTo: p.inReplyTo ? stripBrackets(p.inReplyTo) : null,
            references: refs.map(stripBrackets),
            from: (p.from?.value[0]?.address ?? '').toLowerCase(),
            subject: p.subject ?? '',
            text: p.text ?? '',
          });
        }
        kvSet(db, 'imap_last_uid', maxUid);
        return out;
      } finally {
        lock.release();
        await client.logout().catch(() => {});
      }
    },
  };
}

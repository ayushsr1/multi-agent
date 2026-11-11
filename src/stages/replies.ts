import { z } from 'zod';
import type { InboundMessage } from '../channels/types.js';
import type { Ctx } from '../ctx.js';
import { suppress, type EmailRow } from '../db.js';
import { askJson } from '../llm.js';
import { errMsg, log, now, trunc, untrusted } from '../util.js';

const Classification = z.object({
  category: z.enum(['positive', 'question', 'negative', 'unsubscribe', 'auto_reply', 'other']),
  summary: z.string(),
  suggestedReply: z.string().default(''),
});

type Row = EmailRow & { to_email: string; lead_name: string; company: string };

const BOUNCE = /mailer-daemon|postmaster/i;
const BOUNCE_SUBJECT = /undeliver|delivery status|delivery failure|failure notice|returned mail|could not be delivered/i;

/** Removes quoted history so the classifier sees only the new reply text. */
function newText(text: string): string {
  const cut = text.search(/^\s*(>|On .{5,120} wrote:|-{2,}\s*Original Message)/im);
  return (cut > 0 ? text.slice(0, cut) : text).trim();
}

function findEmail(ctx: Ctx, m: InboundMessage): Row | undefined {
  const base = `SELECT e.*, l.email AS to_email, l.name AS lead_name, l.company AS company
                FROM emails e JOIN leads l ON l.id = e.lead_id WHERE e.status = 'sent'`;
  const ids = [m.inReplyTo, ...m.references].filter((x): x is string => !!x);
  for (const id of ids) {
    const r = ctx.db.prepare(`${base} AND e.message_id = ?`).get(id) as Row | undefined;
    if (r) return r;
  }
  return ctx.db.prepare(`${base} AND l.email = ? ORDER BY e.sent_at DESC LIMIT 1`).get(m.from) as Row | undefined;
}

/** Reads the inbox, links replies/bounces to sent emails, classifies, and alerts the human only when it matters. */
export async function pollReplies(ctx: Ctx) {
  const { cfg, db, channel, notifier } = ctx;
  const inbound = await channel.pollInbound();

  for (const m of inbound) {
    let row: Row | undefined;
    let reply = '';
    try {
      if (BOUNCE.test(m.from) || BOUNCE_SUBJECT.test(m.subject)) {
        const sent = db
          .prepare(`SELECT e.id, l.email FROM emails e JOIN leads l ON l.id = e.lead_id WHERE e.status = 'sent' AND e.outcome = 'none'`)
          .all() as { id: number; email: string }[];
        const hay = m.text.toLowerCase();
        for (const s of sent.filter((x) => hay.includes(x.email.toLowerCase()))) {
          db.prepare(`UPDATE emails SET outcome = 'bounce' WHERE id = ?`).run(s.id);
          suppress(db, s.email, 'bounce');
          log.info('replies', `bounce: ${s.email}`);
        }
        continue;
      }

      row = findEmail(ctx, m);
      if (!row) continue; // unrelated inbox mail

      reply = trunc(newText(m.text), 2000);
      const c = await askJson(
        `Classify this reply to a cold outreach email and, if a human response is warranted, draft one.

Original email from us:
Subject: ${row.subject}
${row.body}

${untrusted('reply', reply)}

Categories: positive (interested / wants to talk / agrees), question (asks something or needs info), negative (not interested), unsubscribe (asks to stop), auto_reply (out-of-office or automatic), other.
Return ONLY JSON: {"category","summary" (one sentence),"suggestedReply" (short, honest, in the sender's voice; empty for negative/unsubscribe/auto_reply)}`,
        Classification,
        { model: cfg.models.fast, temperature: 0.3 },
      );

      if (c.category === 'auto_reply' && row.outcome !== 'none') continue;
      if (c.category !== 'auto_reply') {
        db.prepare(`UPDATE emails SET outcome = ?, reply_text = ?, replied_at = ? WHERE id = ?`).run(c.category, reply, now(), row.id);
        db.prepare(`UPDATE leads SET status = 'replied', updated_at = ? WHERE id = ?`).run(now(), row.lead_id);
      }
      if (c.category === 'unsubscribe' || c.category === 'negative') suppress(db, row.to_email, c.category);
      if (c.category === 'auto_reply') continue;

      const needsYou = c.category === 'positive' || c.category === 'question' || c.category === 'other';
      await notifier.notify(
        `${needsYou ? 'REPLY NEEDS YOU' : 'Reply (no action needed)'}: ${c.category} - ${row.lead_name}, ${row.company}`,
        `${c.summary}\n\nTheir reply:\n${reply}${c.suggestedReply ? `\n\nSuggested response:\n${c.suggestedReply}` : ''}\n\nFrom: ${row.to_email}`,
      );
    } catch (e) {
      log.warn('replies', errMsg(e));
      // The inbox position has already advanced, so never lose a real reply: forward it raw.
      if (row) {
        db.prepare(`UPDATE emails SET outcome = 'other', reply_text = ?, replied_at = ? WHERE id = ?`).run(reply, now(), row.id);
        db.prepare(`UPDATE leads SET status = 'replied', updated_at = ? WHERE id = ?`).run(now(), row.lead_id);
        await notifier.notify(
          `REPLY NEEDS YOU (unclassified): ${row.lead_name}, ${row.company}`,
          `${reply}\n\nFrom: ${row.to_email}\n(Automatic classification failed: ${errMsg(e)})`,
        );
      }
    }
  }
}

import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { bumpFail, setLead, type EmailRow, type LeadRow } from '../db.js';
import { askJson, LlmBusy } from '../llm.js';
import { chooseAngle } from '../learning/bandit.js';
import { errMsg, log, now } from '../util.js';
import { Dossier } from './research.js';

const Draft = z.object({
  subject: z.string().min(3).max(90),
  body: z.string().min(40),
  signalIndex: z.number().int(),
  rationale: z.string(),
});

const Verdict = z.object({
  score: z.number().min(0).max(10),
  generic: z.boolean(),
  spammy: z.boolean(),
  unsupportedClaims: z.array(z.string()),
  feedback: z.string(),
});

const WRITER_SYSTEM = `You write first-touch business emails that read like a thoughtful human wrote them for ONE person.
Rules:
- 60-110 words, plain text, no markdown, no emojis, no links, no attachments.
- Start with "Hi <first name>,". Do NOT add a signature or sign-off name (it is appended automatically).
- Reference exactly one specific, verifiable signal from the dossier (chosen by index) and make it central, not decorative.
- Explain why this matters to THEM now; the product is a means, not the subject.
- Use only facts present in the dossier or product brief. Never invent customers, numbers, mutual connections or prior contact.
- No flattery clichés, no "I hope this finds you well", no fake urgency, no exaggerated claims, no deceptive subject lines.
- End with a single low-friction ask.
- Subject: 3-7 words, specific, lowercase-friendly, no clickbait.`;

export async function draft(ctx: Ctx, batch = 2) {
  const { db } = ctx;
  const leads = db.prepare(`SELECT * FROM leads WHERE status = 'researched' ORDER BY id LIMIT ?`).all(batch) as LeadRow[];
  for (const lead of leads) {
    try {
      await draftOne(ctx, lead);
    } catch (e) {
      if (e instanceof LlmBusy) return log.warn('draft', e.message);
      log.warn('draft', `${lead.company}: ${errMsg(e)}`);
      bumpFail(db, lead, errMsg(e));
    }
  }
}

async function draftOne({ cfg, db }: Ctx, lead: LeadRow) {
  const dossier = Dossier.parse(JSON.parse(lead.dossier ?? '{}'));
  const angle = chooseAngle(db, cfg.quality.settleDays);
  const firstName = lead.name.split(/\s+/)[0];

  const examples = db
    .prepare(`SELECT subject, body FROM emails WHERE outcome IN ('positive','question') ORDER BY replied_at DESC LIMIT 2`)
    .all() as Pick<EmailRow, 'subject' | 'body'>[];

  let feedback = '';
  for (let attempt = 0; attempt <= cfg.quality.maxRevisions; attempt++) {
    const writerPrompt = `Sender: ${cfg.sender.name}${cfg.sender.title ? `, ${cfg.sender.title}` : ''}
Product: ${cfg.product.name} - ${cfg.product.description}
Pitch: ${cfg.product.pitch}
Proof points you may use (and nothing beyond these): ${cfg.product.proofPoints.join(' | ') || 'none'}
Call to action: ${cfg.product.callToAction}
${cfg.product.url ? `(Product URL, do not include in email: ${cfg.product.url})` : ''}

Recipient: ${firstName} (${lead.name}), ${lead.role} at ${lead.company}
Dossier:
${JSON.stringify(dossier, null, 1)}

Angle to use (${angle.id}): ${angle.description}
${examples.length ? `\nPast emails that earned positive replies (learn the style, do not copy):\n${examples.map((x) => `Subject: ${x.subject}\n${x.body}`).join('\n---\n')}\n` : ''}
${feedback ? `\nYour previous draft was rejected by the reviewer. Fix this: ${feedback}\n` : ''}
Return ONLY JSON: {"subject","body","signalIndex" (index into dossier.signals of the fact you used),"rationale" (why this will land with this person)}`;

    const d = await askJson(writerPrompt, Draft, { model: cfg.models.smart, system: WRITER_SYSTEM, temperature: 0.8 });
    if (d.signalIndex < 0 || d.signalIndex >= dossier.signals.length) {
      feedback = 'signalIndex must reference a valid entry in dossier.signals.';
      continue;
    }
    const signal = dossier.signals[d.signalIndex];

    const v = await askJson(
      `You are a strict outreach reviewer. Judge the email below.

Recipient: ${lead.name}, ${lead.role} at ${lead.company}
Verified facts (dossier): ${JSON.stringify(dossier)}
Product brief: ${cfg.product.description} | ${cfg.product.pitch} | proof: ${cfg.product.proofPoints.join(' | ')}
Fact the writer claims to use: ${signal.fact}

Subject: ${d.subject}
${d.body}

Evaluate:
- generic: true if this email could be sent to many other people with small edits.
- spammy: true if it reads like marketing copy, uses hype, fake urgency, or a misleading subject.
- unsupportedClaims: every claim about the recipient, the product or results NOT supported by the dossier/product brief.
- score: 0-10 overall quality (specificity, relevance now, human tone, clear low-friction ask).
- feedback: concrete fixes.
Return ONLY JSON: {"score","generic","spammy","unsupportedClaims","feedback"}`,
      Verdict,
      { model: cfg.models.smart, temperature: 0.1 },
    );

    const pass = !v.generic && !v.spammy && v.unsupportedClaims.length === 0 && v.score >= cfg.quality.minCriticScore;
    if (pass) {
      db.prepare(
        `INSERT INTO emails (lead_id, angle_id, subject, body, critic_score, rationale, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      ).run(lead.id, angle.id, d.subject, d.body, v.score, d.rationale, now());
      setLead(db, lead.id, { status: 'drafted' });
      log.info('draft', `${lead.company}: queued (angle=${angle.id}, score=${v.score})`);
      return;
    }
    feedback = [v.feedback, ...v.unsupportedClaims.map((c) => `Unsupported claim: ${c}`)].join(' ');
  }
  setLead(db, lead.id, { status: 'rejected', note: `critic rejected: ${feedback.slice(0, 200)}` });
  log.info('draft', `${lead.company}: rejected by critic`);
}

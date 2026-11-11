import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { bumpFail, setLead, type LeadRow } from '../db.js';
import { askJson, LlmBusy } from '../llm.js';
import { errMsg, log, untrusted } from '../util.js';

export const Dossier = z.object({
  summary: z.string(),
  situation: z.string(),
  signals: z.array(z.object({ fact: z.string(), sourceUrl: z.string().optional().default('') })),
  pains: z.array(z.string()),
  bestHook: z.string(),
  timing: z.enum(['good', 'neutral', 'bad']),
  timingReason: z.string(),
  fit: z.number().min(0).max(10),
  avoid: z.array(z.string()).default([]),
});
export type Dossier = z.infer<typeof Dossier>;

/** Builds a grounded dossier and decides whether pitching this person, now, is worthwhile. */
export async function research(ctx: Ctx, batch = 2) {
  const { cfg, db } = ctx;
  const leads = db.prepare(`SELECT * FROM leads WHERE status = 'enriched' ORDER BY id LIMIT ?`).all(batch) as LeadRow[];

  for (const lead of leads) {
    try {
      const prompt = `Research this prospect for a business outreach. Use web search for recent, verifiable, PROFESSIONAL information only.

Prospect: ${lead.name}, ${lead.role} at ${lead.company} (${lead.website})
Why they were selected: ${lead.why_fit ?? ''}
${untrusted('website_text', lead.page_text ?? '')}

Campaign goal: ${cfg.goal}
Product: ${cfg.product.name} - ${cfg.product.description}

Assess their current professional situation and whether NOW is a good moment to pitch (e.g. recent funding, launch, hiring, expansion = good; layoffs, crisis, acquisition chaos, just bought a competitor = bad).
Do not include health, family, finances or other sensitive personal circumstances.

Return ONLY JSON:
{"summary": "who they are in 2 sentences",
 "situation": "what they are dealing with professionally right now",
 "signals": [{"fact": "specific verifiable fact", "sourceUrl": "url"}],
 "pains": ["likely problems relevant to the product"],
 "bestHook": "the single best reason to reach out now",
 "timing": "good|neutral|bad", "timingReason": "...",
 "fit": 0-10 (how well the product serves them),
 "avoid": ["topics/claims to avoid"]}`;

      const d = await askJson(prompt, Dossier, { model: cfg.models.fast, search: true, temperature: 0.3 });

      if (d.signals.length === 0 || d.timing === 'bad' || d.fit < cfg.quality.minFit) {
        setLead(db, lead.id, {
          status: 'skipped',
          dossier: JSON.stringify(d),
          note: d.signals.length === 0 ? 'no verifiable signal' : d.timing === 'bad' ? `bad timing: ${d.timingReason}` : `low fit ${d.fit}`,
        });
      } else {
        setLead(db, lead.id, { status: 'researched', dossier: JSON.stringify(d) });
      }
    } catch (e) {
      if (e instanceof LlmBusy) return log.warn('research', e.message);
      log.warn('research', `${lead.company}: ${errMsg(e)}`);
      bumpFail(db, lead, errMsg(e));
    }
  }
}

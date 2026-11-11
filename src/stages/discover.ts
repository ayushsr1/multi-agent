import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { askJson } from '../llm.js';
import { hostOf, log, now } from '../util.js';

const Found = z.array(
  z.object({
    name: z.string(),
    role: z.string().optional().default(''),
    company: z.string(),
    website: z.string().optional(),
    sourceUrl: z.string().optional(),
    whyFit: z.string().optional().default(''),
  }),
);

/** Finds new people/companies via Gemini + live Google Search grounding. */
export async function discover({ cfg, db }: Ctx) {
  const known = db
    .prepare('SELECT company, name, website FROM leads ORDER BY id DESC LIMIT 150')
    .all() as { company: string; name: string; website: string | null }[];

  const prompt = `Goal of the outreach campaign: ${cfg.goal}
Target audience: ${cfg.audience}
Product being pitched: ${cfg.product.name} - ${cfg.product.description}

Use web search to find ${cfg.discovery.batchSize} NEW real decision-makers (a named person with a role at a real organisation) who match the audience and would plausibly benefit.
Prefer people whose organisation has its own website, so a publicly listed business contact can be found there.
${cfg.discovery.hints.length ? `Search strategies to try (adapt as needed):\n- ${cfg.discovery.hints.join('\n- ')}` : ''}

Already known, do NOT repeat: ${known.map((k) => `${k.company} (${k.name})`).join('; ') || 'none yet'}

Return ONLY a JSON array of objects: {"name","role","company","website" (organisation homepage URL),"sourceUrl" (page where you found them),"whyFit" (one sentence)}.`;

  const leads = await askJson(prompt, Found, { model: cfg.models.fast, search: true, temperature: 0.4 });

  const seenHosts = new Set(known.map((k) => (k.website ? safeHost(k.website) : '')).filter(Boolean));
  const seenNames = new Set(known.map((k) => `${k.company}|${k.name}`.toLowerCase()));
  const ins = db.prepare(
    `INSERT INTO leads (name, role, company, website, source_url, why_fit, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
  );
  let added = 0;
  for (const l of leads) {
    const key = `${l.company}|${l.name}`.toLowerCase();
    const host = l.website ? safeHost(l.website) : '';
    if (seenNames.has(key)) continue;
    // One person per organisation at a time avoids spamming the same company.
    if (host && seenHosts.has(host)) continue;
    const website = host ? `https://${host}` : null;
    ins.run(l.name, l.role, l.company, website, l.sourceUrl ?? null, l.whyFit, now(), now());
    seenNames.add(key);
    if (host) seenHosts.add(host);
    added++;
  }
  log.info('discover', `found ${leads.length}, added ${added}`);
}

function safeHost(url: string): string {
  try {
    return hostOf(url);
  } catch {
    return '';
  }
}

import dns from 'node:dns/promises';
import type { Ctx } from '../ctx.js';
import { fetchPage } from '../browser.js';
import { isSuppressed, setLead, type LeadRow } from '../db.js';
import { errMsg, log, trunc } from '../util.js';

const JUNK_LOCAL = /^(noreply|no-reply|donotreply|do-not-reply|abuse|privacy|legal|postmaster|webmaster|careers|jobs|press|unsubscribe|mailer-daemon)$/i;
const JUNK_DOMAIN = /(^|\.)(example\.com|sentry\.io|wixpress\.com|sentry-next\.wixpress\.com)$/i;
const FILE_EXT = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$/i;
const ROLE_BASED = /^(info|hello|hi|hey|contact|team|sales|office|enquiries|inquiries|general)$/i;
const CONTACT_LINK = /contact|about|team|people|leadership|company|who-we-are/i;

function score(email: string, lead: LeadRow, siteHost: string): number {
  const [local, domain] = email.split('@');
  if (JUNK_LOCAL.test(local) || JUNK_DOMAIN.test(domain) || FILE_EXT.test(email)) return -1;
  let s = 0;
  const tokens = lead.name.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
  if (tokens.some((t) => local.toLowerCase().includes(t))) s += 4;
  else if (ROLE_BASED.test(local)) s += 1;
  else s += 0.5;
  if (domain === siteHost || domain.endsWith('.' + siteHost) || siteHost.endsWith('.' + domain)) s += 2;
  return s;
}

async function hasMx(domain: string): Promise<boolean> {
  try {
    return (await dns.resolveMx(domain)).length > 0;
  } catch {
    return false;
  }
}

/** Finds a publicly listed contact address on the organisation's own site and verifies the domain accepts mail. */
export async function enrich(ctx: Ctx, batch = 3) {
  const { db } = ctx;
  const leads = db.prepare(`SELECT * FROM leads WHERE status = 'new' ORDER BY id LIMIT ?`).all(batch) as LeadRow[];
  for (const lead of leads) {
    try {
      if (!lead.website) {
        setLead(db, lead.id, { status: 'no_contact', note: 'no website' });
        continue;
      }
      const home = await fetchPage(lead.website);
      const siteHost = new URL(home.url).hostname.replace(/^www\./, '');
      const texts = [home.text];
      const emails = new Set(home.emails);

      const extra = [...new Set(home.links.filter((l) => CONTACT_LINK.test(l.href + ' ' + l.text)).map((l) => l.href))]
        .filter((u) => u !== home.url)
        .slice(0, 3);
      for (const url of extra) {
        try {
          const p = await fetchPage(url);
          texts.push(p.text);
          p.emails.forEach((e) => emails.add(e));
        } catch (e) {
          log.warn('enrich', `${url}: ${errMsg(e)}`);
        }
      }

      const ranked = [...emails]
        .map((e) => ({ e, s: score(e, lead, siteHost) }))
        .filter((x) => x.s >= 0 && !isSuppressed(db, x.e))
        .sort((a, b) => b.s - a.s);

      let chosen: string | undefined;
      for (const { e } of ranked) {
        if (await hasMx(e.split('@')[1])) {
          chosen = e;
          break;
        }
      }
      const dupe =
        chosen && db.prepare(`SELECT 1 FROM leads WHERE email = ? AND id != ?`).get(chosen, lead.id) ? true : false;

      if (!chosen || dupe) {
        setLead(db, lead.id, { status: 'no_contact', note: dupe ? 'duplicate email' : 'no public email found' });
      } else {
        setLead(db, lead.id, { status: 'enriched', email: chosen, page_text: trunc(texts.join('\n\n'), 8000) });
      }
    } catch (e) {
      log.warn('enrich', `${lead.company}: ${errMsg(e)}`);
      setLead(db, lead.id, { status: 'no_contact', note: `fetch failed: ${trunc(errMsg(e), 120)}` });
    }
  }
}

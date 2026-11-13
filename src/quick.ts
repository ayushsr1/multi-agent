// Quick outreach: reads directory pages you give it, collects public business emails and phone numbers,
// sends one fixed email to each (spaced out), and tells you on Telegram whenever someone replies.
// Gemini (if a key is set) only helps with reading pages: which links are companies, which link is "next",
// and which email is the best one. Without it, fixed rules do the same job. The email text itself is never AI-written.
import { z } from 'zod';
import { dbPath, getState } from './agent.js';
import { assertPublicUrl, fetchListing, fetchPage, type Page } from './browser.js';
import { createEmailChannel } from './channels/email.js';
import { createNotifier } from './channels/notifiers.js';
import { loadConfig, NeedsSetup, requireEnv, type Config } from './config.js';
import { isSuppressed, kvGet, kvSet, openDb, suppress, type DB } from './db.js';
import { askJson, initLlm, resolveModels } from './llm.js';
import { CONTACT_LINK, FILE_EXT, hasMx, JUNK_DOMAIN, JUNK_LOCAL } from './stages/enrich.js';
import { newText } from './stages/replies.js';
import { errMsg, hostOf, log, now, rand, trunc } from './util.js';

const MAX_PAGES = 15; // per starting link
const MAX_PROFILES_PER_PAGE = 40;
const MAX_SITES_PER_PAGE = 60;
const DAY = 86_400_000;

const SKIP_HOSTS = [
  'facebook.com', 'fb.com', 'twitter.com', 'x.com', 'linkedin.com', 'instagram.com', 'youtube.com', 'youtu.be',
  'whatsapp.com', 'wa.me', 't.me', 'telegram.org', 'pinterest.com', 'tiktok.com', 'wikipedia.org', 'amazon.com',
  'amazon.in', 'flipkart.com', 'apple.com', 'microsoft.com', 'bit.ly', 'goo.gl', 'tinyurl.com', 'cloudflare.com',
  'wordpress.com', 'wordpress.org', 'wix.com', 'godaddy.com', 'gravatar.com', 'w3.org', 'schema.org', 'github.com',
  'creativecommons.org', 'europa.eu', 'eur-lex.europa.eu', 'gov.uk', 'mailchimp.com', 'twimg.com',
];
const isSkipHost = (h: string) => /(^|\.)google\.[a-z.]+$/.test(h) || SKIP_HOSTS.some((d) => h === d || h.endsWith('.' + d));
const sameSite = (a: string, b: string) => a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
const FREEMAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|rediffmail|aol|icloud|proton|protonmail|zoho)\.[a-z.]+$/i;
const BORING_PATH = /\/(login|log-in|register|sign-?up|contact|about|privacy|terms|cookies?|search|help|faq|sitemap|user|account|tag|taxonomy|node\/add)(\/|$)/i;
const shapeOf = (href: string) => {
  const parts = new URL(href).pathname.split('/').filter(Boolean);
  return `${parts[0] ?? ''}/${parts.length}`;
};
const PROFILE_PATH = /\/(company|companies|supplier|suppliers|seller|sellers|profile|profiles|member|members|partner|partners|cluster|clusters|organisation|organisations|organization|organizations|institution|institutions|exhibitor|exhibitors|listing|listings|business|firm|vendor|vendors|manufacturer|manufacturers|exporter|exporters)\b/i;
const GOOD_LOCAL = /^(info|contact|sales|export|exports|enquiry|enquiries|inquiry|business|office|hello|marketing|admin|ceo|director|md)$/i;
const AUTO_SUBJECT = /^(auto(matic)?[\s-]?reply|out of (the )?office|ooo\b|autoreply|abwesenheit)/i;
const AUTO_TEXT = /out of (the )?office|automatic reply|auto-reply|autoreply/i;
const SAYS_NO = /unsubscribe|remove me|not interested|no thanks|no, thanks|stop (emailing|sending|contacting)|do not (contact|email)|don't (contact|email)/i;
const BOUNCE = /mailer-daemon|postmaster/i;
const BOUNCE_SUBJECT = /undeliver|delivery status|delivery failure|failure notice|returned mail|could not be delivered/i;

const STATUSES = ['q_found', 'q_queued', 'q_sent', 'q_replied', 'q_no', 'q_bounced', 'q_skipped'];
const IN_STATUSES = `(${STATUSES.map((s) => `'${s}'`).join(',')})`;

let db: DB | undefined;
const qdb = () => (db ??= openDb(dbPath(false)));

const find = { running: false, stop: false, msg: '' };

/* --------------------------------- finding --------------------------------- */

const usable = (email: string) => {
  const [local, domain] = email.split('@');
  return !!local && !!domain && !JUNK_LOCAL.test(local) && !JUNK_DOMAIN.test(domain) && !FILE_EXT.test(email);
};

/** Best addresses first: ones on the company's own domain, then general ones like info@ or sales@. */
function rank(emails: string[], siteHost?: string): string[] {
  const score = (e: string) => {
    const [local, domain] = e.split('@');
    return (siteHost && sameSite(domain, siteHost) ? 2 : 0) + (GOOD_LOCAL.test(local) ? 1 : 0);
  };
  return [...new Set(emails)].filter(usable).sort((a, b) => score(b) - score(a));
}

const companyName = (title: string, host: string) => title.split(/\s+[|\u2013\u2014:-]\s+/)[0].trim().slice(0, 80) || host;

/* ----------------------------- Gemini helpers ------------------------------ */

let aiModels: string[] | undefined;
let aiNote = '';

/** Turns the AI helper on if a Gemini key works. Never throws: without it the fixed rules are used. */
async function setupAi(): Promise<void> {
  aiModels = undefined;
  try {
    const cfg = loadConfig();
    initLlm(requireEnv('GEMINI_API_KEY'), cfg.llm.requestsPerMinute);
    const chains = { fast: [...cfg.models.fast] };
    await resolveModels(chains);
    aiModels = chains.fast;
    aiNote = 'AI helper: on.';
  } catch (e) {
    aiNote = `AI helper: off (${errMsg(e).slice(0, 120)}), using fixed rules.`;
  }
  log.info('quick', aiNote);
}

const PICK_SYSTEM = 'You read web pages for a sales-research tool. Answer only with the requested JSON.';

/** Asks Gemini which links on a directory page are company entries, and which one is "next page". Returns undefined if unavailable. */
async function aiReadList(page: Page, dirHost: string): Promise<{ companies: string[]; next?: string } | undefined> {
  if (!aiModels) return undefined;
  const seenHref = new Set<string>();
  const items = page.links
    .filter((l) => sameSite(hostOf(l.full), dirHost) && !seenHref.has(l.full) && seenHref.add(l.full))
    .slice(0, 250);
  if (!items.length) return undefined;
  const lines = items.map((l, i) => {
    const u = new URL(l.full);
    return `${i}. [${l.nav ? 'menu/footer' : 'content'}] "${l.text || '(no text)'}" -> ${u.pathname}${u.search}`;
  });
  const prompt = `This is a directory page on ${dirHost}. Page title: ${page.title.slice(0, 100)}
Below are its links, numbered. Decide:
(a) company_links: numbers of links that open ONE company / organisation / member / partner profile. Not menus, filters, categories, login, news, events, languages, social media or footer links.
(b) next_link: the number of the link that goes to the NEXT page of results (pagination), or null if there is none.

<untrusted_links>
${lines.join('\n')}
</untrusted_links>

Return JSON: {"company_links": [numbers], "next_link": number or null}`;
  try {
    const r = await askJson(
      prompt,
      z.object({ company_links: z.array(z.number()).optional(), next_link: z.number().nullish() }),
      { model: aiModels, system: PICK_SYSTEM, temperature: 0 },
    );
    const companies = [...new Set((r.company_links ?? []).filter((i) => Number.isInteger(i) && items[i]).map((i) => items[i].href))];
    const next = r.next_link != null && items[r.next_link] ? items[r.next_link].full : undefined;
    return { companies, next };
  } catch (e) {
    log.warn('quick', `AI could not read the list page, using fixed rules: ${errMsg(e).slice(0, 200)}`);
    return undefined;
  }
}

/** When a company shows several addresses, asks Gemini which one is the best place to send a business enquiry. */
async function aiBestFirst(candidates: string[], company: string): Promise<string[]> {
  if (!aiModels || candidates.length < 2) return candidates;
  const list = candidates.slice(0, 8);
  try {
    const r = await askJson(
      `Company: ${company || 'unknown'}\nWhich of these email addresses is the best one for sending a first business enquiry to the company? Prefer a general business, sales, export or contact address on the company's own domain. Avoid personal-looking, support-ticket, webmaster, careers or press addresses unless nothing else fits.\n\n<untrusted_emails>\n${list.map((e, i) => `${i}. ${e}`).join('\n')}\n</untrusted_emails>\n\nReturn JSON: {"best": number}`,
      z.object({ best: z.number() }),
      { model: aiModels, system: PICK_SYSTEM, temperature: 0 },
    );
    const pick = list[r.best];
    return pick ? [pick, ...candidates.filter((e) => e !== pick)] : candidates;
  } catch {
    return candidates;
  }
}

/** Saves the first address that is new, not opted out and can receive mail. Skips the company if it was already contacted. */
async function addContact(candidates: string[], c: { company: string; website: string | null; phone: string; source: string }) {
  const d = qdb();
  if (candidates.some((e) => isSuppressed(d, e) || d.prepare('SELECT 1 FROM leads WHERE email = ?').get(e))) return false;
  for (const email of await aiBestFirst(candidates, c.company)) {
    if (!(await hasMx(email.split('@')[1]))) continue;
    d.prepare(
      `INSERT INTO leads (name, company, website, source_url, email, phone, status, created_at, updated_at)
       VALUES ('', ?, ?, ?, ?, ?, 'q_found', ?, ?)`,
    ).run(c.company, c.website, c.source, email, c.phone, now(), now());
    log.info('quick', `found ${email}${c.company ? ` (${c.company})` : ''}`);
    return true;
  }
  return false;
}

/** A company's own website: the home page plus up to two contact/about pages. */
async function fromSite(origin: string, source: string): Promise<boolean> {
  const home = await fetchPage(origin);
  const host = hostOf(home.url);
  const emails = [...home.emails];
  const phones = [...home.phones];
  const extra = [...new Set(home.links.filter((l) => CONTACT_LINK.test(`${l.href} ${l.text}`)).map((l) => l.href))]
    .filter((u) => u !== home.url)
    .slice(0, 2);
  for (const u of extra) {
    try {
      const p = await fetchPage(u);
      emails.push(...p.emails);
      phones.push(...p.phones);
    } catch (e) {
      log.warn('quick', `${u}: ${errMsg(e)}`);
    }
  }
  return addContact(rank(emails, host), { company: companyName(home.title, host), website: home.url, phone: phones[0] ?? '', source });
}

/** A company's page inside the directory: use the email shown there, or follow its website link. */
async function fromProfile(url: string, source: string, dirHost: string, seen: Set<string>): Promise<boolean> {
  const p = await fetchPage(url);
  const emails = rank(p.emails).filter((e) => !sameSite(e.split('@')[1], dirHost));
  const site = p.external.find((o) => {
    const h = hostOf(o);
    return !isSkipHost(h) && !sameSite(h, dirHost);
  });
  if (emails.length) {
    return addContact(emails, { company: companyName(p.title, dirHost), website: site ?? null, phone: p.phones[0] ?? '', source });
  }
  if (!site || seen.has(hostOf(site))) return false;
  seen.add(hostOf(site));
  return fromSite(site, source);
}

async function runFind(urls: string[], limit: number) {
  const d = qdb();
  const seen = new Set<string>();
  for (const { website } of d.prepare(`SELECT website FROM leads WHERE website IS NOT NULL`).all() as { website: string }[]) {
    try {
      seen.add(hostOf(website));
    } catch {
      /* ignore bad stored url */
    }
  }
  let found = 0;
  await setupAi();
  const stats = { pages: 0, companyPages: 0, websites: 0, failed: 0, firstError: '', diag: '' };
  const fail = (e: unknown) => {
    stats.failed++;
    stats.firstError ||= errMsg(e).slice(0, 160);
  };
  const done = () => found >= limit || find.stop;
  const status = (s: string) => void (find.msg = `${s} Found ${found} of ${limit} so far.`);

  for (const start of urls) {
    const dirHost = hostOf(start);
    const visited = new Set<string>();
    let url: string | undefined = start;
    for (let n = 1; url && n <= MAX_PAGES && !done(); n++) {
      visited.add(url);
      status(`Reading ${dirHost}, page ${n}.`);
      let page: Page;
      try {
        page = await fetchListing(url);
      } catch (e) {
        log.warn('quick', `could not open ${url}: ${errMsg(e)}`);
        fail(e);
        break;
      }
      stats.pages++;

      // 1. Emails printed on the list itself (not the directory's own address).
      for (const email of rank(page.emails).filter((e) => !sameSite(e.split('@')[1], dirHost))) {
        if (done()) break;
        const domain = email.split('@')[1];
        if (!FREEMAIL.test(domain)) {
          if (seen.has(domain)) continue;
          seen.add(domain);
        }
        if (await addContact([email], { company: FREEMAIL.test(domain) ? '' : domain, website: null, phone: '', source: url })) found++;
      }

      // 2. Company pages inside the directory.
      const here = new URL(url);
      // Company entries are the links in the main content that share the most common address pattern
      // (for example many links like /organisation/xyz). Menu, header and footer links are ignored.
      const candidates = [
        ...new Set(
          page.links
            .filter((l) => !l.nav && l.text.length >= 2)
            .map((l) => l.href)
            .filter((href) => sameSite(hostOf(href), dirHost) && href !== here.origin + here.pathname && !visited.has(href))
            .filter((href) => !BORING_PATH.test(new URL(href).pathname) && new URL(href).pathname !== '/'),
        ),
      ];
      const byName = candidates.filter((href) => PROFILE_PATH.test(new URL(href).pathname));
      const pool = byName.length >= 3 ? byName : candidates;
      const groups = new Map<string, string[]>();
      for (const href of pool) groups.set(shapeOf(href), [...(groups.get(shapeOf(href)) ?? []), href]);
      const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
      const ruleProfiles = (best.length >= 3 ? best : []).slice(0, MAX_PROFILES_PER_PAGE);
      status(`Reading ${dirHost}, page ${n}: working out which links are companies.`);
      const ai = await aiReadList(page, dirHost);
      const aiCompanies = (ai?.companies ?? []).filter((h) => h !== here.origin + here.pathname && !visited.has(h));
      const profiles = aiCompanies.length ? aiCompanies.slice(0, MAX_PROFILES_PER_PAGE) : ruleProfiles;
      if (!stats.diag) {
        const top = [...groups.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 3)
          .map(([k, v]) => `${k} x${v.length}`)
          .join(', ');
        stats.diag = `First page: title "${page.title.slice(0, 60)}", ${page.text.length} characters of text, ${page.links.length} links (${page.links.filter((l) => !l.nav).length} outside menus), ${page.external.length} outside websites, ${page.emails.length} emails. Most common link patterns: ${top || 'none'}. AI picked ${aiCompanies.length} company links${ai?.next ? ' and a next-page link' : ''}.`;
      }
      for (const [i, href] of profiles.entries()) {
        if (done()) break;
        visited.add(href);
        stats.companyPages++;
        status(`Reading ${dirHost}, page ${n}, company ${i + 1} of ${profiles.length}.`);
        try {
          if (await fromProfile(href, url, dirHost, seen)) found++;
        } catch (e) {
          log.warn('quick', `${href}: ${errMsg(e)}`);
          fail(e);
        }
      }

      // 3. Company websites linked from the list.
      const sites = page.external
        .filter((o) => {
          const h = hostOf(o);
          return !isSkipHost(h) && !sameSite(h, dirHost) && !seen.has(h);
        })
        .slice(0, MAX_SITES_PER_PAGE);
      for (const [i, site] of sites.entries()) {
        if (done()) break;
        const h = hostOf(site);
        if (seen.has(h)) continue;
        seen.add(h);
        stats.websites++;
        status(`Reading ${dirHost}, page ${n}, website ${i + 1} of ${sites.length}.`);
        try {
          if (await fromSite(site, url)) found++;
        } catch (e) {
          log.warn('quick', `${site}: ${errMsg(e)}`);
          fail(e);
        }
      }

      let nextUrl = ai?.next ?? page.next;
      if (!nextUrl && profiles.length) {
        // No visible "next" button: many directories still accept ?page=1, ?page=2 ...
        const u = new URL(start);
        u.searchParams.set('page', String(n));
        nextUrl = u.href;
      }
      url = nextUrl && !visited.has(nextUrl) ? nextUrl : undefined;
    }
  }

  find.msg = find.stop
    ? `Stopped. Found ${found} new contacts.`
    : found >= limit
      ? `Done. Found ${found} new contacts.`
      : found
        ? `Went through every page. Found ${found} new contacts.`
        : `Found no new emails. Opened ${stats.pages} list page(s), ${stats.companyPages} company page(s) and ${stats.websites} website(s); ${stats.failed} failed${stats.firstError ? ` (first error: ${stats.firstError})` : ''}. The site may hide emails or block automated visitors. ${aiNote} ${stats.diag}`;
  log.info('quick', find.msg);
}

export function startFind(links: string[], limit: number) {
  if (find.running) throw new Error('Already looking for contacts. Wait for it to finish, or press Stop.');
  const urls = [...new Set(links.map((l) => l.trim()).filter(Boolean).map((l) => (/^https?:\/\//i.test(l) ? l : `https://${l}`)))];
  if (!urls.length) throw new Error('Paste at least one link.');
  for (const u of urls) {
    try {
      assertPublicUrl(u);
    } catch {
      throw new Error(`This is not a usable web address: ${u}`);
    }
  }
  const max = Math.min(Math.max(Math.round(limit) || 20, 1), 500);
  kvSet(qdb(), 'q_links', JSON.stringify(urls));
  kvSet(qdb(), 'q_limit', max);
  Object.assign(find, { running: true, stop: false, msg: 'Starting…' });
  void runFind(urls, max)
    .catch((e) => {
      find.msg = `Stopped because of an error: ${errMsg(e)}`;
      log.error('quick', find.msg);
    })
    .finally(() => (find.running = false));
}

/* --------------------------------- sending --------------------------------- */

const compose = (cfg: Config, body: string) =>
  `${body.trim()}\n\n${cfg.sender.name}${cfg.sender.title ? `\n${cfg.sender.title}` : ''}\n\n--\n${cfg.sender.footer}`;

const cleanSubject = (s: unknown) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
const cleanBody = (s: unknown) => String(s ?? '').trim().slice(0, 10_000);

async function notify(cfg: Config | null, title: string, text: string) {
  try {
    await createNotifier(cfg?.notifiers ?? ['telegram'], false).notify(title, text);
  } catch (e) {
    log.warn('notify', `${title} (not delivered: ${errMsg(e)})\n${text}`);
  }
}

export function saveTemplate(subject: unknown, body: unknown) {
  kvSet(qdb(), 'q_subject', cleanSubject(subject));
  kvSet(qdb(), 'q_body', cleanBody(body));
}

function checkReady(subject: string, body: string): Config {
  if (!subject) throw new Error('Write a subject first.');
  if (body.length < 20) throw new Error('Write the email message first.');
  const cfg = loadConfig();
  requireEnv('EMAIL_USER');
  requireEnv('EMAIL_PASS');
  return cfg;
}

/** Sends the email to your own address so you can see exactly what people will get. */
export async function sendTest(subject: unknown, body: unknown) {
  saveTemplate(subject, body);
  const s = cleanSubject(subject);
  const cfg = checkReady(s, cleanBody(body));
  const to = /<([^>]+)>/.exec(cfg.channels.email.from)?.[1] ?? requireEnv('EMAIL_USER');
  await createEmailChannel(cfg.channels.email, qdb()).send({ to, subject: `[Test] ${s}`, body: compose(cfg, cleanBody(body)) });
  return { to };
}

export function startSending(subject: unknown, body: unknown) {
  saveTemplate(subject, body);
  checkReady(cleanSubject(subject), cleanBody(body));
  const st = getState();
  if (st.status === 'running' && st.mode === 'live') throw new Error('The AI agent is running for real. Stop it on the Dashboard first.');
  const d = qdb();
  d.prepare(`UPDATE leads SET status = 'q_queued', updated_at = ? WHERE status = 'q_found'`).run(now());
  const queued = (d.prepare(`SELECT COUNT(*) AS n FROM leads WHERE status = 'q_queued'`).get() as { n: number }).n;
  if (!queued) throw new Error('Nobody is waiting to be emailed. Find contacts first.');
  kvSet(d, 'q_sending', 1);
  log.info('quick', `sending started: ${queued} emails waiting`);
  return { queued };
}

export function stopQuick() {
  find.stop = true;
  kvSet(qdb(), 'q_sending', 0);
}

export function removeContact(id: unknown) {
  qdb().prepare(`DELETE FROM leads WHERE id = ? AND status IN ('q_found','q_queued')`).run(Number(id));
}

export function clearUnsent() {
  qdb().prepare(`DELETE FROM leads WHERE status IN ('q_found','q_queued')`).run();
}

let sendFails = 0;

async function sendTick() {
  const d = qdb();
  if (kvGet(d, 'q_sending') !== '1' || Number(kvGet(d, 'q_next_at') ?? 0) > now()) return;
  const cfg = loadConfig();
  const sent24 = (d.prepare(`SELECT COUNT(*) AS n FROM emails WHERE angle_id = 'static' AND status = 'sent' AND sent_at > ?`).get(now() - DAY) as { n: number }).n;
  if (sent24 >= cfg.sending.maxPerDay) return;

  const lead = d.prepare(`SELECT id, email, company FROM leads WHERE status = 'q_queued' ORDER BY id LIMIT 1`).get() as
    | { id: number; email: string; company: string }
    | undefined;
  if (!lead) {
    kvSet(d, 'q_sending', 0);
    const total = (d.prepare(`SELECT COUNT(*) AS n FROM leads WHERE status IN ('q_sent','q_replied','q_no','q_bounced')`).get() as { n: number }).n;
    log.info('quick', 'all emails sent');
    await notify(cfg, 'All emails sent', `${total} people emailed in total. You will get a message here when someone replies.`);
    return;
  }
  if (isSuppressed(d, lead.email)) {
    d.prepare(`UPDATE leads SET status = 'q_skipped', updated_at = ? WHERE id = ?`).run(now(), lead.id);
    return;
  }

  const subject = kvGet(d, 'q_subject') ?? '';
  const body = compose(cfg, kvGet(d, 'q_body') ?? '');
  try {
    const { messageId } = await createEmailChannel(cfg.channels.email, d).send({ to: lead.email, subject, body });
    d.prepare(
      `INSERT INTO emails (lead_id, angle_id, subject, body, status, message_id, sent_at, created_at) VALUES (?, 'static', ?, ?, 'sent', ?, ?, ?)`,
    ).run(lead.id, subject, body, messageId, now(), now());
    d.prepare(`UPDATE leads SET status = 'q_sent', updated_at = ? WHERE id = ?`).run(now(), lead.id);
    sendFails = 0;
    kvSet(d, 'q_next_at', now() + rand(cfg.sending.minGapMinutes, cfg.sending.maxGapMinutes) * 60_000);
    log.info('quick', `sent to ${lead.email}${lead.company ? ` (${lead.company})` : ''}`);
  } catch (e) {
    log.error('quick', `could not send to ${lead.email}: ${errMsg(e)}`);
    if (++sendFails >= 3) {
      sendFails = 0;
      kvSet(d, 'q_sending', 0);
      await notify(cfg, 'Sending stopped', `3 emails in a row failed, so sending was stopped. Last error: ${errMsg(e)}`);
    }
  }
}

/* --------------------------------- replies --------------------------------- */

type SentRow = { id: number; lead_id: number; email: string; company: string };

function findSent(d: DB, m: { inReplyTo: string | null; references: string[]; from: string }): SentRow | undefined {
  const base = `SELECT e.id, e.lead_id, l.email, l.company FROM emails e JOIN leads l ON l.id = e.lead_id
                WHERE e.status = 'sent' AND e.angle_id = 'static'`;
  for (const id of [m.inReplyTo, ...m.references].filter((x): x is string => !!x)) {
    const r = d.prepare(`${base} AND e.message_id = ?`).get(id) as SentRow | undefined;
    if (r) return r;
  }
  return d.prepare(`${base} AND l.email = ? ORDER BY e.sent_at DESC LIMIT 1`).get(m.from) as SentRow | undefined;
}

async function replyTick() {
  const d = qdb();
  if (!d.prepare(`SELECT 1 FROM leads WHERE status IN ('q_sent','q_replied') LIMIT 1`).get()) return;
  const st = getState();
  if (st.status === 'running' && st.mode === 'live') return; // the AI agent reads the inbox itself while it runs
  const cfg = loadConfig();
  const inbound = await createEmailChannel(cfg.channels.email, d).pollInbound();

  for (const m of inbound) {
    if (BOUNCE.test(m.from) || BOUNCE_SUBJECT.test(m.subject)) {
      const hay = m.text.toLowerCase();
      const sent = d.prepare(`SELECT e.id, e.lead_id, l.email FROM emails e JOIN leads l ON l.id = e.lead_id WHERE e.angle_id = 'static' AND e.outcome = 'none'`).all() as SentRow[];
      for (const s of sent.filter((x) => hay.includes(x.email.toLowerCase()))) {
        d.prepare(`UPDATE emails SET outcome = 'bounce' WHERE id = ?`).run(s.id);
        d.prepare(`UPDATE leads SET status = 'q_bounced', updated_at = ? WHERE id = ?`).run(now(), s.lead_id);
        suppress(d, s.email, 'bounce');
        log.info('quick', `bounced: ${s.email}`);
      }
      continue;
    }
    const row = findSent(d, m);
    if (!row) continue; // unrelated inbox mail
    const reply = trunc(newText(m.text), 3000);
    if (AUTO_SUBJECT.test(m.subject) || AUTO_TEXT.test(reply.slice(0, 500))) {
      log.info('quick', `automatic reply from ${row.email} ignored`);
      continue;
    }
    const no = SAYS_NO.test(reply);
    d.prepare(`UPDATE emails SET outcome = ?, reply_text = ?, replied_at = ? WHERE id = ?`).run(no ? 'negative' : 'other', reply, now(), row.id);
    d.prepare(`UPDATE leads SET status = ?, updated_at = ? WHERE id = ?`).run(no ? 'q_no' : 'q_replied', now(), row.lead_id);
    if (no) suppress(d, row.email, 'said no');
    await notify(
      cfg,
      `${no ? 'Reply (says no)' : 'REPLY NEEDS YOU'}: ${row.company || row.email}`,
      `${reply || '(empty message)'}\n\nFrom: ${row.email}\nSubject: ${m.subject}`,
    );
  }
}

/* ---------------------------------- status --------------------------------- */

export function quickStatus() {
  const d = qdb();
  const counts = Object.fromEntries(
    (d.prepare(`SELECT status, COUNT(*) AS n FROM leads WHERE status IN ${IN_STATUSES} GROUP BY status`).all() as { status: string; n: number }[]).map((r) => [
      r.status.slice(2),
      r.n,
    ]),
  );
  let links: string[] = [];
  try {
    links = JSON.parse(kvGet(d, 'q_links') ?? '[]');
  } catch {
    /* ignore */
  }
  return {
    finding: find.running,
    findMsg: find.msg,
    sending: kvGet(d, 'q_sending') === '1',
    nextAt: Number(kvGet(d, 'q_next_at') ?? 0),
    links,
    limit: Number(kvGet(d, 'q_limit') ?? 20),
    subject: kvGet(d, 'q_subject') ?? '',
    body: kvGet(d, 'q_body') ?? '',
    counts,
    contacts: d
      .prepare(
        `SELECT l.id, l.company, l.email, l.phone, l.website, l.source_url AS source, substr(l.status, 3) AS status, e.reply_text AS reply
         FROM leads l LEFT JOIN emails e ON e.lead_id = l.id AND e.angle_id = 'static'
         WHERE l.status IN ${IN_STATUSES} ORDER BY l.id DESC LIMIT 300`,
      )
      .all(),
  };
}

/** Background loops: send the next email when it is time, and check the inbox for replies. Survive restarts. */
export function startQuickLoops() {
  const loop = (name: string, ms: number, fn: () => Promise<void>) => {
    let busy = false;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await fn();
      } catch (e) {
        if (!(e instanceof NeedsSetup)) log.warn(name, errMsg(e));
      } finally {
        busy = false;
      }
    }, ms).unref();
  };
  loop('quick', 30_000, sendTick);
  loop('quick', 5 * 60_000, replyTick);
}

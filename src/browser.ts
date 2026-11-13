import * as cheerio from 'cheerio';
import puppeteer, { type Browser } from 'puppeteer';
import { log, errMsg } from './util.js';

export interface Page {
  url: string;
  title: string;
  text: string;
  links: { href: string; text: string }[];
  /** Links to other websites (for example company sites listed in a directory). */
  external: string[];
  emails: string[];
  phones: string[];
  /** The "next page" link, if the page has one. */
  next?: string;
}

const UA = 'Mozilla/5.0 (compatible; OutreachResearchBot/1.0)';
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// International numbers written with + and Indian 10-digit mobiles.
const PHONE_RE = /\+\d{1,3}[\s.-]?\(?\d{1,5}\)?(?:[\s.-]?\d{2,5}){2,4}|\b[6-9]\d{4}[\s-]?\d{5}\b/g;
const NEXT_TEXT = /^(next|next page|next\s*[›»>]+|[›»]|>|>>)$/i;

function cleanPhone(raw: string): string | undefined {
  const p = raw.replace(/[^\d+]/g, '');
  const digits = p.replace(/\D/g, '').length;
  return digits >= 10 && digits <= 15 ? p : undefined;
}
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$)|\.(local|internal|localhost)$/i;

/** Only public http(s) URLs may be fetched (guards against SSRF via scraped/LLM-provided URLs). */
export function assertPublicUrl(raw: string): URL {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(u.hostname)) throw new Error(`Blocked URL: ${raw}`);
  return u;
}

function parse(url: string, html: string): Page {
  const $ = cheerio.load(html);
  const emails = new Set<string>();
  $('a[href^="mailto:"]').each((_, el) => {
    const addr = ($(el).attr('href') ?? '').replace(/^mailto:/i, '').split('?')[0];
    if (addr) emails.add(decodeURIComponent(addr).toLowerCase());
  });
  const phones = new Set<string>();
  $('a[href^="tel:"]').each((_, el) => {
    const p = cleanPhone(decodeURIComponent(($(el).attr('href') ?? '').slice(4)));
    if (p) phones.add(p);
  });
  const links: Page['links'] = [];
  const external = new Set<string>();
  const base = new URL(url);
  let next: string | undefined;
  const nextHref = $('link[rel~="next"], a[rel~="next"]').first().attr('href');
  $('a[href]').each((_, el) => {
    try {
      const u = new URL($(el).attr('href')!, base);
      if (!/^https?:$/.test(u.protocol)) return;
      const label = ($(el).text().trim() || $(el).attr('aria-label') || $(el).attr('title') || '').trim();
      if (u.hostname === base.hostname) {
        links.push({ href: u.origin + u.pathname, text: label.slice(0, 80) });
        if (!next && !nextHref && NEXT_TEXT.test(label) && u.href !== base.href) next = u.href;
      } else {
        external.add(u.origin);
      }
    } catch {
      /* ignore malformed href */
    }
  });
  if (nextHref) {
    try {
      const u = new URL(nextHref, base);
      if (/^https?:$/.test(u.protocol) && u.href !== base.href) next = u.href;
    } catch {
      /* ignore malformed href */
    }
  }
  const title = $('title').first().text().replace(/\s+/g, ' ').trim();
  $('script,style,noscript,svg,iframe').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  for (const m of text.match(EMAIL_RE) ?? []) emails.add(m.toLowerCase());
  for (const m of text.match(PHONE_RE) ?? []) {
    const p = cleanPhone(m);
    if (p) phones.add(p);
  }
  return { url, title, text, links, external: [...external], emails: [...emails], phones: [...phones], next };
}

let browser: Browser | undefined;
let idleTimer: NodeJS.Timeout | undefined;

async function renderWithBrowser(url: string, scroll = false): Promise<string> {
  browser ??= await puppeteer.launch({
    headless: true,
    args: process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
  });
  clearTimeout(idleTimer);
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setRequestInterception(true);
    page.on('request', (req) =>
      ['image', 'media', 'font', 'stylesheet'].includes(req.resourceType()) ? void req.abort() : void req.continue(),
    );
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
    if (scroll) {
      // Scroll top to bottom so lists that load more items as you scroll are fully shown.
      await page.evaluate(`(async () => {
        for (let i = 0; i < 25; i++) {
          window.scrollBy(0, window.innerHeight);
          await new Promise((r) => setTimeout(r, 500));
          if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 5) break;
        }
      })()`);
    }
    return await page.content();
  } finally {
    await page.close().catch(() => {});
    // Free RAM when idle (matters on small machines).
    idleTimer = setTimeout(() => void closeBrowser(), 60_000);
    idleTimer.unref();
  }
}

export async function closeBrowser() {
  clearTimeout(idleTimer);
  const b = browser;
  browser = undefined;
  await b?.close().catch(() => {});
}

/** Fast path: plain fetch + cheerio. Falls back to headless Chromium only for JS-rendered pages. */
export async function fetchPage(rawUrl: string): Promise<Page> {
  const url = assertPublicUrl(rawUrl).href;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok && (res.headers.get('content-type') ?? '').includes('html')) {
      const page = parse(res.url || url, (await res.text()).slice(0, 2_000_000));
      if (page.text.length >= 400) return page;
    }
  } catch (e) {
    log.warn('browser', `fast fetch failed for ${url}: ${errMsg(e)}`);
  }
  return parse(url, await renderWithBrowser(url));
}

/** For listing pages: always uses the real browser and scrolls to the bottom. Falls back to a plain fetch. */
export async function fetchListing(rawUrl: string): Promise<Page> {
  const url = assertPublicUrl(rawUrl).href;
  try {
    return parse(url, await renderWithBrowser(url, true));
  } catch (e) {
    log.warn('browser', `browser failed for ${url}, trying plain fetch: ${errMsg(e)}`);
    return fetchPage(url);
  }
}

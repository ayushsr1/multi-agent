import * as cheerio from 'cheerio';
import puppeteer, { type Browser } from 'puppeteer';
import { log, errMsg } from './util.js';

export interface Page {
  url: string;
  text: string;
  links: { href: string; text: string }[];
  emails: string[];
}

const UA = 'Mozilla/5.0 (compatible; OutreachResearchBot/1.0)';
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
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
  const links: Page['links'] = [];
  const base = new URL(url);
  $('a[href]').each((_, el) => {
    try {
      const u = new URL($(el).attr('href')!, base);
      if (u.hostname === base.hostname && /^https?:$/.test(u.protocol)) {
        links.push({ href: u.origin + u.pathname, text: $(el).text().trim().slice(0, 80) });
      }
    } catch {
      /* ignore malformed href */
    }
  });
  $('script,style,noscript,svg,iframe').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  for (const m of text.match(EMAIL_RE) ?? []) emails.add(m.toLowerCase());
  return { url, text, links, emails: [...emails] };
}

let browser: Browser | undefined;
let idleTimer: NodeJS.Timeout | undefined;

async function renderWithBrowser(url: string): Promise<string> {
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

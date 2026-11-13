'use strict';
// All dynamic text goes through textContent (via h()), never innerHTML: scraped web data is displayed here.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}

async function api(path, body) {
  let res;
  try {
    // Never spin forever: the server answers tests within ~75s, so 90s means the connection is stuck.
    const opts = { signal: AbortSignal.timeout(90_000) };
    res = await fetch(path, body === undefined ? opts : { ...opts, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'No answer after 90 seconds. The server may be restarting or blocked from reaching Google. Reload the page and try again.' : `Could not reach the agent: ${e.message}`);
  }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error */ }
  if (!res.ok) {
    const e = new Error(data.error || `Request failed (${res.status})`);
    e.issues = data.issues;
    throw e;
  }
  return data;
}

const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function setPath(o, p, v) {
  const ks = p.split('.');
  let cur = o;
  ks.slice(0, -1).forEach((k, i) => { cur = cur[k] ??= /^\d+$/.test(ks[i + 1]) ? [] : {}; });
  cur[ks[ks.length - 1]] = v;
}
const ago = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/* ------------------------------ settings form ------------------------------ */

const PROVIDERS = {
  gmail: { label: 'Gmail', smtp: ['smtp.gmail.com', 465, true], imap: ['imap.gmail.com', 993, true] },
  zoho: { label: 'Zoho Mail (zoho.com)', smtp: ['smtp.zoho.com', 465, true], imap: ['imap.zoho.com', 993, true] },
  zohoin: { label: 'Zoho Mail India (zoho.in)', smtp: ['smtp.zoho.in', 465, true], imap: ['imap.zoho.in', 993, true] },
  zohoeu: { label: 'Zoho Mail Europe (zoho.eu)', smtp: ['smtp.zoho.eu', 465, true], imap: ['imap.zoho.eu', 993, true] },
  outlook: { label: 'Outlook / Microsoft 365 (often blocks this)', smtp: ['smtp-mail.outlook.com', 587, false], imap: ['outlook.office365.com', 993, true] },
  other: { label: 'Other (fill in the servers below)' },
};

const SECTIONS = [
  { title: '1. Your goal and who to reach', fields: [
    { path: 'goal', label: 'What do you want?', type: 'textarea', rows: 3, help: 'In plain words. Example: Get 5 sales calls a week with small marketing agencies.' },
    { path: 'audience', label: 'Who should the agent contact?', type: 'textarea', rows: 3, help: 'The kind of business and the kind of person. Example: Founders of marketing agencies with 2 to 20 staff in the US and UK.' },
    { path: 'discovery.hints', label: 'Where should it look? (optional)', type: 'lines', rows: 3, help: 'One idea per line, such as a city, a directory or a niche. Leave blank and it will work it out.' },
  ] },
  { title: '2. What you are offering', fields: [
    { path: 'product.name', label: 'Product or company name', type: 'text' },
    { path: 'product.url', label: 'Website (optional)', type: 'text', ph: 'https://' },
    { path: 'product.description', label: 'What it is', type: 'textarea', rows: 3, help: 'Two or three plain sentences.' },
    { path: 'product.pitch', label: 'Why someone should care', type: 'textarea', rows: 3, help: 'The main benefit, in your own words.' },
    { path: 'product.proofPoints', label: 'Proof (optional)', type: 'lines', rows: 3, help: 'One per line: results, customers, numbers. The agent only uses what you list here.' },
    { path: 'product.callToAction', label: 'What should people do next?', type: 'text', ph: 'Worth a quick chat?' },
  ] },
  { title: '3. Who the emails are from', fields: [
    { path: 'sender.name', label: 'Your name', type: 'text' },
    { path: 'sender.title', label: 'Your role (optional)', type: 'text' },
    { path: 'sender.footer', label: 'Opt-out line added to every email', type: 'textarea', rows: 2, help: 'Keep this. It lets people say no, and it protects your email address.' },
  ] },
  { title: '4. Your email account', intro: 'The agent sends and reads replies from this account. Use a dedicated mailbox, not your main one.', fields: [
    { kind: 'provider' },
    { path: 'channels.email.from', label: 'Show emails as coming from', type: 'text', ph: 'Your Name <you@yourdomain.com>' },
    { secret: 'EMAIL_USER', plain: true, label: 'Email login (usually your address)', type: 'text' },
    { secret: 'EMAIL_PASS', label: 'Email password', type: 'password', help: 'Use an app password, not your main one. Zoho: Accounts, Security, App Passwords, Generate. Gmail: Google Account, Security, 2-Step Verification, App passwords.' },
    { kind: 'servers' },
    { kind: 'test', action: 'email', label: 'Test email login' },
  ] },
  { title: '5. Where to tell you about replies', intro: 'The agent only messages you when someone replies or something needs you.', fields: [
    { path: 'notifiers', label: 'Notify me by', type: 'checks', options: [['telegram', 'Telegram'], ['webhook', 'Webhook (Slack, Discord, etc.)']] },
    { secret: 'TELEGRAM_BOT_TOKEN', label: 'Telegram bot token', type: 'password', help: 'In Telegram, chat with @BotFather, send /newbot, and paste the token it gives you.' },
    { secret: 'TELEGRAM_CHAT_ID', plain: true, label: 'Telegram chat ID', type: 'text', help: 'Open your new bot in Telegram, press Start and send "hi". Then click the button below.' },
    { kind: 'test', action: 'telegram', label: 'Find my chat ID' },
    { secret: 'WEBHOOK_URL', label: 'Webhook address (only if you chose Webhook)', type: 'password' },
    { kind: 'test', action: 'notify', label: 'Send a test notification' },
  ] },
  { title: '6. Gemini (the AI)', intro: 'Get a free key at aistudio.google.com/apikey. A Gemini app subscription does not include API access; this key is separate.', fields: [
    { secret: 'GEMINI_API_KEY', label: 'Gemini API key', type: 'password' },
    { path: 'models.fast', label: 'Fast models (in order of preference)', type: 'csv', help: 'Comma separated. If one runs out of quota the next is used.' },
    { path: 'models.smart', label: 'Careful models (for writing and review)', type: 'csv' },
    { path: 'llm.requestsPerMinute', label: 'Requests per minute', type: 'number', help: 'Lower this if you see quota errors. Free keys are slow; 8 is safe.' },
    { kind: 'test', action: 'gemini', label: 'Test Gemini key' },
  ] },
  { title: 'Advanced (you can leave all of this alone)', advanced: true, fields: [
    { path: 'sending.startPerDay', label: 'Emails on day one', type: 'number', help: 'Starting low protects your sender reputation.' },
    { path: 'sending.rampPerDay', label: 'Add this many each day', type: 'number' },
    { path: 'sending.maxPerDay', label: 'Never more than, per day', type: 'number' },
    { path: 'sending.hours.0', label: 'Send from hour (0 to 23)', type: 'number' },
    { path: 'sending.hours.1', label: 'Send until hour (0 to 23)', type: 'number' },
    { path: 'sending.timezone', label: 'Time zone', type: 'text', ph: 'America/New_York' },
    { path: 'sending.weekdaysOnly', label: 'Weekdays only', type: 'bool' },
    { path: 'sending.minGapMinutes', label: 'Shortest wait between emails (minutes)', type: 'number' },
    { path: 'sending.maxGapMinutes', label: 'Longest wait between emails (minutes)', type: 'number' },
    { path: 'discovery.batchSize', label: 'People to look for per search', type: 'number' },
    { path: 'quality.minFit', label: 'Minimum fit score to contact (1 to 10)', type: 'number' },
    { path: 'quality.minCriticScore', label: 'Minimum quality score to send (1 to 10)', type: 'number' },
    { path: 'quality.maxRevisions', label: 'Rewrites allowed per email', type: 'number' },
    { path: 'quality.settleDays', label: 'Days of silence that count as "no"', type: 'number' },
    { path: 'explorer.intervalHours', label: 'Look for new approaches every (hours)', type: 'number' },
    { path: 'explorer.subreddits', label: 'Reddit communities to learn from', type: 'lines', rows: 3, help: 'One per line, without r/.' },
    { path: 'explorer.queries', label: 'Web searches to learn from', type: 'lines', rows: 3 },
    { path: 'explorer.knowledgeDir', label: 'Folder of your own books and notes (.txt, .md, .pdf)', type: 'text' },
    { path: 'backup.dir', label: 'Backup folder (for example inside Google Drive)', type: 'text', help: 'Leave blank for no backups.' },
    { path: 'backup.everyHours', label: 'Back up every (hours)', type: 'number' },
    { path: 'backup.keep', label: 'Backups to keep', type: 'number' },
  ] },
];

const labels = {};
let envInfo = {};

function fieldEl(f) {
  if (f.kind === 'provider') {
    return h('label', { class: 'field' }, h('span', { class: 'lbl', text: 'Email provider' }),
      h('select', { id: 'provider', onchange: (e) => applyProvider(e.target.value) },
        Object.entries(PROVIDERS).map(([k, p]) => h('option', { value: k, text: p.label }))));
  }
  if (f.kind === 'servers') {
    const pair = (path, label, type) => fieldEl({ path, label, type });
    return h('details', {}, h('summary', { text: 'Mail servers (filled in for you)' }),
      h('div', { class: 'grid2' },
        pair('channels.email.smtp.host', 'Sending server', 'text'), pair('channels.email.smtp.port', 'Sending port', 'number'),
        pair('channels.email.smtp.secure', 'Sending uses SSL', 'bool'), h('span'),
        pair('channels.email.imap.host', 'Reading server', 'text'), pair('channels.email.imap.port', 'Reading port', 'number'),
        pair('channels.email.imap.secure', 'Reading uses SSL', 'bool')));
  }
  if (f.kind === 'test') {
    const out = h('div', { class: 'result' });
    const btn = h('button', { class: 'btn', type: 'button', onclick: () => runTest(btn, out, f.action), text: f.label });
    return h('div', { class: 'field' }, btn, out);
  }

  const key = f.path || f.secret;
  labels[key] = f.label;
  const attrs = f.secret ? { 'data-secret': f.secret } : { 'data-path': f.path, 'data-type': f.type };
  let input;
  switch (f.type) {
    case 'textarea': case 'lines':
      input = h('textarea', { ...attrs, rows: f.rows || 3, placeholder: f.ph });
      break;
    case 'bool':
      return h('label', { class: 'field check' }, h('input', { type: 'checkbox', ...attrs }), h('span', { text: f.label }));
    case 'checks':
      return h('div', { class: 'field' }, h('span', { class: 'lbl', text: f.label }),
        h('div', { class: 'row' }, f.options.map(([v, t]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: v, ...attrs }), h('span', { text: t })))));
    case 'number':
      input = h('input', { type: 'number', step: 'any', ...attrs });
      break;
    case 'password':
      input = h('input', { type: 'password', autocomplete: 'new-password', ...attrs });
      break;
    default:
      input = h('input', { type: 'text', placeholder: f.ph, ...attrs });
  }
  return h('label', { class: 'field' }, h('span', { class: 'lbl', text: f.label }, f.secret ? h('span', { class: 'tag', 'data-tag': f.secret, hidden: true, text: 'saved' }) : null),
    f.help ? h('small', { text: f.help }) : null, input);
}

function buildForm() {
  const form = $('#form');
  for (const s of SECTIONS) {
    const body = [s.intro ? h('p', { class: 'muted', text: s.intro }) : null, s.fields.map(fieldEl)];
    form.append(s.advanced ? h('details', { class: 'card' }, h('summary', { text: s.title }), body) : h('div', { class: 'card' }, h('h3', { text: s.title }), body));
  }
}

function readForm() {
  const config = {}, secrets = {};
  // Create every section up front so a blank field is reported on the field itself, not on its section.
  for (const el of $$('[data-path]')) setPath(config, el.dataset.path, undefined);
  for (const el of $$('[data-path]')) {
    const path = el.dataset.path, type = el.dataset.type;
    const raw = el.value ? el.value.trim() : '';
    if (type === 'checks') setPath(config, path, $$(`[data-path="${path}"]:checked`).map((e) => e.value));
    else if (type === 'bool') setPath(config, path, el.checked);
    else if (type === 'number') { if (raw !== '') setPath(config, path, Number(raw)); }
    else if (type === 'lines') setPath(config, path, el.value.split('\n').map((s) => s.trim()).filter(Boolean));
    else if (type === 'csv') setPath(config, path, raw.split(',').map((s) => s.trim()).filter(Boolean));
    else if (raw !== '') setPath(config, path, raw);
  }
  for (const el of $$('[data-secret]')) if (el.value.trim()) secrets[el.dataset.secret] = el.value.trim();
  return { config, secrets };
}

function fillForm(config) {
  for (const el of $$('[data-path]')) {
    const v = getPath(config, el.dataset.path), type = el.dataset.type;
    if (v === undefined) continue;
    if (type === 'checks') el.checked = Array.isArray(v) && v.includes(el.value);
    else if (type === 'bool') el.checked = !!v;
    else if (type === 'lines') el.value = Array.isArray(v) ? v.join('\n') : '';
    else if (type === 'csv') el.value = Array.isArray(v) ? v.join(', ') : String(v);
    else el.value = String(v);
  }
  const host = getPath(config, 'channels.email.smtp.host');
  $('#provider').value = Object.keys(PROVIDERS).find((k) => PROVIDERS[k].smtp?.[0] === host) || 'other';
}

function applyEnv(env) {
  envInfo = env;
  for (const el of $$('[data-secret]')) {
    const k = el.dataset.secret, info = env[k] || {};
    el.value = '';
    if (info.value !== undefined && info.set) el.value = info.value;
    el.placeholder = info.set && info.value === undefined ? 'Saved. Leave blank to keep it.' : '';
    const tag = $(`[data-tag="${k}"]`);
    if (tag) tag.hidden = !info.set;
  }
}

function applyProvider(key) {
  const p = PROVIDERS[key];
  if (!p?.smtp) return;
  const set = (path, v) => { const el = $(`[data-path="${path}"]`); if (el.type === 'checkbox') el.checked = v; else el.value = v; };
  ['smtp', 'imap'].forEach((k) => { set(`channels.email.${k}.host`, p[k][0]); set(`channels.email.${k}.port`, p[k][1]); set(`channels.email.${k}.secure`, p[k][2]); });
}

function banner(text, kind) {
  const b = $('#banner');
  b.hidden = !text;
  b.textContent = text || '';
  b.className = `msg ${kind || ''}`;
}

function clearErrors() {
  $$('.field.bad').forEach((f) => f.classList.remove('bad'));
  $$('.field .err').forEach((e) => e.remove());
}

function showIssues(issues) {
  let first;
  for (const i of issues) {
    const el = $(`[data-path="${CSS.escape(i.path)}"]`);
    const field = el?.closest('.field');
    if (!field) continue;
    el.closest('details')?.setAttribute('open', '');
    field.classList.add('bad');
    field.append(h('div', { class: 'err', text: i.message === 'Required' ? 'Please fill this in.' : i.message }));
    first ??= field;
  }
  first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const shown = issues.filter((i) => $(`[data-path="${CSS.escape(i.path)}"]`)).length;
  const others = issues.filter((i) => !$(`[data-path="${CSS.escape(i.path)}"]`)).map((i) => `${i.path}: ${i.message}`);
  banner(`Not saved yet. ${shown ? `Please fix the ${shown} field(s) marked in red.` : ''}${others.length ? `\n${others.join('\n')}` : ''}`, 'bad');
}

async function saveSettings({ secretsOnly = false } = {}) {
  clearErrors();
  banner('');
  const { config, secrets } = readForm();
  try {
    const r = await api('/api/settings', { config, secrets, secretsOnly });
    applyEnv(r.env);
    if (!secretsOnly) {
      banner(status?.agent.status === 'running' ? 'Saved. Stop and start the agent for the changes to take effect.' : 'Saved.', 'ok');
      $('#welcome').hidden = true;
      refreshStatus();
    }
    return true;
  } catch (e) {
    if (e.issues) showIssues(e.issues);
    else banner(e.message, 'bad');
    return false;
  }
}

function setResult(out, text, kind) { out.textContent = text; out.className = `result ${kind || ''}`; }

async function runTest(btn, out, action) {
  btn.disabled = true;
  setResult(out, 'Working…');
  try {
    const needsFullSave = action === 'email' || action === 'notify';
    if (!(await saveSettings({ secretsOnly: !needsFullSave }))) return setResult(out, 'Please fix the highlighted fields first.', 'bad');
    if (action === 'gemini') {
      const r = await api('/api/test/gemini', {});
      const bad = r.probes.filter((p) => !p.ok);
      const lines = r.probes.map((p) => `${p.model}: ${p.ok ? 'works' : `FAILED. ${p.error}`}`);
      if (bad.length) lines.push(`\nModels your key can list: ${r.models.slice(0, 12).join(', ')}${r.models.length > 12 ? ', …' : ''}`);
      // 503/504 mean Google accepted the key but its servers are overloaded.
      const busy = !r.ok && bad.every((p) => /\b50[34]\b|UNAVAILABLE|DEADLINE_EXCEEDED|high demand/i.test(p.error || ''));
      if (busy) lines.unshift('Your key is accepted. Google\'s servers are busy right now, which is temporary. The agent waits and retries on its own, so you can carry on.\n');
      setResult(out, lines.join('\n'), r.ok || busy ? 'ok' : 'bad');
    } else if (action === 'email') {
      const r = await api('/api/test/email', {});
      const line = (name, x) => `${name}: ${x.ok ? 'works' : `failed. ${x.error}`}`;
      const failed = !r.smtp.ok || !r.imap.ok;
      setResult(out, `${line('Sending', r.smtp)}\n${line('Reading replies', r.imap)}${failed && $('#provider').value === 'gmail' ? '\nGmail needs an App Password (not your normal password) and IMAP turned on in Gmail settings.' : ''}${failed && $('#provider').value.startsWith('zoho') ? '\nZoho: check the region matches your account (.com, .in or .eu), IMAP is turned on in Zoho Mail settings, and use an app password.' : ''}`, failed ? 'bad' : 'ok');
    } else if (action === 'notify') {
      const r = await api('/api/test/notify', {});
      setResult(out, r.results.map((x) => `${x.name}: ${x.ok ? 'sent, check your phone' : `failed. ${x.error}`}`).join('\n'), r.results.every((x) => x.ok) ? 'ok' : 'bad');
    } else if (action === 'telegram') {
      const r = await api('/api/telegram/detect', {});
      applyEnv((await api('/api/settings')).env);
      setResult(out, `Found your chat (${r.name}) and saved it.`, 'ok');
    }
  } catch (e) {
    setResult(out, e.message, 'bad');
  } finally {
    btn.disabled = false;
  }
}

async function loadSettings() {
  const r = await api('/api/settings');
  fillForm(r.config);
  applyEnv(r.env);
  return r.saved;
}

/* -------------------------------- dashboard -------------------------------- */

let status = null;
let lastLog = 0;

const READY_LABELS = { settings: 'Goal and audience saved', gemini: 'Gemini key added', email: 'Email account added', notifier: 'Notifications set up' };

async function refreshStatus() {
  try { status = await api('/api/status'); } catch { return; }
  const { agent, ready } = status;
  const pill = $('#pill');
  const live = agent.mode === 'live';
  pill.textContent = { stopped: 'Stopped', starting: 'Starting…', stopping: 'Stopping…', running: live ? 'Running for real' : 'Running (practice, nothing is sent)' }[agent.status];
  pill.className = `pill ${agent.status === 'running' ? (live ? 'live' : 'run') : ''}`;
  const stopped = agent.status === 'stopped';
  $('#btn-dry').disabled = !(stopped && ready.settings && ready.gemini);
  $('#btn-live').disabled = !(stopped && ready.settings && ready.gemini && ready.email);
  $('#btn-stop').disabled = agent.status !== 'running';
  if (agent.error && stopped) agentMsg(`The last start failed: ${agent.error}`, 'bad');
  const ul = $('#ready');
  ul.replaceChildren(...Object.entries(READY_LABELS).map(([k, t]) => h('li', { class: ready[k] ? 'ok' : '', text: t })));
}

function agentMsg(text, kind) {
  const m = $('#agent-msg');
  m.hidden = !text;
  m.textContent = text || '';
  m.className = `msg ${kind || ''}`;
}

async function startAgent(mode) {
  if (mode === 'live' && !confirm('Start for real? The agent will begin emailing real people within your daily limit. A practice run first is recommended.')) return;
  agentMsg('Starting…');
  try {
    await api('/api/agent/start', { mode, confirm: mode === 'live' });
    $('#dataset').value = mode === 'live' ? 'live' : 'dry';
    agentMsg('');
  } catch (e) {
    agentMsg(e.message, 'bad');
  }
  refreshStatus();
  refreshStats();
}

const OUTCOME = {
  positive: ['Interested', 'good'], question: ['Has a question', 'good'], other: ['Needs your look', 'attn'],
  negative: ['Not interested', 'bad'], unsubscribe: ['Unsubscribed', 'bad'], none: ['No reply yet', ''], bounce: ['Bounced', 'bad'],
};
const needsAttention = (o) => o === 'positive' || o === 'question' || o === 'other';
const badge = (outcome) => { const [t, c] = OUTCOME[outcome] || [outcome, '']; return h('span', { class: `badge ${c}`, text: t }); };
const empty = (t) => h('p', { class: 'muted', text: t });

function renderStats(s) {
  const dry = $('#dataset').value === 'dry';
  const total = Object.values(s.leads).reduce((a, b) => a + b, 0);
  const o = s.outcomes;
  const interested = (o.positive || 0) + (o.question || 0);
  const cards = [
    ['People found', total], [dry ? 'Emails written (practice)' : 'Emails sent', s.emails.sentTotal],
    ['Last 24 hours', `${s.emails.sentToday} / ${s.emails.dailyCap ?? '?'}`], ['Waiting to send', s.emails.queued],
    ['Interested', interested], ['Said no', (o.negative || 0) + (o.unsubscribe || 0)],
  ];
  $('#cards').replaceChildren(...cards.map(([t, v]) => h('div', { class: 'stat' }, h('b', { text: String(v) }), h('span', { text: t }))));

  const replies = [...s.replies].sort((a, b) => Number(needsAttention(b.outcome)) - Number(needsAttention(a.outcome)));
  $('#replies').replaceChildren(...(replies.length ? replies.map((r) => h('div', { class: 'item' },
    h('div', {}, h('b', { text: `${r.name || 'Someone'}${r.company ? `, ${r.company}` : ''}` }), badge(r.outcome), h('span', { class: 'muted', text: ` ${r.email || ''} · ${ago(r.at)}` })),
    r.reply ? h('pre', { text: r.reply }) : null)) : [empty('No replies yet.')]));

  $('#angles').replaceChildren(...(s.angles.length ? s.angles.map((a) => {
    const n = a.wins + a.losses, pct = n ? Math.round((100 * a.wins) / n) : 0;
    return h('div', { class: 'line' }, h('span', { text: a.id }), h('div', {}, h('div', { text: a.description }), h('div', { class: 'bar' }, h('i', { style: null }))), h('span', { class: 'muted', text: n ? `${pct}%` : '–' }));
  }) : [empty('Nothing yet.')]));
  $$('#angles .bar > i').forEach((bar, i) => {
    const a = s.angles[i], n = a.wins + a.losses;
    bar.style.width = `${n ? Math.round((100 * a.wins) / n) : 0}%`;
  });

  const order = ['new', 'enriched', 'researched', 'drafted', 'sent', 'replied', 'no_contact', 'skipped', 'rejected'];
  const names = { new: 'Found', enriched: 'Contact found', researched: 'Researched', drafted: 'Email written', sent: dry ? 'Practice sent' : 'Sent', replied: 'Replied', no_contact: 'No public email', skipped: 'Not a fit', rejected: 'Email not good enough' };
  const max = Math.max(1, ...Object.values(s.leads));
  const rows = order.filter((k) => s.leads[k]);
  $('#funnel').replaceChildren(...(rows.length ? rows.map((k) => h('div', { class: 'line' }, h('span', { text: names[k] }), h('div', { class: 'bar' }, h('i', {})), h('span', { text: String(s.leads[k]) }))) : [empty('Nothing yet.')]));
  $$('#funnel .bar > i').forEach((bar, i) => { bar.style.width = `${Math.round((100 * s.leads[rows[i]]) / max)}%`; });

  $('#emails').replaceChildren(...(s.emails_recent.length ? s.emails_recent.map((e) => h('details', { class: 'item' },
    h('summary', {}, h('b', { text: `${e.name || ''}, ${e.company || ''}` }), ` ${e.subject} `, badge(e.status === 'queued' ? 'none' : e.outcome),
      h('span', { class: 'muted', text: ` ${e.status === 'queued' ? 'waiting to send' : e.status === 'dry_run' ? 'practice' : e.status} · approach ${e.angle}${e.score != null ? ` · quality ${e.score}/10` : ''}` })),
    h('div', { class: 'muted', text: `To: ${e.email || ''}` }), h('pre', { text: e.body }))) : [empty('No emails yet.')]));

  $('#leads').replaceChildren(s.pipeline.length ? h('table', {}, h('tr', {}, ['Name', 'Role', 'Company', 'Stage', 'Note'].map((t) => h('th', { text: t }))),
    s.pipeline.map((l) => h('tr', {}, [l.name, l.role, l.company, names[l.status] || l.status, l.note || ''].map((t) => h('td', { text: t }))))) : empty('Nothing yet.'));
}

async function refreshStats() {
  if (document.hidden || $('#view-dashboard').hidden) return;
  try { renderStats(await api(`/api/stats?db=${$('#dataset').value}`)); } catch { /* shown on next poll */ }
}

async function refreshLogs() {
  if (document.hidden || $('#view-dashboard').hidden) return;
  try {
    const { lines } = await api(`/api/logs?since=${lastLog}`);
    if (!lines.length) return;
    const box = $('#log'), atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    for (const l of lines) {
      lastLog = Math.max(lastLog, l.id);
      box.append(h('div', { class: l.level, text: `${l.t.slice(11, 19)} [${l.stage}] ${l.msg}` }));
    }
    while (box.childElementCount > 300) box.firstChild.remove();
    if (atEnd) box.scrollTop = box.scrollHeight;
  } catch { /* ignore */ }
}

/* ------------------------------ quick outreach ----------------------------- */

const Q_STATUS = {
  found: ['Found', ''], queued: ['Waiting to send', 'attn'], sent: ['Emailed', 'good'], replied: ['REPLIED', 'good'],
  no: ['Said no', 'bad'], bounced: ['Bounced', 'bad'], skipped: ['Skipped (opted out)', 'bad'],
};
let qLoaded = false;

function qMsg(text, kind) {
  const m = $('#q-msg');
  m.hidden = !text;
  m.textContent = text || '';
  m.className = `msg ${kind || ''}`;
}

const qTemplate = () => ({ subject: $('#q-subject').value, body: $('#q-body').value });

async function refreshQuick() {
  if (document.hidden || $('#view-quick').hidden) return;
  let q;
  try { q = await api('/api/quick'); } catch { return; }
  if (!qLoaded) {
    qLoaded = true;
    $('#q-links').value = q.links.join('\n');
    $('#q-limit').value = q.limit;
    $('#q-subject').value = q.subject;
    $('#q-body').value = q.body;
  }
  $('#q-find').disabled = q.finding;
  $('#q-find').textContent = q.finding ? 'Looking…' : 'Find contacts';
  $('#q-find-msg').textContent = q.findMsg;
  $('#q-send').disabled = q.sending;
  $('#q-stop').disabled = !q.sending && !q.finding;
  const c = q.counts;
  const waiting = c.queued || 0;
  const next = q.sending && waiting ? ` Next email ${q.nextAt > Date.now() ? `in about ${Math.ceil((q.nextAt - Date.now()) / 60000)} min` : 'shortly'}.` : '';
  $('#q-counts').textContent = `Found ${c.found || 0} · waiting ${waiting} · emailed ${(c.sent || 0) + (c.replied || 0) + (c.no || 0) + (c.bounced || 0)} · replied ${c.replied || 0} · said no ${c.no || 0} · bounced ${c.bounced || 0}.${q.sending ? ' Sending is ON.' : ''}${next}`;
  $('#q-contacts').replaceChildren(q.contacts.length
    ? h('table', {},
      h('tr', {}, ['Company', 'Email', 'Phone', 'Status', ''].map((t) => h('th', { text: t }))),
      q.contacts.map((r) => {
        const [label, cls] = Q_STATUS[r.status] || [r.status, ''];
        return h('tr', {},
          h('td', {}, h('div', { text: r.company || '' }), h('div', { class: 'muted', text: r.website || r.source || '' })),
          h('td', { text: r.email || '' }),
          h('td', { text: r.phone || '' }),
          h('td', {}, h('span', { class: `badge ${cls}`, text: label }), r.reply ? h('pre', { text: r.reply }) : null),
          h('td', {}, r.status === 'found' || r.status === 'queued'
            ? h('button', { class: 'btn', type: 'button', text: 'Remove', onclick: async () => { await api('/api/quick/remove', { id: r.id }).catch(() => {}); refreshQuick(); } })
            : null));
      }))
    : empty('Nobody yet. Paste links above and press Find contacts.'));
}

async function qAction(fn) {
  qMsg('');
  try { await fn(); } catch (e) { qMsg(e.message, 'bad'); }
  refreshQuick();
}

$('#q-find').addEventListener('click', () => qAction(async () => {
  const links = $('#q-links').value.split('\n').map((s) => s.trim()).filter(Boolean);
  await api('/api/quick/find', { links, limit: Number($('#q-limit').value) });
}));
$('#q-test').addEventListener('click', () => qAction(async () => {
  qMsg('Sending a test…');
  const r = await api('/api/quick/test', qTemplate());
  qMsg(`Test sent to ${r.to}. Check that inbox.`, 'ok');
}));
$('#q-send').addEventListener('click', () => qAction(async () => {
  if (!confirm('Send this email to everyone in the list who has not been emailed yet? They go out one at a time, a few minutes apart.')) return;
  const r = await api('/api/quick/send', { ...qTemplate(), confirm: true });
  qMsg(`Sending started. ${r.queued} emails will go out, a few minutes apart. You can close this page.`, 'ok');
}));
$('#q-stop').addEventListener('click', () => qAction(async () => { await api('/api/quick/stop', {}); qMsg('Stopped.', 'ok'); }));
$('#q-clear').addEventListener('click', () => qAction(async () => {
  if (!confirm('Remove everyone who has not been emailed yet from the list?')) return;
  await api('/api/quick/clear', {});
}));
for (const id of ['#q-subject', '#q-body']) $(id).addEventListener('change', () => api('/api/quick/template', qTemplate()).catch(() => {}));

/* ---------------------------------- boot ---------------------------------- */

function showTab(name) {
  for (const t of ['quick', 'dashboard', 'settings']) {
    $(`#view-${t}`).hidden = t !== name;
    $(`#tab-${t}`).classList.toggle('active', t === name);
  }
  if (name === 'dashboard') { refreshStats(); refreshStatus(); }
  if (name === 'quick') refreshQuick();
}

buildForm();
$$('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#btn-save').addEventListener('click', () => saveSettings());
$('#btn-dry').addEventListener('click', () => startAgent('dry'));
$('#btn-live').addEventListener('click', () => startAgent('live'));
$('#btn-stop').addEventListener('click', async () => { try { await api('/api/agent/stop', {}); } catch (e) { agentMsg(e.message, 'bad'); } refreshStatus(); });
$('#dataset').addEventListener('change', refreshStats);

(async () => {
  const saved = await loadSettings().catch((e) => { banner(e.message, 'bad'); return true; });
  await refreshStatus();
  if (!saved) { $('#welcome').hidden = false; showTab('settings'); } else showTab('quick');
  setInterval(refreshStatus, 3000);
  setInterval(refreshStats, 6000);
  setInterval(refreshQuick, 3000);
  setInterval(refreshLogs, 2500);
  refreshLogs();
})();

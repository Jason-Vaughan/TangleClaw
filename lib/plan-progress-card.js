'use strict';

/**
 * Progress cards for served plan pages (#1949).
 *
 * A plan may carry a fenced block whose info string is `tc-progress` and whose
 * body names one card: `{"card": "project-health"}` or
 * `{"card": "recent-progress"}`. The block carries no figures. They come from
 * the local scorecard cache (`lib/scorecard-cache.js`) when the page is served.
 * A tracked plan therefore never has to be rewritten to stay current, and
 * refreshing the numbers leaves no churn in any checkout.
 *
 * This module only displays. Every figure, trend and net change is the
 * producer's statement, and it is shown as stated. Nothing here counts,
 * compares or infers. When the cache is missing, unreadable or invalid the
 * card says so and why, and shows no numbers. When it is past its refresh
 * deadline the numbers are shown under a visible stale warning.
 *
 * Every time is shown in America/Los_Angeles with its PDT/PST label, never
 * UTC. The machine-readable UTC instant stays on the `<time datetime>`
 * attribute.
 */

const { escHtml } = require('../public/next-markdown');
const scorecard = require('./scorecard-cache');

/** Info string that marks a fenced block as a progress card. */
const PROGRESS_BLOCK_INFO = 'tc-progress';

/** The cards a block may name. */
const CARDS = Object.freeze(['project-health', 'recent-progress']);

/** Heading of each card. */
const CARD_TITLE = Object.freeze({
  'project-health': 'Project Health',
  'recent-progress': 'Recent Progress'
});

/** Row labels for each measure. */
const MEASURE_LABEL = Object.freeze({
  issuesClosed: 'Issues closed',
  prsMerged: 'PRs merged',
  carsCompleted: 'Cars completed',
  trainsCompleted: 'Trains completed',
  issuesOpened: 'Issues opened'
});

/** Short forms for the one-line summaries. */
const MEASURE_SHORT = Object.freeze({
  issuesClosed: 'closed',
  prsMerged: 'PRs merged',
  carsCompleted: 'cars',
  trainsCompleted: 'trains',
  issuesOpened: 'opened'
});

/** Trend words, with a symbol so the meaning never rests on colour. */
const TREND_TEXT = Object.freeze({
  up: '▲ up',
  down: '▼ down',
  flat: '→ flat',
  'no-baseline': '— no baseline'
});

/** Upper bound on a block body; the only valid bodies are a few dozen characters. */
const MAX_BODY = 1000;

/**
 * Error for a block that does not name a card correctly. Its message is shown
 * to the reader.
 */
class ProgressBlockError extends Error {}

/**
 * Parse and validate a `tc-progress` block body.
 * @param {string} body - The fenced block's contents.
 * @returns {{card: string}}
 * @throws {ProgressBlockError}
 */
function parseProgressBlock(body) {
  if (body.length > MAX_BODY) throw new ProgressBlockError(`block is larger than ${MAX_BODY} characters`);
  let obj;
  try {
    obj = JSON.parse(body);
  } catch {
    throw new ProgressBlockError('block is not valid JSON');
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new ProgressBlockError('block must be a JSON object');
  for (const key of Object.keys(obj)) {
    if (key !== 'card') throw new ProgressBlockError(`unknown key "${key.slice(0, 40)}"`);
  }
  if (!CARDS.includes(obj.card)) throw new ProgressBlockError(`card must be one of ${CARDS.join(', ')}`);
  return { card: obj.card };
}

/**
 * An instant as `YYYY-MM-DD HH:MM PDT` (or PST) in the scorecard's zone.
 * @param {number} ms - Epoch milliseconds.
 * @returns {string}
 */
function formatPacific(ms) {
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone: scorecard.TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZoneName: 'short'
  }).formatToParts(new Date(ms))) {
    parts[type] = value;
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

/**
 * A `<time>` element for an instant, shown in Pacific time.
 * @param {number} ms - Epoch milliseconds.
 * @returns {string} HTML.
 */
function _time(ms) {
  const iso = new Date(ms).toISOString();
  return `<time datetime="${iso}">${escHtml(formatPacific(ms))}</time>`;
}

/**
 * The Pacific calendar date of an instant, as `YYYY-MM-DD`.
 * @param {number} ms - Epoch milliseconds.
 * @returns {string}
 */
function pacificDate(ms) {
  // en-CA formats a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: scorecard.TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms));
}

/**
 * A calendar date (`YYYY-MM-DD`) as `Sun Sep 27`. The date is already a
 * Pacific day; it is read as a plain calendar date, so no zone applies.
 * @param {string} date - Calendar date.
 * @returns {string}
 */
function formatDay(date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
    .format(new Date(`${date}T00:00:00Z`)).replace(',', '');
}

/**
 * A window's dates as `Sep 21 – Sep 27`.
 * @param {{start: string, end: string}} w - Window.
 * @returns {string}
 */
function _span(w) {
  const d = (x) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })
    .format(new Date(`${x}T00:00:00Z`));
  return w.start === w.end ? d(w.start) : `${d(w.start)} – ${d(w.end)}`;
}

/**
 * A signed change as stated: `+3`, `−4` or `0`.
 * @param {number} n - Change.
 * @returns {string}
 */
function formatNet(n) {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return '0';
}

/**
 * The line under every card: when the figures were produced, and the
 * comparison windows they cover.
 * @param {object} doc - Validated scorecard.
 * @returns {string} HTML.
 */
function _footer(doc) {
  const { current, baseline } = doc.development.windows;
  return '<p class="progress-meta">'
    + `Last refreshed ${_time(doc.generatedAt)}. `
    + `Current window: <strong>${escHtml(current.label)}</strong> (${escHtml(_span(current))}). `
    + `Baseline: <strong>${escHtml(baseline.label)}</strong> (${escHtml(_span(baseline))}). `
    + 'Days are Pacific calendar days.'
    + '</p>';
}

/**
 * The warning shown above figures that are past their refresh deadline.
 * @param {object} doc - Validated scorecard.
 * @returns {string} HTML.
 */
function _staleWarning(doc) {
  return `<p class="progress-stale" role="status">⚠ Stale: these figures were due to be refreshed by ${_time(doc.freshUntil)} and have not been. They may be out of date.</p>`;
}

/**
 * A card in place of figures that cannot be shown, saying why.
 * @param {string} card - Card name.
 * @param {string} reason - Why there are no figures.
 * @returns {string} HTML.
 */
function _unavailable(card, reason) {
  return `<section class="progress-card progress-unavailable" aria-label="${escHtml(CARD_TITLE[card])}">`
    + `<p class="progress-title">${escHtml(CARD_TITLE[card])}: no figures to show</p>`
    + `<p class="progress-meta">${escHtml(reason)}.</p>`
    + '</section>';
}

/**
 * The comparison table rows for one group of measures.
 * @param {string} group - Group heading (`Delivery` or `Discovery / Intake`).
 * @param {object} measures - The group's validated measures.
 * @param {readonly string[]} keys - Measures to show, in order.
 * @returns {string} HTML.
 */
function _measureRows(group, measures, keys) {
  const head = `<tr class="progress-group"><th scope="rowgroup" colspan="4">${escHtml(group)}</th></tr>`;
  return head + keys.map((k) => {
    const m = measures[k];
    return `<tr><th scope="row">${escHtml(MEASURE_LABEL[k])}</th><td>${m.current}</td>`
      + `<td>${m.baseline === null ? '—' : m.baseline}</td><td class="progress-trend">${escHtml(TREND_TEXT[m.trend])}</td></tr>`;
  }).join('');
}

/**
 * The Project Health card: open backlog and its net change, then Delivery and
 * Discovery/Intake compared across the current and baseline windows.
 * @param {object} doc - Validated scorecard.
 * @returns {string} HTML.
 */
function renderHealthCard(doc) {
  const dev = doc.development;
  const ob = dev.openBacklog;
  const { current, baseline } = dev.windows;
  const headline = '<p class="progress-headline">'
    + `<span class="progress-figure">${ob.count}</span> open issues in the backlog`
    + ` (<strong>${ob.staleOver90Days}</strong> untouched 90+ days) · `
    + `net <strong>${escHtml(formatNet(ob.net))}</strong> over ${escHtml(current.label.toLowerCase())}`
    + ` (baseline ${ob.baselineNet === null ? '—' : escHtml(formatNet(ob.baselineNet))}, ${escHtml(TREND_TEXT[ob.trend])})`
    + '</p>';
  const table = '<div class="table-scroll"><table class="progress-table">'
    + '<thead><tr><th scope="col">Measure</th>'
    + `<th scope="col">${escHtml(current.label)}<br><small>${escHtml(_span(current))}</small></th>`
    + `<th scope="col">${escHtml(baseline.label)}<br><small>${escHtml(_span(baseline))}</small></th>`
    + '<th scope="col">Trend</th></tr></thead><tbody>'
    + _measureRows('Delivery', dev.delivery, scorecard.DELIVERY_KEYS)
    + _measureRows('Discovery / Intake', dev.intake, scorecard.INTAKE_KEYS)
    + '</tbody></table></div>';
  return '<section class="progress-card" aria-label="Project Health">'
    + '<p class="progress-title">📊 Project Health</p>'
    + headline + table + _footer(doc)
    + '</section>';
}

/**
 * One-line summary of a day or window: delivery, then intake, kept apart.
 * @param {object} delivery - Delivery counts.
 * @param {object} intake - Intake counts.
 * @returns {string} HTML.
 */
function _countsLine(delivery, intake) {
  const d = scorecard.DELIVERY_KEYS.map((k) => `${delivery[k]} ${MEASURE_SHORT[k]}`).join(', ');
  const i = scorecard.INTAKE_KEYS.map((k) => `${intake[k]} ${MEASURE_SHORT[k]}`).join(', ');
  return `Delivery: ${escHtml(d)} · Intake: ${escHtml(i)}`;
}

/**
 * The Recent Progress card: today and the current window on one line, and a
 * drawer with the day-by-day record. The newest day is called "Today" only
 * when it is the current Pacific date; otherwise "Latest day", so a figure
 * from an earlier day is never presented as today's.
 * @param {object} doc - Validated scorecard.
 * @param {number} [now] - Render time in epoch ms; the current time when omitted.
 * @returns {string} HTML.
 */
function renderRecentCard(doc, now = Date.now()) {
  const dev = doc.development;
  const dayWord = dev.today.date === pacificDate(now) ? 'Today' : 'Latest day';
  const { current } = dev.windows;
  const windowDelivery = {};
  for (const k of scorecard.DELIVERY_KEYS) windowDelivery[k] = dev.delivery[k].current;
  const windowIntake = {};
  for (const k of scorecard.INTAKE_KEYS) windowIntake[k] = dev.intake[k].current;
  const summary = '<summary class="progress-summary">'
    + '<span class="progress-title">🗓 Recent Progress</span>'
    + `<span class="progress-line"><strong>${dayWord} (${escHtml(formatDay(dev.today.date))}, PT):</strong> ${_countsLine(dev.today.delivery, dev.today.intake)} · backlog ${escHtml(formatNet(dev.today.openBacklogNet))}</span>`
    + `<span class="progress-line"><strong>${escHtml(current.label)}:</strong> ${_countsLine(windowDelivery, windowIntake)} · backlog ${escHtml(formatNet(dev.openBacklog.net))}</span>`
    + '</summary>';
  const rows = dev.days.map((day) => {
    const cells = scorecard.DELIVERY_KEYS.map((k) => `<td>${day.delivery[k]}</td>`).join('')
      + scorecard.INTAKE_KEYS.map((k) => `<td class="progress-intake">${day.intake[k]}</td>`).join('');
    return `<tr><th scope="row">${escHtml(formatDay(day.date))}</th>${cells}<td>${escHtml(formatNet(day.openBacklogNet))}</td></tr>`;
  }).join('');
  const head = '<tr><th scope="col" rowspan="2">Day (PT)</th>'
    + `<th scope="colgroup" colspan="${scorecard.DELIVERY_KEYS.length}">Delivery</th>`
    + `<th scope="colgroup" colspan="${scorecard.INTAKE_KEYS.length}" class="progress-intake">Discovery / Intake</th>`
    + '<th scope="col" rowspan="2">Backlog net</th></tr><tr>'
    + [...scorecard.DELIVERY_KEYS, ...scorecard.INTAKE_KEYS]
      .map((k) => `<th scope="col"${scorecard.INTAKE_KEYS.includes(k) ? ' class="progress-intake"' : ''}>${escHtml(MEASURE_LABEL[k])}</th>`).join('')
    + '</tr>';
  const drawer = '<div class="progress-body"><div class="table-scroll"><table class="progress-table">'
    + `<thead>${head}</thead><tbody>${rows}</tbody></table></div>${_footer(doc)}</div>`;
  return `<details class="progress-card progress-recent">${summary}${drawer}</details>`;
}

/**
 * Render a `tc-progress` block: the named card from the scorecard cache, the
 * reason there are no figures, or (for a malformed block) the escaped source
 * with the reason it was refused.
 * @param {string} body - The fenced block's contents.
 * @param {object} helpers - Render inputs.
 * @param {() => {status: string, doc?: object, reason?: string}} [helpers.scorecard] -
 *   Reads the cache (`lib/scorecard-cache.js#readScorecardCache`). Absent when
 *   the caller has no scorecard source.
 * @param {number} [helpers.now] - Render time in epoch ms; the current time when omitted.
 * @returns {string} HTML.
 */
function renderProgressBlock(body, { scorecard: read, now = Date.now() } = {}) {
  let block;
  try {
    block = parseProgressBlock(body);
  } catch (err) {
    if (!(err instanceof ProgressBlockError)) throw err;
    return `<p class="block-error">Progress block not rendered: ${escHtml(err.message)}.</p>`
      + `<pre><code class="language-${PROGRESS_BLOCK_INFO}">${escHtml(body)}</code></pre>`;
  }
  const found = read ? read() : { status: scorecard.STATUS.MISSING, reason: 'this page has no scorecard source' };
  if (found.status !== scorecard.STATUS.OK && found.status !== scorecard.STATUS.STALE) {
    return _unavailable(block.card, found.reason);
  }
  const card = block.card === 'project-health' ? renderHealthCard(found.doc) : renderRecentCard(found.doc, now);
  return found.status === scorecard.STATUS.STALE ? `<div class="progress-stale-wrap">${_staleWarning(found.doc)}${card}</div>` : card;
}

/** Card styles, appended to the plan page's stylesheet. Colors follow its theme tokens. */
const PROGRESS_CARD_CSS = `
.progress-card{border:1px solid var(--border);border-radius:6px;background:var(--surface);margin:0 0 .75rem;padding:.6rem .75rem;font-size:.92rem}
details.progress-card>summary{cursor:pointer;list-style:none;display:flex;flex-direction:column;gap:.15rem}
details.progress-card>summary::-webkit-details-marker{display:none}
details.progress-card>summary::after{content:"Show day-by-day ▾";color:var(--link);font-size:.85em}
details.progress-card[open]>summary::after{content:"Hide day-by-day ▴"}
.progress-title{font-weight:700;color:var(--link);margin:0}
.progress-headline{margin:.35rem 0}
.progress-figure{font-size:1.4em;font-weight:700}
.progress-line{color:var(--fg)}
.progress-body{margin-top:.6rem}
main.plan table.progress-table{min-width:0;font-size:.88rem;margin:.4rem 0}
.progress-table td{text-align:right;white-space:nowrap}
.progress-table td.progress-trend{text-align:left}
.progress-group th{background:none;border-left:0;border-right:0;padding-top:.6em}
.progress-intake{border-left:2px solid var(--muted)}
.progress-meta{color:var(--muted);font-size:.85em;margin:.35rem 0 0}
.progress-stale{border-left:4px solid #9a6700;padding:.2em .6em;margin:0 0 .35rem;font-weight:600}
.progress-unavailable .progress-title{color:var(--muted)}
@media (prefers-color-scheme:dark){.progress-stale{border-left-color:#d29922}}
`;

module.exports = {
  PROGRESS_BLOCK_INFO,
  PROGRESS_CARD_CSS,
  CARDS,
  ProgressBlockError,
  parseProgressBlock,
  formatPacific,
  pacificDate,
  formatDay,
  formatNet,
  renderHealthCard,
  renderRecentCard,
  renderProgressBlock
};

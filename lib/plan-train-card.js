'use strict';

/**
 * Roadmap "train" cards for served plan pages (#1930).
 *
 * A plan may carry a fenced block whose info string is `tc-train` and whose
 * body is one JSON object describing a train of issues. The plan renderer
 * hands that body here; this module validates it against a closed schema and
 * builds the card from fixed markup and CSS classes. Plans are
 * session-authored and served on the dashboard origin, so nothing in the
 * block is ever emitted as markup: every string is escaped, every href must
 * be an absolute https URL that the plan renderer's own link check accepts,
 * and the closed/total count is computed here rather than trusted.
 *
 * A block that fails validation is not partially rendered. The caller shows
 * it as ordinary code with the reason, so an author sees exactly what was
 * refused.
 */

const { escHtml } = require('../public/next-markdown');

/** Info string that marks a fenced block as a train card. */
const TRAIN_BLOCK_INFO = 'tc-train';

/** Upper bounds on the block, so one plan cannot make the page arbitrarily large. */
const LIMITS = Object.freeze({
  body: 200000,
  title: 200,
  thesis: 2000,
  sequencing: 4000,
  cars: 500,
  carTitle: 300,
  carType: 40,
  href: 2000,
  train: 9999,
  issue: 99999999
});

const TOP_KEYS = new Set(['train', 'title', 'href', 'verified', 'thesis', 'cars', 'sequencing']);
const CAR_KEYS = new Set(['issue', 'closed', 'href', 'type', 'title']);

/**
 * Error raised for a block that does not match the schema. Its message is
 * shown to the reader, so it names the field and never echoes the value.
 */
class TrainBlockError extends Error {}

/**
 * Refuse unless `cond` holds.
 *
 * @param {boolean} cond - The check.
 * @param {string} msg - Reader-facing reason.
 * @returns {void}
 */
function _need(cond, msg) {
  if (!cond) throw new TrainBlockError(msg);
}

/**
 * Validate an optional bounded string field.
 *
 * @param {object} obj - Owner object.
 * @param {string} key - Field name.
 * @param {number} max - Maximum length.
 * @param {string} where - Path for the reason.
 * @returns {void}
 */
function _optString(obj, key, max, where) {
  if (obj[key] === undefined) return;
  _need(typeof obj[key] === 'string', `${where}${key} must be a string`);
  _need(obj[key].length <= max, `${where}${key} is longer than ${max} characters`);
}

/**
 * Validate an optional href: an absolute https URL the plan renderer's own
 * link check accepts.
 *
 * @param {object} obj - Owner object.
 * @param {string} where - Path for the reason.
 * @param {(href: string) => boolean} isSafeHref - The plan renderer's link check.
 * @returns {void}
 */
function _optHref(obj, where, isSafeHref) {
  if (obj.href === undefined) return;
  _optString(obj, 'href', LIMITS.href, where);
  _need(/^https:\/\/[^/\\]/i.test(obj.href) && isSafeHref(escHtml(obj.href)),
    `${where}href must be an absolute https URL`);
}

/**
 * Parse and validate a `tc-train` block body.
 *
 * @param {string} body - The fenced block's contents.
 * @param {(href: string) => boolean} isSafeHref - The plan renderer's link check.
 * @returns {object} The validated train.
 * @throws {TrainBlockError} When the body does not match the schema.
 */
function parseTrainBlock(body, isSafeHref) {
  _need(body.length <= LIMITS.body, `block is larger than ${LIMITS.body} characters`);
  let train;
  try {
    train = JSON.parse(body);
  } catch {
    throw new TrainBlockError('block is not valid JSON');
  }
  _need(train !== null && typeof train === 'object' && !Array.isArray(train), 'block must be a JSON object');
  for (const key of Object.keys(train)) _need(TOP_KEYS.has(key), `unknown key "${key.slice(0, 40)}"`);
  _need(Number.isInteger(train.train) && train.train >= 1 && train.train <= LIMITS.train,
    `train must be an integer from 1 to ${LIMITS.train}`);
  _need(typeof train.title === 'string' && train.title.trim().length > 0, 'title must be a non-empty string');
  _optString(train, 'title', LIMITS.title, '');
  _optHref(train, '', isSafeHref);
  _need(train.verified === undefined || typeof train.verified === 'boolean', 'verified must be true or false');
  _optString(train, 'thesis', LIMITS.thesis, '');
  _optString(train, 'sequencing', LIMITS.sequencing, '');
  _need(Array.isArray(train.cars), 'cars must be an array');
  _need(train.cars.length <= LIMITS.cars, `cars has more than ${LIMITS.cars} entries`);
  train.cars.forEach((car, i) => {
    const where = `cars[${i}].`;
    _need(car !== null && typeof car === 'object' && !Array.isArray(car), `cars[${i}] must be an object`);
    for (const key of Object.keys(car)) _need(CAR_KEYS.has(key), `cars[${i}] has unknown key "${key.slice(0, 40)}"`);
    _need(Number.isInteger(car.issue) && car.issue >= 1 && car.issue <= LIMITS.issue,
      `${where}issue must be a positive integer`);
    _need(typeof car.closed === 'boolean', `${where}closed must be true or false`);
    _optHref(car, where, isSafeHref);
    _optString(car, 'type', LIMITS.carType, where);
    _optString(car, 'title', LIMITS.carTitle, where);
  });
  return train;
}

/**
 * Render a validated train as a collapsible card. The summary row is the
 * engine, the cars (green when closed), the train's name, its closed/total
 * count and a `verified` badge; the body holds the thesis, the issue table
 * and the sequencing note.
 *
 * @param {object} train - A train returned by `parseTrainBlock`.
 * @param {(raw: string) => string} renderInline - The plan renderer's inline marks (escapes first).
 * @returns {string} HTML.
 */
function renderTrainCard(train, renderInline) {
  const closed = train.cars.filter((c) => c.closed).length;
  const cars = train.cars.map((c) =>
    `<span class="train-car ${c.closed ? 'closed' : 'open'}">#${c.issue}</span>`
  ).join('<span class="train-joint" aria-hidden="true">—</span>');
  const summary = '<summary class="train-summary">'
    + '<span class="train-engine" aria-hidden="true">🚂</span>'
    + (cars ? `<span class="train-joint" aria-hidden="true">—</span>${cars}` : '')
    + `<span class="train-name">Train ${train.train}: ${escHtml(train.title)}</span>`
    + `<span class="train-count">(${closed}/${train.cars.length})</span>`
    + (train.verified ? '<span class="train-badge">verified</span>' : '')
    + '</summary>';

  const body = [];
  if (train.thesis) body.push(`<p><em>${renderInline(train.thesis)}</em></p>`);
  body.push(`<p><strong>${train.cars.length - closed} open · ${closed} closed</strong>`
    + (train.href ? ` · <a href="${escHtml(train.href)}">milestone</a>` : '') + '</p>');
  const rows = train.cars.map((c) => {
    const num = c.href ? `<a href="${escHtml(c.href)}">#${c.issue}</a>` : `#${c.issue}`;
    const title = c.title ? escHtml(c.title) : '';
    return `<tr><td class="train-issue">${num}</td><td>${c.type ? escHtml(c.type) : '—'}</td>`
      + `<td>${c.closed ? '✅ closed' : 'open'}</td><td>${c.closed && title ? `<del>${title}</del>` : title}</td></tr>`;
  });
  body.push('<div class="table-scroll"><table><thead><tr><th>Issue</th><th>Type</th><th>State</th><th>Title</th></tr></thead>'
    + `<tbody>${rows.join('') || '<tr><td>—</td><td>—</td><td>—</td><td>No issues assigned.</td></tr>'}</tbody></table></div>`);
  if (train.sequencing) body.push(`<p><strong>Sequencing.</strong> ${renderInline(train.sequencing)}</p>`);

  return `<details class="train-card">${summary}<div class="train-body">${body.join('')}</div></details>`;
}

/**
 * Render a `tc-train` block body: a card when it validates, otherwise the
 * escaped source as code with the reason it was refused.
 *
 * @param {string} body - The fenced block's contents.
 * @param {object} helpers - The plan renderer's primitives.
 * @param {(raw: string) => string} helpers.renderInline - Inline marks (escapes first).
 * @param {(href: string) => boolean} helpers.isSafeHref - Link check.
 * @returns {string} HTML.
 */
function renderTrainBlock(body, { renderInline, isSafeHref }) {
  try {
    return renderTrainCard(parseTrainBlock(body, isSafeHref), renderInline);
  } catch (err) {
    if (!(err instanceof TrainBlockError)) throw err;
    return `<p class="block-error">Train block not rendered: ${escHtml(err.message)}.</p>`
      + `<pre><code class="language-${TRAIN_BLOCK_INFO}">${escHtml(body)}</code></pre>`;
  }
}

/** Card styles, appended to the plan page's stylesheet. Colors follow its theme tokens. */
const TRAIN_CARD_CSS = `
details.train-card{border:1px solid var(--border);border-radius:6px;background:var(--surface);margin:0 0 .75rem;padding:.6rem .75rem}
summary.train-summary{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem;cursor:pointer;list-style:none}
summary.train-summary::-webkit-details-marker{display:none}
.train-engine{font-size:1.2em;margin-right:.1rem}
.train-joint{color:var(--muted);font-size:.8em}
.train-car{padding:.1em .55em;border-radius:12px;font:.82em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap;border:1px solid var(--border);background:var(--code-bg);color:var(--fg)}
.train-car.closed{background:#238636;border-color:#238636;color:#fff}
.train-name{margin-left:.5rem;font-weight:700;color:var(--link)}
.train-count{color:var(--muted);font-size:.9em}
.train-badge{border:1px solid var(--link);color:var(--link);border-radius:12px;padding:0 .5em;font-size:.75em}
.train-body{margin-top:.6rem}
td.train-issue{white-space:nowrap}
p.block-error{color:var(--muted);font-size:.9em;margin-bottom:.25em}
`;

module.exports = {
  TRAIN_BLOCK_INFO,
  TRAIN_CARD_CSS,
  LIMITS,
  TrainBlockError,
  parseTrainBlock,
  renderTrainCard,
  renderTrainBlock
};

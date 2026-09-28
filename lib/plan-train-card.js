'use strict';

/**
 * Roadmap cards for served plan pages (#1930, #1933).
 *
 * A plan may carry fenced blocks whose info string is `tc-train` (one train of
 * issues) or `tc-queue` (the issues not yet in any train) and whose body is
 * one JSON object. The plan renderer hands that body here; this module
 * validates it against a closed schema and builds the card from fixed markup
 * and CSS classes. Plans are session-authored and served on the dashboard
 * origin, so nothing in a block is ever emitted as markup: every string is
 * escaped, every href must be an absolute https URL that the plan renderer's
 * own link check accepts, and every count, age and "new" mark is computed
 * here rather than trusted.
 *
 * A block that fails validation is not partially rendered. The caller shows
 * it as ordinary code with the reason, so an author sees exactly what was
 * refused.
 */

const { escHtml } = require('../public/next-markdown');

/** Info string that marks a fenced block as a train card. */
const TRAIN_BLOCK_INFO = 'tc-train';

/** Info string that marks a fenced block as the queue of issues not yet in a train. */
const QUEUE_BLOCK_INFO = 'tc-queue';

/** Upper bounds on a block, so one plan cannot make the page arbitrarily large. */
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
  trainId: 40,
  issue: 99999999,
  version: 16,
  queueIssues: 1000,
  labels: 10,
  label: 40,
  newDays: 365
});

/** A train's lifecycle, shown as a badge. Closed: anything else is refused. */
const TRAIN_STATUSES = Object.freeze(['planned', 'ready', 'in-progress', 'blocked', 'shipped', 'sunset']);

/**
 * What a card stands for. A Train and a Pilot carry an identity. A Topic
 * Bucket is a grouping that is not a numbered train, so it carries no identity
 * at all rather than borrowing a train number. An unconfigured milestone has
 * no identity yet.
 */
const TRAIN_KINDS = Object.freeze(['train', 'bucket', 'pilot', 'unconfigured']);

/** Kinds that must not carry a `train` identity. */
const ID_LESS_KINDS = Object.freeze(['bucket', 'unconfigured']);

/** The words a card's name opens with, per kind. */
const KIND_LABEL = Object.freeze({
  train: 'Train',
  bucket: 'Topic Bucket',
  pilot: 'Pilot',
  unconfigured: 'Unconfigured'
});

/** A car's state. `closed` must agree with the car's `closed` flag. */
const CAR_STATES = Object.freeze(['open', 'in-progress', 'blocked', 'closed']);

/** Reader-facing words for a car state, used in labels and the table. */
const CAR_STATE_TEXT = Object.freeze({
  open: 'open',
  'in-progress': 'in progress',
  blocked: 'blocked',
  closed: 'closed'
});

/** Table cell text for a car state; a symbol plus words, never colour alone. */
const CAR_STATE_CELL = Object.freeze({
  open: 'open',
  'in-progress': '◐ in progress',
  blocked: '⛔ blocked',
  closed: '✅ closed'
});

const TOP_KEYS = new Set(['train', 'kind', 'title', 'href', 'verified', 'version', 'status', 'thesis', 'cars', 'sequencing']);
const CAR_KEYS = new Set(['issue', 'closed', 'state', 'href', 'type', 'title']);
const QUEUE_KEYS = new Set(['title', 'newDays', 'issues']);
const QUEUE_ISSUE_KEYS = new Set(['issue', 'title', 'href', 'type', 'labels', 'createdAt']);

/** A version label: short, starting with a letter or digit, e.g. `v6` or `5.30`. */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

/**
 * A string identity such as `A`, `C-E` or `Infrastructure Hardening`. It must
 * contain a letter, so a number is only ever written as a JSON number and one
 * identity cannot be spelled two ways.
 */
const TRAIN_ID_RE = /^(?=.*[A-Za-z])[A-Za-z0-9](?:[A-Za-z0-9 ._-]*[A-Za-z0-9])?$/;

/** A decimal identity such as `13.5`: at most two places, as the number prints. */
const TRAIN_DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/** An ISO-8601 timestamp with a zone, as GitHub's `createdAt` gives it. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

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
 * Parse a block body as one JSON object with only the allowed keys.
 *
 * @param {string} body - The fenced block's contents.
 * @param {Set<string>} keys - Allowed top-level keys.
 * @returns {object}
 * @throws {TrainBlockError}
 */
function _parseObject(body, keys) {
  _need(body.length <= LIMITS.body, `block is larger than ${LIMITS.body} characters`);
  let obj;
  try {
    obj = JSON.parse(body);
  } catch {
    throw new TrainBlockError('block is not valid JSON');
  }
  _need(obj !== null && typeof obj === 'object' && !Array.isArray(obj), 'block must be a JSON object');
  for (const key of Object.keys(obj)) _need(keys.has(key), `unknown key "${key.slice(0, 40)}"`);
  return obj;
}

/**
 * Validate one element of an array as a plain object with only the allowed keys.
 *
 * @param {*} item - The element.
 * @param {string} where - Its path, e.g. `cars[3]`.
 * @param {Set<string>} keys - Allowed keys.
 * @returns {void}
 */
function _needItem(item, where, keys) {
  _need(item !== null && typeof item === 'object' && !Array.isArray(item), `${where} must be an object`);
  for (const key of Object.keys(item)) _need(keys.has(key), `${where} has unknown key "${key.slice(0, 40)}"`);
}

/**
 * Validate an issue number.
 *
 * @param {*} n - Candidate.
 * @param {string} where - Path for the reason.
 * @returns {void}
 */
function _needIssue(n, where) {
  _need(Number.isInteger(n) && n >= 1 && n <= LIMITS.issue, `${where}issue must be a positive integer`);
}

/**
 * Whether a value is a permanent train identity: an integer or a number with
 * up to two decimal places, from 1 to `LIMITS.train`, or a short string ID
 * containing a letter.
 *
 * @param {*} id - Candidate.
 * @returns {boolean}
 */
function _isTrainId(id) {
  if (typeof id === 'number') {
    return Number.isFinite(id) && id >= 1 && id <= LIMITS.train && TRAIN_DECIMAL_RE.test(String(id));
  }
  return typeof id === 'string' && id.length <= LIMITS.trainId && TRAIN_ID_RE.test(id);
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
  const train = _parseObject(body, TOP_KEYS);
  _need(train.kind === undefined || TRAIN_KINDS.includes(train.kind),
    `kind must be one of ${TRAIN_KINDS.join(', ')}`);
  if (ID_LESS_KINDS.includes(train.kind)) {
    _need(train.train === undefined, `train must be absent when kind is ${train.kind}`);
  } else {
    _need(_isTrainId(train.train),
      `train must be an integer or a number with up to two decimal places from 1 to ${LIMITS.train}, `
        + `or an ID of up to ${LIMITS.trainId} letters, digits, spaces, ".", "-" or "_" that contains a letter`);
  }
  _need(typeof train.title === 'string' && train.title.trim().length > 0, 'title must be a non-empty string');
  _optString(train, 'title', LIMITS.title, '');
  _optHref(train, '', isSafeHref);
  _need(train.verified === undefined || typeof train.verified === 'boolean', 'verified must be true or false');
  if (train.version !== undefined) {
    _optString(train, 'version', LIMITS.version, '');
    _need(VERSION_RE.test(train.version), 'version must start with a letter or digit and use only letters, digits, ".", "-", "_" or spaces');
  }
  _need(train.status === undefined || TRAIN_STATUSES.includes(train.status),
    `status must be one of ${TRAIN_STATUSES.join(', ')}`);
  _optString(train, 'thesis', LIMITS.thesis, '');
  _optString(train, 'sequencing', LIMITS.sequencing, '');
  _need(Array.isArray(train.cars), 'cars must be an array');
  _need(train.cars.length <= LIMITS.cars, `cars has more than ${LIMITS.cars} entries`);
  train.cars.forEach((car, i) => {
    const where = `cars[${i}].`;
    _needItem(car, `cars[${i}]`, CAR_KEYS);
    _needIssue(car.issue, where);
    _need(typeof car.closed === 'boolean', `${where}closed must be true or false`);
    if (car.state !== undefined) {
      _need(CAR_STATES.includes(car.state), `${where}state must be one of ${CAR_STATES.join(', ')}`);
      _need((car.state === 'closed') === car.closed, `${where}state must agree with closed`);
    }
    _optHref(car, where, isSafeHref);
    _optString(car, 'type', LIMITS.carType, where);
    _optString(car, 'title', LIMITS.carTitle, where);
  });
  return train;
}

/**
 * A car's effective state: its explicit `state`, else what `closed` implies.
 *
 * @param {object} car - A validated car.
 * @returns {string} One of `CAR_STATES`.
 */
function _carState(car) {
  return car.state || (car.closed ? 'closed' : 'open');
}

/**
 * One pill, labelled with its number and state so the state is not carried by
 * colour alone.
 *
 * @param {number} issue - Issue number.
 * @param {string} cls - State class.
 * @param {string} text - State words.
 * @returns {string} HTML.
 */
function _pill(issue, cls, text) {
  return `<span class="train-car ${cls}" title="#${issue} ${text}" aria-label="#${issue} ${text}">#${issue}</span>`;
}

/**
 * A card's name: its kind, its identity and its title. The identity is left
 * out of the words when the kind has none, as a Topic Bucket does, or when it
 * is the title itself, so it is never shown twice and never replaced by a
 * position.
 *
 * @param {object} train - A validated train.
 * @returns {string} HTML-escaped text.
 */
function _cardName(train) {
  const label = KIND_LABEL[train.kind || 'train'];
  const id = train.train === undefined ? '' : String(train.train);
  const head = id && id !== train.title ? `${label} ${id}` : label;
  return `${escHtml(head)}: ${escHtml(train.title)}`;
}

/**
 * Render a validated train as a collapsible card. The summary row is the
 * engine, the cars (green when closed, amber in progress, red blocked), the
 * train's name, its closed/total count and its version, status and
 * `verified` badges; the body holds the thesis, the issue table and the
 * sequencing note.
 *
 * @param {object} train - A train returned by `parseTrainBlock`.
 * @param {(raw: string) => string} renderInline - The plan renderer's inline marks (escapes first).
 * @returns {string} HTML.
 */
function renderTrainCard(train, renderInline) {
  const states = train.cars.map(_carState);
  const closed = states.filter((s) => s === 'closed').length;
  const cars = train.cars.map((c, i) => _pill(c.issue, states[i], CAR_STATE_TEXT[states[i]]))
    .join('<span class="train-joint" aria-hidden="true">—</span>');
  const summary = '<summary class="train-summary">'
    + '<span class="train-engine" aria-hidden="true">🚂</span>'
    + (cars ? `<span class="train-joint" aria-hidden="true">—</span>${cars}` : '')
    + `<span class="train-name">${_cardName(train)}</span>`
    + `<span class="train-count">(${closed}/${train.cars.length})</span>`
    + (train.version ? `<span class="train-version">${escHtml(train.version)}</span>` : '')
    + (train.status ? `<span class="train-status status-${train.status}">${train.status.replace('-', ' ')}</span>` : '')
    + (train.verified ? '<span class="train-badge">verified</span>' : '')
    + '</summary>';

  const inProgress = states.filter((s) => s === 'in-progress').length;
  const blocked = states.filter((s) => s === 'blocked').length;
  const detail = [inProgress && `${inProgress} in progress`, blocked && `${blocked} blocked`].filter(Boolean).join(', ');
  const body = [];
  if (train.thesis) body.push(`<p><em>${renderInline(train.thesis)}</em></p>`);
  body.push(`<p><strong>${train.cars.length - closed} open${detail ? ` (${detail})` : ''} · ${closed} closed</strong>`
    + (train.href ? ` · <a href="${escHtml(train.href)}">milestone</a>` : '') + '</p>');
  const rows = train.cars.map((c, i) => {
    const num = c.href ? `<a href="${escHtml(c.href)}">#${c.issue}</a>` : `#${c.issue}`;
    return `<tr><td class="train-issue">${num}</td><td>${c.type ? escHtml(c.type) : '—'}</td>`
      + `<td class="train-state">${CAR_STATE_CELL[states[i]]}</td><td>${c.title ? escHtml(c.title) : ''}</td></tr>`;
  });
  body.push('<div class="table-scroll"><table><thead><tr><th>Issue</th><th>Type</th><th>State</th><th>Title</th></tr></thead>'
    + `<tbody>${rows.join('') || '<tr><td>—</td><td>—</td><td>—</td><td>No issues assigned.</td></tr>'}</tbody></table></div>`);
  if (train.sequencing) body.push(`<p><strong>Sequencing.</strong> ${renderInline(train.sequencing)}</p>`);

  return `<details class="train-card">${summary}<div class="train-body">${body.join('')}</div></details>`;
}

/**
 * Parse and validate a `tc-queue` block body: the open issues not yet in a
 * train. Every one stays in the queue whatever its age; `newDays` only
 * decides which are marked new.
 *
 * @param {string} body - The fenced block's contents.
 * @param {(href: string) => boolean} isSafeHref - The plan renderer's link check.
 * @returns {object} The validated queue.
 * @throws {TrainBlockError} When the body does not match the schema.
 */
function parseQueueBlock(body, isSafeHref) {
  const queue = _parseObject(body, QUEUE_KEYS);
  _optString(queue, 'title', LIMITS.title, '');
  _need(Number.isInteger(queue.newDays) && queue.newDays >= 1 && queue.newDays <= LIMITS.newDays,
    `newDays must be an integer from 1 to ${LIMITS.newDays}`);
  _need(Array.isArray(queue.issues), 'issues must be an array');
  _need(queue.issues.length <= LIMITS.queueIssues, `issues has more than ${LIMITS.queueIssues} entries`);
  queue.issues.forEach((it, i) => {
    const where = `issues[${i}].`;
    _needItem(it, `issues[${i}]`, QUEUE_ISSUE_KEYS);
    _needIssue(it.issue, where);
    _need(typeof it.createdAt === 'string' && ISO_RE.test(it.createdAt) && !Number.isNaN(Date.parse(it.createdAt)),
      `${where}createdAt must be an ISO-8601 timestamp with a zone`);
    _optHref(it, where, isSafeHref);
    _optString(it, 'type', LIMITS.carType, where);
    _optString(it, 'title', LIMITS.carTitle, where);
    if (it.labels !== undefined) {
      _need(Array.isArray(it.labels), `${where}labels must be an array`);
      _need(it.labels.length <= LIMITS.labels, `${where}labels has more than ${LIMITS.labels} entries`);
      it.labels.forEach((l, j) => {
        _need(typeof l === 'string' && l.length > 0 && l.length <= LIMITS.label,
          `${where}labels[${j}] must be a string of 1 to ${LIMITS.label} characters`);
      });
    }
  });
  return queue;
}

/**
 * How long ago, in the largest sensible unit: `<1h`, `5h`, `3d`. A time in
 * the future (clock skew) reads as `<1h`.
 *
 * @param {number} ageMs - Milliseconds since creation.
 * @returns {string}
 */
function _age(ageMs) {
  if (ageMs < HOUR_MS) return '<1h';
  if (ageMs < 2 * DAY_MS) return `${Math.floor(ageMs / HOUR_MS)}h`;
  return `${Math.floor(ageMs / DAY_MS)}d`;
}

/**
 * Render a validated queue as a card: the issues not yet in a train, newest
 * first. The summary row shows the new ones as pills; the table lists every
 * one with its age, so age marks an issue but never hides it.
 *
 * @param {object} queue - A queue returned by `parseQueueBlock`.
 * @param {number} now - The render time, in epoch milliseconds.
 * @returns {string} HTML.
 */
function renderQueueCard(queue, now) {
  const items = queue.issues
    .map((it) => ({ ...it, ageMs: now - Date.parse(it.createdAt) }))
    .map((it) => ({ ...it, isNew: it.ageMs <= queue.newDays * DAY_MS }))
    .sort((a, b) => a.ageMs - b.ageMs || b.issue - a.issue);
  const fresh = items.filter((it) => it.isNew);
  const pills = fresh.map((it) => _pill(it.issue, 'queue-new', 'new')).join('');
  const name = queue.title || 'New cards queue';
  const summary = '<summary class="train-summary">'
    + '<span class="train-engine" aria-hidden="true">📥</span>'
    + pills
    + `<span class="train-name">${escHtml(name)}</span>`
    + `<span class="train-count">(${fresh.length} new · ${items.length} waiting)</span>`
    + '</summary>';
  const rows = items.map((it) => {
    const num = it.href ? `<a href="${escHtml(it.href)}">#${it.issue}</a>` : `#${it.issue}`;
    const labels = (it.labels || []).map((l) => `<code>${escHtml(l)}</code>`).join(' ');
    const age = `${escHtml(_age(Math.max(0, it.ageMs)))}${it.isNew ? ' <span class="queue-new-badge">new</span>' : ''}`;
    return `<tr><td class="train-issue">${num}</td><td>${it.type ? escHtml(it.type) : '—'}</td><td>${labels}</td>`
      + `<td class="train-state">${age}</td><td>${it.title ? escHtml(it.title) : ''}</td></tr>`;
  });
  const body = `<p><strong>Open issues not yet in a train, newest first.</strong> Marked new when filed within ${queue.newDays} day${queue.newDays === 1 ? '' : 's'}.</p>`
    + '<div class="table-scroll"><table><thead><tr><th>Issue</th><th>Type</th><th>Labels</th><th>Age</th><th>Title</th></tr></thead>'
    + `<tbody>${rows.join('') || '<tr><td>—</td><td>—</td><td></td><td>—</td><td>Nothing waiting.</td></tr>'}</tbody></table></div>`;
  return `<details class="train-card queue-card">${summary}<div class="train-body">${body}</div></details>`;
}

/**
 * Show a refused block as escaped code with the reason.
 *
 * @param {string} kind - `Train` or `Queue`, for the message.
 * @param {string} info - The block's info string.
 * @param {string} body - The block's contents.
 * @param {TrainBlockError} err - Why it was refused.
 * @returns {string} HTML.
 */
function _refused(kind, info, body, err) {
  return `<p class="block-error">${kind} block not rendered: ${escHtml(err.message)}.</p>`
    + `<pre><code class="language-${info}">${escHtml(body)}</code></pre>`;
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
    return _refused('Train', TRAIN_BLOCK_INFO, body, err);
  }
}

/**
 * Render a `tc-queue` block body: a card when it validates, otherwise the
 * escaped source as code with the reason it was refused.
 *
 * @param {string} body - The fenced block's contents.
 * @param {object} helpers - The plan renderer's primitives.
 * @param {(href: string) => boolean} helpers.isSafeHref - Link check.
 * @param {number} [helpers.now] - Render time in epoch ms; the current time when omitted.
 * @returns {string} HTML.
 */
function renderQueueBlock(body, { isSafeHref, now = Date.now() }) {
  try {
    return renderQueueCard(parseQueueBlock(body, isSafeHref), now);
  } catch (err) {
    if (!(err instanceof TrainBlockError)) throw err;
    return _refused('Queue', QUEUE_BLOCK_INFO, body, err);
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
.train-car.in-progress{background:#9a6700;border-color:#9a6700;color:#fff}
.train-car.blocked{background:#cf222e;border-color:#cf222e;color:#fff}
.train-car.queue-new{background:#0969da;border-color:#0969da;color:#fff}
.train-name{margin-left:.5rem;font-weight:700;color:var(--link)}
.train-count{color:var(--muted);font-size:.9em}
.train-badge,.train-version,.train-status{border:1px solid var(--link);color:var(--link);border-radius:12px;padding:0 .5em;font-size:.75em;white-space:nowrap}
.train-version{border-color:var(--muted);color:var(--fg)}
.train-status{border-color:var(--muted);color:var(--muted)}
.train-status.status-in-progress{border-color:#9a6700;color:#9a6700}
.train-status.status-blocked{border-color:#cf222e;color:#cf222e}
.train-status.status-shipped{border-color:#238636;color:#238636}
@media (prefers-color-scheme:dark){.train-status.status-in-progress{border-color:#d29922;color:#d29922}.train-status.status-blocked{border-color:#f85149;color:#f85149}.train-status.status-shipped{border-color:#3fb950;color:#3fb950}}
.queue-new-badge{background:#0969da;color:#fff;border-radius:10px;padding:0 .45em;font-size:.75em}
.train-body{margin-top:.6rem}
td.train-issue,td.train-state{white-space:nowrap}
p.block-error{color:var(--muted);font-size:.9em;margin-bottom:.25em}
`;

module.exports = {
  TRAIN_BLOCK_INFO,
  QUEUE_BLOCK_INFO,
  TRAIN_CARD_CSS,
  TRAIN_STATUSES,
  TRAIN_KINDS,
  CAR_STATES,
  LIMITS,
  TrainBlockError,
  parseTrainBlock,
  parseQueueBlock,
  renderTrainCard,
  renderQueueCard,
  renderTrainBlock,
  renderQueueBlock
};

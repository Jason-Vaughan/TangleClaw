'use strict';

/**
 * Roadmap cards for served plan pages (#1930, #1933).
 *
 * A plan may carry fenced blocks whose info string is `tc-train` (one train of
 * issues), `tc-release` (the workstreams planned for one release, drawn as one
 * panel) or `tc-queue` (the issues not yet in any train) and whose body is one
 * JSON object. The plan renderer hands that body here; this module
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

/** Info string that marks a fenced block as a release panel: the workstreams planned for one release. */
const RELEASE_BLOCK_INFO = 'tc-release';

/** Upper bounds on a block, so one plan cannot make the page arbitrarily large. */
const LIMITS = Object.freeze({
  body: 200000,
  title: 200,
  thesis: 2000,
  sequencing: 4000,
  cars: 500,
  carTitle: 300,
  carType: 40,
  carReason: 300,
  href: 2000,
  train: 9999,
  trainId: 40,
  owner: 60,
  issue: 99999999,
  version: 16,
  releaseTrains: 50,
  releaseCars: 1000,
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

/**
 * The kinds a release panel holds, each written out. A pilot is not release
 * work and an unconfigured milestone has no release yet, so neither is a row.
 */
const RELEASE_KINDS = Object.freeze(['train', 'bucket']);

/** Kinds that must not carry a `train` identity. */
const ID_LESS_KINDS = Object.freeze(['bucket', 'unconfigured']);

/** The words a card's name opens with, per kind. */
const KIND_LABEL = Object.freeze({
  train: 'Train',
  bucket: 'Topic Bucket',
  pilot: 'Pilot',
  unconfigured: 'Unconfigured'
});

/**
 * A car's state. `in-review` is written with a pull request open for review;
 * `dropped` is closed as not planned, so it is neither open nor done.
 */
const CAR_STATES = Object.freeze(['open', 'in-progress', 'blocked', 'closed', 'in-review', 'dropped']);

/** The states of a closed issue. A car's `state` must be one of these exactly when its `closed` flag is true. */
const CLOSED_CAR_STATES = Object.freeze(['closed', 'dropped']);

/** Reader-facing words for a car state, shown on the car itself, in its detail and in the legend. */
const CAR_STATE_TEXT = Object.freeze({
  open: 'open',
  'in-progress': 'in progress',
  blocked: 'blocked',
  closed: 'closed',
  'in-review': 'in review',
  dropped: 'dropped'
});

/** Table cell text for a car state; a symbol plus words, never colour alone. */
const CAR_STATE_CELL = Object.freeze({
  open: 'open',
  'in-progress': '◐ in progress',
  blocked: '⛔ blocked',
  closed: '✅ closed',
  'in-review': '◆ in review',
  dropped: '⊘ dropped'
});

/**
 * What each car state tells a reader, shown once per page in the legend, in
 * the order a car normally moves through them, and beside each car in its
 * detail. `closed` says only that the
 * issue is closed, because that is all a card's data can vouch for. Every
 * state in `CAR_STATES` needs a line here.
 */
const CAR_STATE_MEANING = Object.freeze({
  open: 'not started',
  'in-progress': 'under way: a draft pull request, or claimed',
  'in-review': 'written, pull request open for review',
  blocked: 'needs attention: merge conflicts, a failed check, or labelled blocked',
  closed: 'issue closed — not proof the code is written, ready or shipped',
  dropped: 'closed as not planned'
});

const TOP_KEYS = new Set(['train', 'kind', 'title', 'href', 'verified', 'version', 'status', 'owner', 'thesis', 'cars', 'sequencing']);
const CAR_KEYS = new Set(['issue', 'closed', 'state', 'href', 'type', 'title', 'reason']);
const RELEASE_KEYS = new Set(['version', 'status', 'trains']);
const QUEUE_KEYS = new Set(['title', 'newDays', 'issues']);
const QUEUE_ISSUE_KEYS = new Set(['issue', 'title', 'href', 'type', 'labels', 'createdAt']);

/** A version label: short, starting with a letter or digit, e.g. `v6` or `5.30`. */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

/** A release's version: three dot-separated numbers with no leading zero and no `v`, e.g. `5.32.0`. */
const RELEASE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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
 * Parse a block body as JSON, within the size bound.
 *
 * @param {string} body - The fenced block's contents.
 * @returns {*} The parsed value, not yet checked to be an object.
 * @throws {TrainBlockError}
 */
function _parseJson(body) {
  _need(body.length <= LIMITS.body, `block is larger than ${LIMITS.body} characters`);
  try {
    return JSON.parse(body);
  } catch {
    throw new TrainBlockError('block is not valid JSON');
  }
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
  const obj = _parseJson(body);
  _needItem(obj, '', keys);
  return obj;
}

/**
 * Validate a value as a plain object with only the allowed keys.
 *
 * @param {*} item - The value.
 * @param {string} where - Its path, e.g. `cars[3]`; empty for the block itself.
 * @param {Set<string>} keys - Allowed keys.
 * @returns {void}
 */
function _needItem(item, where, keys) {
  _need(item !== null && typeof item === 'object' && !Array.isArray(item),
    where ? `${where} must be an object` : 'block must be a JSON object');
  for (const key of Object.keys(item)) {
    _need(keys.has(key), `${where ? `${where} has ` : ''}unknown key "${key.slice(0, 40)}"`);
  }
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
 * Validate one train object against the closed schema. This is the only
 * place a train's fields, cars, hrefs and closed/state agreement are checked,
 * so a train is held to the same rules wherever it appears.
 *
 * @param {*} train - The candidate, already parsed from JSON.
 * @param {string} where - Path prefix for the reason, e.g. `trains[2].`; empty for a block that is itself a train.
 * @param {(href: string) => boolean} isSafeHref - The plan renderer's link check.
 * @returns {object} The validated train.
 * @throws {TrainBlockError} When it does not match the schema.
 */
function _validateTrain(train, where, isSafeHref) {
  _needItem(train, where.replace(/\.$/, ''), TOP_KEYS);
  _need(train.kind === undefined || TRAIN_KINDS.includes(train.kind),
    `${where}kind must be one of ${TRAIN_KINDS.join(', ')}`);
  if (ID_LESS_KINDS.includes(train.kind)) {
    _need(train.train === undefined, `${where}train must be absent when kind is ${train.kind}`);
  } else {
    _need(_isTrainId(train.train),
      `${where}train must be an integer or a number with up to two decimal places from 1 to ${LIMITS.train}, `
        + `or an ID of up to ${LIMITS.trainId} letters, digits, spaces, ".", "-" or "_" that contains a letter`);
  }
  _need(typeof train.title === 'string' && train.title.trim().length > 0, `${where}title must be a non-empty string`);
  _optString(train, 'title', LIMITS.title, where);
  _optHref(train, where, isSafeHref);
  _need(train.verified === undefined || typeof train.verified === 'boolean', `${where}verified must be true or false`);
  if (train.version !== undefined) {
    _optString(train, 'version', LIMITS.version, where);
    _need(VERSION_RE.test(train.version),
      `${where}version must start with a letter or digit and use only letters, digits, ".", "-", "_" or spaces`);
  }
  _need(train.status === undefined || TRAIN_STATUSES.includes(train.status),
    `${where}status must be one of ${TRAIN_STATUSES.join(', ')}`);
  if (train.owner !== undefined) {
    _optString(train, 'owner', LIMITS.owner, where);
    _need(train.owner.trim().length > 0, `${where}owner must not be blank`);
  }
  _optString(train, 'thesis', LIMITS.thesis, where);
  _optString(train, 'sequencing', LIMITS.sequencing, where);
  _need(Array.isArray(train.cars), `${where}cars must be an array`);
  _need(train.cars.length <= LIMITS.cars, `${where}cars has more than ${LIMITS.cars} entries`);
  train.cars.forEach((car, i) => {
    const at = `${where}cars[${i}]`;
    _needItem(car, at, CAR_KEYS);
    _needIssue(car.issue, `${at}.`);
    _need(typeof car.closed === 'boolean', `${at}.closed must be true or false`);
    if (car.state !== undefined) {
      _need(CAR_STATES.includes(car.state), `${at}.state must be one of ${CAR_STATES.join(', ')}`);
      _need(CLOSED_CAR_STATES.includes(car.state) === car.closed, `${at}.state must agree with closed`);
    }
    _optHref(car, `${at}.`, isSafeHref);
    _optString(car, 'type', LIMITS.carType, `${at}.`);
    _optString(car, 'title', LIMITS.carTitle, `${at}.`);
    _optString(car, 'reason', LIMITS.carReason, `${at}.`);
  });
  return train;
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
  return _validateTrain(_parseJson(body), '', isSafeHref);
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
 * Count a set of cars by effective state. A dropped car is neither done nor
 * still to do, so it is left out of the total and reported on its own.
 *
 * @param {string[]} states - Effective states, each one of `CAR_STATES`.
 * @returns {{done: number, total: number, dropped: number, inProgress: number, inReview: number, blocked: number}}
 */
function _tally(states) {
  /**
   * How many of the cars are in one state.
   * @param {string} state - One of `CAR_STATES`.
   * @returns {number}
   */
  const count = (state) => states.filter((s) => s === state).length;
  const dropped = count('dropped');
  return {
    done: count('closed'),
    total: states.length - dropped,
    dropped,
    inProgress: count('in-progress'),
    inReview: count('in-review'),
    blocked: count('blocked')
  };
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
 * What the blocks of one page share: whether the car-state legend is still
 * owed. One object per page is what makes the legend appear once, at any
 * blockquote depth. A fragment rendered on its own owes no legend.
 *
 * @param {boolean} legend - Whether the page shows the legend before its first card.
 * @returns {{legendOwed: boolean}}
 */
function pageState(legend) {
  return { legendOwed: legend === true };
}

/**
 * One car of a train: a disclosure whose summary is the pill, showing the
 * issue number and the state in words, and whose content is the car's
 * detail. The state word is ordinary visible text, so a closed car says
 * what state it is in without relying on its colour, and the same text is
 * what the summary offers as its name.
 *
 * Pressing the pill, with a click, a tap, Enter or Space, opens the detail,
 * and pressing it again closes it; the browser does this itself, so it
 * needs no script and works the same on a phone. Moving the pointer over a
 * car does nothing. The detail says which issue this is, its state with
 * what that state means, why it needs attention when the block gives a
 * reason that is not blank, and the lane that owns the train.
 *
 * The page's styles give the disclosure no box of its own and put its
 * content on a full line of the row, so an open detail sits in the flow
 * directly under its car's line: it covers nothing and cuts nothing off.
 * The car and the cars before it stay where they are; what follows moves
 * down. Cars are not grouped, so opening one never closes another, which
 * would move the car just pressed.
 *
 * The markup is a plain `<details>` and `<summary>` with no `aria-`
 * attribute, role, id or `tabindex`: whatever a browser and a screen reader
 * make of a native disclosure is what a car gets, and nothing here adds to
 * or overrides it. How a screen reader actually reads it has not been
 * checked.
 *
 * @param {object} car - A validated car.
 * @param {string} state - Its effective state, one of `CAR_STATES`.
 * @param {string} [owner] - The owning lane of the car's train.
 * @returns {string} HTML.
 */
function _car(car, state, owner) {
  const info = `<span class="car-info-head">#${car.issue}${car.title ? ` ${escHtml(car.title)}` : ''}</span>`
    + `<span class="car-info-line"><span class="car-info-state">${escHtml(CAR_STATE_TEXT[state])}</span>: ${escHtml(CAR_STATE_MEANING[state])}</span>`
    + (car.reason && car.reason.trim() ? `<span class="car-info-line">Reason: ${escHtml(car.reason)}</span>` : '')
    + (owner ? `<span class="car-info-line">lane: ${escHtml(owner)}</span>` : '');
  return `<details class="car-slot"><summary class="train-car ${state}">#${car.issue} <span class="car-state">${escHtml(CAR_STATE_TEXT[state])}</span></summary>`
    + `<span class="car-info">${info}</span></details>`;
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
 * Render a validated train as a card of two rows. The first is the engine
 * and the cars (green when closed, amber in progress, purple in review, red
 * blocked, grey and struck through when dropped, each opening its own
 * detail in the row when pressed); it is always visible and is not part of
 * the train's collapsible, so pressing a car never opens or closes the
 * train. The second is a
 * collapsible whose summary is the train's name, its closed/total count, its
 * version, status and `verified` badges and its owning lane, and whose body
 * holds the thesis, the issue table and the sequencing note. A dropped car
 * is left out of both figures of the count.
 *
 * @param {object} train - A train returned by `parseTrainBlock`.
 * @param {(raw: string) => string} renderInline - The plan renderer's inline marks (escapes first).
 * @returns {string} HTML.
 */
function renderTrainCard(train, renderInline) {
  const states = train.cars.map(_carState);
  const tally = _tally(states);
  const cars = train.cars.map((c, i) => _car(c, states[i], train.owner))
    .join('<span class="train-joint" aria-hidden="true">—</span>');
  // The cars sit outside the <details>, so pressing one never opens or closes the train.
  const row = '<div class="train-cars">'
    + '<span class="train-engine" aria-hidden="true">🚂</span>'
    + (cars ? `<span class="train-joint" aria-hidden="true">—</span>${cars}` : '')
    + '</div>';
  const summary = '<summary class="train-summary">'
    + `<span class="train-name">${_cardName(train)}</span>`
    + `<span class="train-count">(${tally.done}/${tally.total})</span>`
    + (train.version ? `<span class="train-version">${escHtml(train.version)}</span>` : '')
    + (train.status ? `<span class="train-status status-${train.status}">${train.status.replace('-', ' ')}</span>` : '')
    + (train.verified ? '<span class="train-badge">verified</span>' : '')
    + (train.owner ? `<span class="train-owner">lane: ${escHtml(train.owner)}</span>` : '')
    + '</summary>';

  const detail = [
    tally.inProgress && `${tally.inProgress} in progress`,
    tally.inReview && `${tally.inReview} in review`,
    tally.blocked && `${tally.blocked} blocked`
  ].filter(Boolean).join(', ');
  const body = [];
  if (train.thesis) body.push(`<p><em>${renderInline(train.thesis)}</em></p>`);
  body.push(`<p><strong>${tally.total - tally.done} open${detail ? ` (${detail})` : ''} · ${tally.done} closed`
    + `${tally.dropped ? ` · ${tally.dropped} dropped` : ''}</strong>`
    + (train.href ? ` · <a href="${escHtml(train.href)}">milestone</a>` : '') + '</p>');
  const rows = train.cars.map((c, i) => {
    const num = c.href ? `<a href="${escHtml(c.href)}">#${c.issue}</a>` : `#${c.issue}`;
    return `<tr><td class="train-issue">${num}</td><td>${c.type ? escHtml(c.type) : '—'}</td>`
      + `<td class="train-state">${CAR_STATE_CELL[states[i]]}</td><td>${c.title ? escHtml(c.title) : ''}</td></tr>`;
  });
  body.push('<div class="table-scroll"><table><thead><tr><th>Issue</th><th>Type</th><th>State</th><th>Title</th></tr></thead>'
    + `<tbody>${rows.join('') || '<tr><td>—</td><td>—</td><td>—</td><td>No issues assigned.</td></tr>'}</tbody></table></div>`);
  if (train.sequencing) body.push(`<p><strong>Sequencing.</strong> ${renderInline(train.sequencing)}</p>`);

  return `<div class="train-card">${row}<details class="train-detail">${summary}<div class="train-body">${body.join('')}</div></details></div>`;
}

/**
 * Hold one workstream of a release to the rules that apply only inside a
 * panel, after it has passed the shared train validator: its kind is one a
 * release holds, the release's version is the only one, and it can be told
 * apart from every other row.
 *
 * @param {object} entry - A validated train.
 * @param {string} where - Path prefix for the reason, e.g. `trains[2].`.
 * @param {Set<string>} seen - Row keys already taken in this release; this row's key is added.
 * @returns {void}
 * @throws {TrainBlockError} When the entry breaks a release-only rule.
 */
function _needReleaseEntry(entry, where, seen) {
  _need(RELEASE_KINDS.includes(entry.kind), `${where}kind must be written out as one of ${RELEASE_KINDS.join(', ')}`);
  _need(entry.version === undefined, `${where}version must be absent inside a release`);
  // A number and a string ID get different keys, so 16 never collides with an ID spelled "16x".
  const key = entry.kind === 'bucket'
    ? `bucket:${entry.title.trim().toLowerCase()}`
    : `${typeof entry.train}:${entry.train}`;
  _need(!seen.has(key), entry.kind === 'bucket'
    ? `${where}title repeats another bucket in this release`
    : `${where}train repeats another train in this release`);
  seen.add(key);
}

/**
 * Parse and validate a `tc-release` block body: one planned release and its
 * workstreams. Each workstream goes through the same validator as a `tc-train`
 * block, so nothing about a train is checked differently inside a panel.
 *
 * @param {string} body - The fenced block's contents.
 * @param {(href: string) => boolean} isSafeHref - The plan renderer's link check.
 * @returns {object} The validated release.
 * @throws {TrainBlockError} When the body does not match the schema.
 */
function parseReleaseBlock(body, isSafeHref) {
  const release = _parseObject(body, RELEASE_KEYS);
  _need(typeof release.version === 'string' && release.version.length <= LIMITS.version
    && RELEASE_VERSION_RE.test(release.version), 'version must be three numbers such as 5.32.0, with no "v" and no leading zero');
  _need(release.status === undefined || TRAIN_STATUSES.includes(release.status),
    `status must be one of ${TRAIN_STATUSES.join(', ')}`);
  _need(Array.isArray(release.trains) && release.trains.length > 0, 'trains must be a non-empty array');
  _need(release.trains.length <= LIMITS.releaseTrains, `trains has more than ${LIMITS.releaseTrains} entries`);
  const seen = new Set();
  let cars = 0;
  release.trains.forEach((entry, i) => {
    const where = `trains[${i}].`;
    // A missing kind is settled before the train rules run: an entry that left it out is told
    // so, and not that it lacks a train identity, which a bucket must not have anyway.
    _needItem(entry, `trains[${i}]`, TOP_KEYS);
    _need(entry.kind !== undefined, `${where}kind must be written out as one of ${RELEASE_KINDS.join(', ')}`);
    _needReleaseEntry(_validateTrain(entry, where, isSafeHref), where, seen);
    cars += entry.cars.length;
    _need(cars <= LIMITS.releaseCars, `trains hold more than ${LIMITS.releaseCars} cars in total`);
  });
  return release;
}

/**
 * Render a validated release as one panel: a header with the version, the
 * status badge and the cars done out of the cars still planned, then one
 * train card per workstream, in the block's order. The panel is not itself
 * collapsible, so every workstream's row shows without a click and each
 * card still opens to its own issue table. The header's figures are counted
 * here from the cars; a dropped car is left out of both and reported apart.
 *
 * @param {object} release - A release returned by `parseReleaseBlock`.
 * @param {(raw: string) => string} renderInline - The plan renderer's inline marks (escapes first).
 * @returns {string} HTML.
 */
function renderReleasePanel(release, renderInline) {
  const tally = _tally(release.trains.flatMap((t) => t.cars.map(_carState)));
  const streams = `${release.trains.length} workstream${release.trains.length === 1 ? '' : 's'}`;
  const dropped = tally.dropped ? `${tally.dropped} dropped` : '';
  const version = escHtml(release.version);
  const head = '<div class="release-head">'
    + `<span class="release-version">v${version}</span>`
    + (release.status ? `<span class="train-status status-${release.status}">${release.status.replace('-', ' ')}</span>` : '')
    + `<span class="release-count" aria-label="${tally.done} of ${tally.total} cars done across ${streams}${dropped ? `, ${dropped}` : ''}">`
    + `${tally.done}/${tally.total} cars · ${streams}${dropped ? ` · ${dropped}` : ''}</span>`
    + '</div>';
  return `<section class="release-panel" aria-label="Release ${version}">${head}`
    + `${release.trains.map((t) => renderTrainCard(t, renderInline)).join('')}</section>`;
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
 * The key to the car colours: one sample pill per state, with its meaning in
 * words. The pill carries the state's own class and words, so it looks and
 * reads exactly as a car in that state does.
 *
 * @returns {string} HTML.
 */
function renderLegend() {
  const items = Object.keys(CAR_STATE_MEANING)
    .map((state) => `<li><span class="train-car ${state}">${escHtml(CAR_STATE_TEXT[state])}</span> ${escHtml(CAR_STATE_MEANING[state])}</li>`);
  return `<ul class="train-legend" aria-label="Car states">${items.join('')}</ul>`;
}

/**
 * Put the legend in front of a rendered card when the page still owes one,
 * which is the first time a card is drawn on it.
 *
 * @param {string} html - A card or panel that rendered.
 * @param {{legendOwed: boolean}} page - The page's shared state; the legend is marked drawn here.
 * @returns {string} HTML.
 */
function _withLegend(html, page) {
  if (!page.legendOwed) return html;
  page.legendOwed = false;
  return renderLegend() + html;
}

/**
 * Show a refused block as escaped code with the reason.
 *
 * @param {string} kind - `Train`, `Release` or `Queue`, for the message.
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
 * escaped source as code with the reason it was refused. A refused block
 * never draws the legend.
 *
 * @param {string} body - The fenced block's contents.
 * @param {object} helpers - The plan renderer's primitives.
 * @param {(raw: string) => string} helpers.renderInline - Inline marks (escapes first).
 * @param {(href: string) => boolean} helpers.isSafeHref - Link check.
 * @param {{legendOwed: boolean}} [helpers.page] - The page's shared state (`pageState`); without it the block is a fragment.
 * @returns {string} HTML.
 */
function renderTrainBlock(body, { renderInline, isSafeHref, page = pageState(false) }) {
  try {
    return _withLegend(renderTrainCard(parseTrainBlock(body, isSafeHref), renderInline), page);
  } catch (err) {
    if (!(err instanceof TrainBlockError)) throw err;
    return _refused('Train', TRAIN_BLOCK_INFO, body, err);
  }
}

/**
 * Render a `tc-release` block body: a panel when it validates, otherwise the
 * escaped source as code with the reason it was refused. One bad workstream
 * refuses the whole block, so a panel never shows a total that leaves a row out.
 * A refused block never draws the legend.
 *
 * @param {string} body - The fenced block's contents.
 * @param {object} helpers - The plan renderer's primitives.
 * @param {(raw: string) => string} helpers.renderInline - Inline marks (escapes first).
 * @param {(href: string) => boolean} helpers.isSafeHref - Link check.
 * @param {{legendOwed: boolean}} [helpers.page] - The page's shared state (`pageState`); without it the block is a fragment.
 * @returns {string} HTML.
 */
function renderReleaseBlock(body, { renderInline, isSafeHref, page = pageState(false) }) {
  try {
    return _withLegend(renderReleasePanel(parseReleaseBlock(body, isSafeHref), renderInline), page);
  } catch (err) {
    if (!(err instanceof TrainBlockError)) throw err;
    return _refused('Release', RELEASE_BLOCK_INFO, body, err);
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
.train-card{border:1px solid var(--border);border-radius:6px;background:var(--surface);margin:0 0 .75rem;padding:.6rem .75rem}
summary.train-summary{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem;cursor:pointer;list-style:none}
summary.train-summary::-webkit-details-marker{display:none}
.train-cars{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem;margin-bottom:.35rem}
.train-detail .train-name{margin-left:0}
.train-engine{font-size:1.2em;margin-right:.1rem}
.train-joint{color:var(--muted);font-size:.8em}
.train-car{padding:.1em .55em;border-radius:12px;font:.82em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap;border:1px solid var(--border);background:var(--code-bg);color:var(--fg)}
.train-car.open{background:var(--code-bg);border-color:var(--border);color:var(--fg)}
.train-car.closed{background:#238636;border-color:#238636;color:#fff}
.train-car.in-progress{background:#9a6700;border-color:#9a6700;color:#fff}
.train-car.blocked{background:#cf222e;border-color:#cf222e;color:#fff}
.train-car.in-review{background:#8250df;border-color:#8250df;color:#fff}
.train-car.dropped{background:#57606a;border-color:#57606a;color:#fff;text-decoration:line-through}
.train-car.queue-new{background:#0969da;border-color:#0969da;color:#fff}
.train-car:focus-visible{outline:2px solid var(--link);outline-offset:2px}
details.car-slot{display:contents}
summary.train-car{display:block;list-style:none;cursor:pointer}
summary.train-car::-webkit-details-marker{display:none}
details.car-slot::details-content{display:none}
details.car-slot[open]::details-content{display:block;flex:0 0 100%}
details.car-slot[open]>summary.train-car{box-shadow:0 0 0 2px var(--link)}
.car-info{display:block;flex:0 0 100%;box-sizing:border-box;padding:.45rem .65rem;border:1px solid var(--border);border-radius:6px;background:var(--code-bg);color:var(--fg);font:400 .85rem/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;text-align:left}
.car-info-head,.car-info-line{display:block}
.car-info-head{font-weight:700}
.car-info-state{font-weight:600}
.train-name{margin-left:.5rem;font-weight:700;color:var(--link)}
.train-count{color:var(--muted);font-size:.9em}
.train-badge,.train-version,.train-status{border:1px solid var(--link);color:var(--link);border-radius:12px;padding:0 .5em;font-size:.75em;white-space:nowrap}
.train-version{border-color:var(--muted);color:var(--fg)}
.train-owner{color:var(--muted);font-size:.85em;white-space:nowrap}
.train-status{border-color:var(--muted);color:var(--muted)}
.train-status.status-in-progress{border-color:#9a6700;color:#9a6700}
.train-status.status-blocked{border-color:#cf222e;color:#cf222e}
.train-status.status-shipped{border-color:#238636;color:#238636}
@media (prefers-color-scheme:dark){.train-status.status-in-progress{border-color:#d29922;color:#d29922}.train-status.status-blocked{border-color:#f85149;color:#f85149}.train-status.status-shipped{border-color:#3fb950;color:#3fb950}}
main.plan ul.train-legend{list-style:none;display:flex;flex-wrap:wrap;gap:.3rem 1rem;margin:0 0 .75rem;padding:0;font-size:.85em;color:var(--muted)}
section.release-panel{border:1px solid var(--border);border-radius:8px;margin:0 0 1rem;padding:.6rem .75rem 0}
.release-head{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin-bottom:.6rem}
.release-version{font-weight:700;font-size:1.1em;color:var(--fg)}
.release-count{color:var(--muted);font-size:.9em}
.queue-new-badge{background:#0969da;color:#fff;border-radius:10px;padding:0 .45em;font-size:.75em}
.train-body{margin-top:.6rem}
td.train-issue,td.train-state{white-space:nowrap}
p.block-error{color:var(--muted);font-size:.9em;margin-bottom:.25em}
`;

module.exports = {
  TRAIN_BLOCK_INFO,
  RELEASE_BLOCK_INFO,
  QUEUE_BLOCK_INFO,
  TRAIN_CARD_CSS,
  TRAIN_STATUSES,
  TRAIN_KINDS,
  RELEASE_KINDS,
  CAR_STATES,
  CLOSED_CAR_STATES,
  CAR_STATE_MEANING,
  LIMITS,
  TrainBlockError,
  parseTrainBlock,
  parseReleaseBlock,
  parseQueueBlock,
  renderTrainCard,
  renderReleasePanel,
  renderQueueCard,
  renderLegend,
  pageState,
  renderTrainBlock,
  renderReleaseBlock,
  renderQueueBlock
};

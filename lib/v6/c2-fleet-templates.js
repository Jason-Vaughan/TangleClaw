'use strict';

/**
 * v6 (#2984, V6-11 / C2, Car V60-T2-W1-B): the Starter Fleet Template
 * Catalog and its guided-apply planner.
 *
 * Three versioned templates — `small-4-seat`, `recommended-10-role`, and
 * `large-configurable` — plus {@link planFleetApply}, which decides which
 * seats a fleet launch starts IMMEDIATELY (the supervisory PM seat only,
 * for zero idle worker token burn) and which stay DEFERRED until woken on
 * demand (every worker/reviewer/observer seat).
 *
 * This car (Ruling A555-V60-T2-CHARTER-WAVE-DECOMPOSITION / A555-SUPPLEMENT-
 * COSIGN) ships the template DATA and the PLANNING logic only — pure
 * functions over plain objects, zero `lib/store/_schema.js` or `server.js`
 * edits, zero `public/**` files. Issue #2984 names `BRIDGE-2`/`BRIDGE-5` as
 * the required integration bridges that will later wire a real Preview/Apply
 * Wizard UI and real session-launch machinery to this planner; neither
 * exists yet, and this module starts no process and touches no database.
 *
 * Issue #2984 cites canonical prototypes `P31` and `P19` for the wizard's
 * visual design — unavailable to this session (no match found in this repo
 * or its shared docs), so the template ROSTERS below (seat composition,
 * role names) follow the issue's own explicit text exactly where it is
 * explicit (`recommended-10-role`'s exact 10 roles), and a documented,
 * reasonable design choice where it is not (`small-4-seat`'s and
 * `large-configurable`'s composition) — flagged here and in the PR
 * description rather than guessed at silently. A future UI-wiring car
 * should confirm this against the real prototypes before building the
 * Preview/Apply Wizard screen itself.
 *
 * @module lib/v6/c2-fleet-templates
 */

/** Every role this catalog can seat, matching this fleet's own live role vocabulary (PM, Architect, Builder, PRR, Integrator, Observer). */
const ROLES = Object.freeze(['PM', 'Architect', 'Builder', 'PRR', 'Integrator', 'Observer']);

/**
 * Build a fixed (non-configurable) seat list.
 * @param {Array<[string, string]>} roleSeatIdPairs - `[role, seatId]` tuples.
 * @returns {Array<{role: string, seatId: string, supervisory: boolean}>}
 */
function _fixedSeats(roleSeatIdPairs) {
  // PRR-B R1 HOLD (Ruling A560-PR3012-R1-HOLD-RECONCILED): Object.freeze on
  // the ARRAY and the template object is not deep — each individual seat
  // object must be frozen too, or getFleetTemplate(id).seats[0].supervisory
  // = false mutates the one shared canonical template every later call
  // reads from.
  return roleSeatIdPairs.map(([role, seatId]) => Object.freeze({ role, seatId, supervisory: role === 'PM' }));
}

/**
 * The three versioned starter templates (#2984 deliverable 1).
 *
 * `small-4-seat`: PM + one of each of Architect/Builder/Integrator — the
 * minimum roster capable of planning, building, and landing work, without
 * a dedicated reviewer or observer. Design choice (issue #2984 names the
 * seat COUNT, "4-Seat", but not its composition); documented here rather
 * than invented silently at the call site.
 *
 * `recommended-10-role`: PM, Architect, 4 Builders (A-D), 2 PR Reviewers
 * (PRR-A/B), Integrator, Observer — exactly as #2984 names them.
 *
 * `large-configurable`: PM is the one fixed, always-supervisory seat;
 * every other role is a seat GROUP whose count the caller configures via
 * {@link instantiateFleetTemplate}'s `config`, lettered in order
 * (`Builder-A`, `Builder-B`, ...). `seatGroups` below is this template's
 * configuration schema, not a concrete seat list.
 */
const FLEET_TEMPLATES = Object.freeze({
  'small-4-seat': Object.freeze({
    id: 'small-4-seat',
    version: 1,
    name: 'Small 4-Seat Fleet',
    configurable: false,
    seats: Object.freeze(_fixedSeats([
      ['PM', 'pm'],
      ['Architect', 'architect'],
      ['Builder', 'builder'],
      ['Integrator', 'integrator']
    ]))
  }),
  'recommended-10-role': Object.freeze({
    id: 'recommended-10-role',
    version: 1,
    name: 'Recommended 10-Role Full Software Development Fleet',
    configurable: false,
    seats: Object.freeze(_fixedSeats([
      ['PM', 'pm'],
      ['Architect', 'architect'],
      ['Builder', 'builder-a'],
      ['Builder', 'builder-b'],
      ['Builder', 'builder-c'],
      ['Builder', 'builder-d'],
      ['PRR', 'prr-a'],
      ['PRR', 'prr-b'],
      ['Integrator', 'integrator'],
      ['Observer', 'observer']
    ]))
  }),
  'large-configurable': Object.freeze({
    id: 'large-configurable',
    version: 1,
    name: 'Large Configurable Fleet',
    configurable: true,
    // Defaults mirror the recommended-10-role roster (Architect 1, Builder
    // 4, PRR 2, Integrator 1, Observer 1) as a sensible starting point; an
    // operator ADJUSTS a role's count via config to grow or shrink from
    // there, clamped to each group's declared min/max.
    seatGroups: Object.freeze({
      Architect: Object.freeze({ min: 0, max: 8, default: 1 }),
      Builder: Object.freeze({ min: 0, max: 26, default: 4 }),
      PRR: Object.freeze({ min: 0, max: 8, default: 2 }),
      Integrator: Object.freeze({ min: 0, max: 4, default: 1 }),
      Observer: Object.freeze({ min: 0, max: 4, default: 1 })
    })
  })
});

/**
 * List every template in the catalog (#2984 deliverable 1), read-only.
 * @returns {Array<object>}
 */
function listFleetTemplates() {
  return Object.values(FLEET_TEMPLATES);
}

/**
 * Look up one template by id. Guarded with `Object.hasOwn` rather than a
 * bare `FLEET_TEMPLATES[templateId]` lookup (PRR-B R1 HOLD, Ruling
 * A560-PR3012-R1-HOLD-RECONCILED): `templateId: '__proto__'` would
 * otherwise read the special `__proto__` accessor and return
 * `Object.prototype` itself — truthy, so `|| null` never caught it, and a
 * downstream caller reading `.seatGroups` off that object would throw.
 * @param {string} templateId
 * @returns {object|null}
 */
function getFleetTemplate(templateId) {
  return Object.hasOwn(FLEET_TEMPLATES, templateId) ? FLEET_TEMPLATES[templateId] : null;
}

/** Letter suffixes for a configured seat group: a, b, ..., z, then aa, bb, ... (never needed in practice given `max` caps below 27, but total rather than silently truncating). */
function _letterSuffix(index) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  if (index < letters.length) return letters[index];
  return letters[Math.floor(index / letters.length) - 1] + letters[index % letters.length];
}

/**
 * Produce the concrete seat list for a template: the fixed templates'
 * seats verbatim, or `large-configurable`'s seats built from `config`
 * (role -> count), each group's count clamped to its declared `min`/`max`
 * and defaulted when the caller omits it.
 * @param {string} templateId
 * @param {Record<string, number>} [config] - Only consulted for
 *   `large-configurable`; ignored (not refused) for a fixed template, since
 *   passing an empty/default config for every template is a harmless,
 *   uniform call shape for a caller that doesn't yet know which template
 *   it has.
 * @returns {{templateId: string, version: number, seats: Array<{role: string, seatId: string, supervisory: boolean}>}|null}
 *   `null` when `templateId` doesn't name a real template.
 */
function instantiateFleetTemplate(templateId, config = {}) {
  const template = getFleetTemplate(templateId);
  if (!template) return null;
  if (!template.configurable) {
    return { templateId, version: template.version, seats: template.seats.map((s) => ({ ...s })) };
  }
  const seats = [{ role: 'PM', seatId: 'pm', supervisory: true }];
  for (const [role, group] of Object.entries(template.seatGroups)) {
    const requested = Number.isSafeInteger(config[role]) ? config[role] : group.default;
    const count = Math.max(group.min, Math.min(group.max, requested));
    const roleSlug = role.toLowerCase();
    for (let i = 0; i < count; i += 1) {
      seats.push({ role, seatId: `${roleSlug}-${_letterSuffix(i)}`, supervisory: false });
    }
  }
  return { templateId, version: template.version, seats };
}

/**
 * The guided apply-wizard planner (#2984 deliverable 2): split a template's
 * instantiated seats into `immediateSeats` (started on fleet launch — the
 * supervisory PM seat, and ONLY that seat, so an idle worker never burns a
 * token before there is work for it) and `deferredSeats` (woken later, on
 * demand, by {@link admitDeferredSeat}).
 * @param {string} templateId
 * @param {Record<string, number>} [config]
 * @returns {{templateId: string, version: number, immediateSeats: Array<object>, deferredSeats: Array<object>}|null}
 *   `null` when `templateId` doesn't name a real template.
 */
function planFleetApply(templateId, config = {}) {
  const instantiated = instantiateFleetTemplate(templateId, config);
  if (!instantiated) return null;
  const immediateSeats = instantiated.seats.filter((s) => s.supervisory);
  const deferredSeats = instantiated.seats.filter((s) => !s.supervisory).map((s) => ({ ...s, trigger: 'on-demand' }));
  return { templateId: instantiated.templateId, version: instantiated.version, immediateSeats, deferredSeats };
}

/**
 * Wake one deferred seat on demand, moving it from `deferredSeats` to
 * `immediateSeats` on a COPY of `plan` (pure — `plan` itself is untouched).
 * @param {{immediateSeats: Array<object>, deferredSeats: Array<object>}} plan - A {@link planFleetApply} result.
 * @param {string} seatId
 * @returns {{plan: object, admitted: boolean}} `admitted` is false (and
 *   `plan` is returned unchanged) when `seatId` is not a deferred seat on
 *   this plan — already admitted, or never part of it.
 */
function admitDeferredSeat(plan, seatId) {
  const index = plan.deferredSeats.findIndex((s) => s.seatId === seatId);
  if (index === -1) return { plan, admitted: false };
  const seat = plan.deferredSeats[index];
  const { trigger: _trigger, ...admitted } = seat;
  return {
    plan: {
      ...plan,
      immediateSeats: [...plan.immediateSeats, admitted],
      deferredSeats: plan.deferredSeats.filter((_, i) => i !== index)
    },
    admitted: true
  };
}

module.exports = {
  ROLES,
  listFleetTemplates,
  getFleetTemplate,
  instantiateFleetTemplate,
  planFleetApply,
  admitDeferredSeat
};

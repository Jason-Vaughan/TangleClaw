'use strict';

/*
 * A synthetic fleet for measuring the Medusa wake monitor (#2086).
 *
 * It drives the real `lib/medusa-wake.js` tick through that module's own
 * `_internal` seams, with session-shaped records in the states the issue
 * names: no mail, idle with mail, busy, a draft in the composer, an unprofiled
 * engine, a listener that is off, and a session that ended between the roster
 * read and its scan. No tmux, no Hub and no live session is touched.
 *
 * Time is virtual. Every seam call advances one shared clock by a stated
 * cost, and the harness fires ticks the way Node fires an interval: the next
 * tick is due one interval after the previous one STARTED, and a tick that
 * runs past that starts the next one late. So tick duration, start lag and
 * arrival-to-wake latency come out as exact numbers that depend only on the
 * cost model, never on how loaded the machine running the test is.
 *
 * What it does not measure: real tmux or SQLite cost. The cost model's
 * numbers are inputs. The durable attempt record is modelled here too, as the
 * set of workspaces a wake was attempted for; the real one is
 * `lib/medusa-exchanges.js`.
 */

const { performance } = require('node:perf_hooks');
const wake = require('../../lib/medusa-wake');
const {
  IDLE_PANE, BUSY_PANE, TYPING_PANE, AG_IDLE_PANE, AG_BUSY_PANE, AG_TYPING_PANE
} = require('../_wake-fixtures');

/** The at-rest, busy and drafting panes of each pane-judged engine the fleet can hold. */
const PANES = Object.freeze({
  claude: { idle: IDLE_PANE, busy: BUSY_PANE, draft: TYPING_PANE },
  antigravity: { idle: AG_IDLE_PANE, busy: AG_BUSY_PANE, draft: AG_TYPING_PANE }
});

/** Session states the matrix mixes, in the order a fleet is filled. */
const FILLER_STATES = Object.freeze(['no-mail', 'busy', 'draft', 'unprofiled', 'listener-off', 'ended']);

/**
 * What each seam call costs, in virtual milliseconds.
 *
 * The two tmux figures are the median of a measurement, taken 2026-10-04 on
 * the development host against a throwaway tmux server: one `tmux` command
 * costs about 18.5 ms, nearly all of it process start. `lib/tmux.js` runs four
 * commands for a pane capture (a liveness probe, an alternate-screen check
 * that probes again and asks, and the capture) and three for a cursor probe.
 * The other figures are small round estimates for in-process lookups and are
 * not measured.
 */
const DEFAULT_COSTS = Object.freeze({
  getProject: 0.05,
  wrapRunning: 0.01,
  rotationOpen: 0.05,
  loadProjectConfig: 0.5,
  getStatus: 0.02,
  getMessages: 0.02,
  capturePane: 74,
  cursorInfo: 55.5,
  injectCommand: 250,
  durable: 0.2
});

/** The same model with every tmux command at the 95th percentile of that measurement (63 ms and 42 ms). */
const P95_COSTS = Object.freeze({ ...DEFAULT_COSTS, capturePane: 252, cursorInfo: 126 });

/** The interval the monitor ticks on in production. */
const INTERVAL_MS = 5000;

/**
 * One synthetic session and what its seams answer.
 * @param {number} id - Session id
 * @param {string} state - One of `idle-mail`, `slow`, `throwing` or a `FILLER_STATES` value
 * @param {object} [opts]
 * @param {'claude'|'antigravity'} [opts.engine='claude'] - The session's engine
 * @param {number} [opts.slowReads=Infinity] - For a `slow` session, how many pane reads
 *   are slow before the pane answers normally, at rest
 * @returns {object}
 */
function makeSession(id, state, opts = {}) {
  const hasMail = state !== 'no-mail';
  const engine = opts.engine || 'claude';
  const panes = PANES[engine];
  return {
    state,
    record: {
      id,
      projectId: id,
      sessionMode: 'tmux',
      tmuxSession: `syn-${id}`,
      engineId: state === 'unprofiled' ? 'no-such-engine' : engine,
      ...(state === 'ended' ? { status: 'ended' } : {})
    },
    project: { id, name: `syn-proj-${id}`, path: `/nonexistent/syn-proj-${id}` },
    status: {
      state: state === 'listener-off' ? 'off' : 'listening',
      workspaceId: `syn-ws-${id}`,
      unread: hasMail ? 1 : 0,
      lastError: null
    },
    inbox: hasMail ? [{ id: `m-${id}-1`, from: 'peer', message: 'hello' }] : [],
    pane: state === 'busy' ? panes.busy : state === 'draft' ? panes.draft : panes.idle,
    slowReadsLeft: state === 'slow' ? (opts.slowReads ?? Infinity) : 0
  };
}

/**
 * Build a fleet of `size` sessions holding exactly one eligible recipient.
 * @param {object} opts
 * @param {number} opts.size - Sessions in the fleet
 * @param {'first'|'last'} [opts.eligibleAt='last'] - Where the eligible recipient sits in scan order
 * @param {string[]} [opts.lead=[]] - States placed first in scan order (`slow`, `throwing`)
 * @param {string[]} [opts.fillers] - States the rest of the fleet cycles through
 * @param {'claude'|'antigravity'} [opts.engine] - Every session's engine
 * @param {number} [opts.slowReads] - How many reads of a `slow` session are slow
 * @returns {object[]} Sessions in scan order
 */
function buildFleet(opts) {
  const lead = opts.lead || [];
  const cycle = opts.fillers || FILLER_STATES;
  const fillers = Math.max(0, opts.size - 1 - lead.length);
  const states = lead.slice(0, Math.max(0, opts.size - 1));
  for (let i = 0; i < fillers; i++) states.push(cycle[i % cycle.length]);
  if (opts.eligibleAt === 'first') states.unshift('idle-mail'); else states.push('idle-mail');
  return states.map((state, i) => makeSession(i + 1, state, { engine: opts.engine, slowReads: opts.slowReads }));
}

/**
 * Install a fleet on the wake monitor's seams.
 * @param {object[]} fleet - `buildFleet` output
 * @param {object} [opts]
 * @param {object} [opts.costs] - Overrides for `DEFAULT_COSTS`
 * @param {number} [opts.slowMs=5000] - What a `slow` session's pane read costs. tmux
 *   calls time out at 5000 ms, which is also the tick interval.
 * @param {() => number} [opts.clock] - Replaces the meter's clock, to show the meter cannot change a tick
 * @param {boolean} [opts.durableUnreadable=false] - The durable attempt record throws when read
 * @param {number} [opts.realScale] - When set, each cost also blocks the thread for `cost / realScale` real ms
 * @returns {object} The world: its clock, what was injected and recorded, and `restore()`
 */
function install(fleet, opts = {}) {
  const costs = { ...DEFAULT_COSTS, ...(opts.costs || {}) };
  const slowMs = opts.slowMs ?? 5000;
  const saved = { ...wake._internal };
  // Looked up live, newest first, so a replacement session that joins the
  // fleet later is the one its project's name and pane resolve to.
  const find = (pred) => world.fleet.slice().reverse().find((x) => !x.gone && pred(x)) || world.fleet.find(pred);
  const byId = { get: (id) => world.fleet.find((x) => x.record.id === id) };
  const byProject = { get: (name) => find((x) => x.project.name === name) };
  const byTmux = { get: (name) => find((x) => x.record.tmuxSession === name) };
  const world = {
    clockMs: 0,
    fleet,
    injected: [],
    recorded: [],
    facts: [],
    attempted: new Set(),
    scans: [],
    paneReads: [],
    restore: () => { wake.stop(); Object.assign(wake._internal, saved); }
  };
  // In real mode every cost also holds the thread for a scaled-down real
  // interval, as a synchronous tmux call holds it. The thread spins to a
  // deadline rather than sleeping: a sleep overshoots by about a millisecond,
  // which is larger than most of the costs being modelled.
  let realDeadline = null;
  const spend = (ms) => {
    world.clockMs += ms;
    if (!opts.realScale) return;
    const now = performance.now();
    realDeadline = Math.max(realDeadline ?? now, now) + ms / opts.realScale;
    while (performance.now() < realDeadline) { /* hold the thread */ }
  };
  const s = wake._internal;

  s.clock = opts.clock || (() => world.clockMs);
  s.now = () => 1_700_000_000_000 + Math.round(world.clockMs);
  s.listLiveAll = () => world.fleet.filter((x) => !x.gone).map((x) => x.record);
  s.masterWakeRecord = () => null;
  s.getProject = (projectId) => { spend(costs.getProject); return find((x) => x.project.id === projectId).project; };
  s.wrapRunning = () => { spend(costs.wrapRunning); return false; };
  s.rotationOpen = () => { spend(costs.rotationOpen); return false; };
  s.loadProjectConfig = () => { spend(costs.loadProjectConfig); return { medusaWake: true }; };
  s.getStatus = (sessionId) => {
    spend(costs.getStatus);
    const x = byId.get(sessionId);
    // The listener read is the one lookup `_judgeSession` does not guard, so a
    // failure here escapes the scan and is caught by the tick.
    if (x.state === 'throwing') throw new Error('synthetic: listener status failed');
    return x.status;
  };
  s.getMessages = (sessionId) => { spend(costs.getMessages); return byId.get(sessionId).inbox; };
  s.capturePane = (tmuxName) => {
    const x = byTmux.get(tmuxName);
    world.paneReads.push({ sessionId: x.record.id, at: world.clockMs });
    if (x.slowReadsLeft > 0) {
      x.slowReadsLeft -= 1;
      spend(slowMs);
      throw new Error('synthetic: tmux timed out');
    }
    // A read that is slow and still answers, as a loaded tmux server gives.
    if (x.slowAnswersLeft > 0) {
      x.slowAnswersLeft -= 1;
      spend(slowMs);
      return { lines: x.pane };
    }
    spend(costs.capturePane);
    // Recorded at the moment the pane is read: the first point at which the
    // monitor has looked at this recipient's live state for this mail.
    world.scans.push({ sessionId: x.record.id, at: world.clockMs });
    return { lines: x.pane };
  };
  s.cursorInfo = () => { spend(costs.cursorInfo); return null; };
  s.injectCommand = (projectName, command, options) => {
    spend(costs.injectCommand);
    world.injected.push({ sessionId: byProject.get(projectName).record.id, at: world.clockMs, command, options });
    return { ok: true, error: null };
  };
  s.injectMaster = () => ({ ok: false, error: 'no master in a synthetic fleet' });
  s.recordDelivery = (entry) => { world.recorded.push({ ...entry, at: world.clockMs }); };
  s.recordWakeFacts = (workspaceId, fact, o) => {
    spend(costs.durable);
    world.facts.push({ workspaceId, fact, code: o && o.code, at: world.clockMs });
    if (fact === 'wake_attempted') world.attempted.add(workspaceId);
  };
  s.alreadyAttempted = (workspaceId) => {
    spend(costs.durable);
    if (opts.durableUnreadable) throw new Error('synthetic: attempt record unreadable');
    return world.attempted.has(workspaceId);
  };
  s.rearmDue = () => { spend(costs.durable); return false; };
  s.awaitingReadiness = () => { spend(costs.durable); return false; };
  s.pendingWakeCount = () => 0;
  s.noteAwaitingRead = () => { spend(costs.durable); };
  s.noteReadiness = () => { spend(costs.durable); };
  s.verifySubmission = () => Promise.resolve({ outcome: 'unknown', reason: 'synthetic' });
  s.declaresObserver = () => false;
  return world;
}

/**
 * Fire ticks the way a Node interval would, on the virtual clock.
 * @param {object} world - `install` output
 * @param {number} ticks - Ticks to fire
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=5000] - Timer interval
 * @returns {Array<{dueAt: number, startedAt: number, lagMs: number, durationMs: number}>}
 */
function runTicks(world, ticks, opts = {}) {
  const intervalMs = opts.intervalMs ?? INTERVAL_MS;
  const out = [];
  let dueAt = world.nextDueAt ?? world.clockMs + intervalMs;
  for (let i = 0; i < ticks; i++) {
    if (world.clockMs < dueAt) world.clockMs = dueAt;
    const startedAt = world.clockMs;
    wake._internal.tick();
    out.push({ dueAt, startedAt, lagMs: startedAt - dueAt, durationMs: world.clockMs - startedAt });
    dueAt = startedAt + intervalMs;
  }
  world.nextDueAt = dueAt;
  return out;
}

/**
 * Run one cell of the matrix: mail is waiting at time 0, and the monitor ticks
 * until the eligible recipient is woken or `maxTicks` pass.
 * @param {object} opts - `buildFleet` options plus `costs`, `slowMs`, `maxTicks`
 * @returns {object} The cell's measurements
 */
function runCell(opts) {
  const fleet = buildFleet(opts);
  const world = install(fleet, opts);
  try {
    const eligible = fleet.find((x) => x.state === 'idle-mail');
    const ticks = [];
    const maxTicks = opts.maxTicks ?? 12;
    while (ticks.length < maxTicks && !world.injected.some((n) => n.sessionId === eligible.record.id)) {
      ticks.push(...runTicks(world, 1));
    }
    const nudges = world.injected.filter((n) => n.sessionId === eligible.record.id);
    const firstScan = world.scans.find((x) => x.sessionId === eligible.record.id);
    const last = wake.tickMetrics().last;
    const durations = ticks.map((t) => t.durationMs);
    const wrongly = world.injected.filter((n) => n.sessionId !== eligible.record.id);
    return {
      size: fleet.length,
      eligibleAt: opts.eligibleAt || 'last',
      lead: (opts.lead || []).join('+') || 'none',
      mix: opts.fillers ? opts.fillers.join('+') : 'mixed',
      eligiblePosition: last ? last.order.findIndex((o) => o.id === eligible.record.id) : null,
      ticks: ticks.length,
      tickMsMax: Math.max(...durations),
      lagMsMax: Math.max(...ticks.map((t) => t.lagMs)),
      overruns: ticks.filter((t) => t.durationMs > INTERVAL_MS).length,
      firstAssessmentMs: firstScan ? firstScan.at : null,
      wakeMs: nudges.length ? nudges[0].at : null,
      nudgesToEligible: nudges.length,
      nudgesToOthers: wrongly.length,
      // Each session's verdict on the last tick, in ROSTER order. The scan
      // order is the monitor's to choose, so a verdict is looked up by session
      // and never read off by position.
      verdicts: last ? fleet.map((x) => (last.order.find((o) => o.id === x.record.id) || { result: null }).result) : [],
      states: fleet.map((x) => x.state),
      injected: world.injected.map((n) => ({ sessionId: n.sessionId, at: n.at })),
      ledger: world.recorded.map((r) => `${r.sessionId}|${r.outcome}|${r.skipReason || ''}`)
    };
  } finally {
    world.restore();
  }
}

/**
 * Restart mid-queue: the eligible recipient is woken, the monitor is stopped
 * and started again (which clears everything it holds in memory), and it
 * ticks on with the mail still unread.
 * @param {object} [opts] - `install` options (`durableUnreadable`), plus `size`
 * @returns {{nudgesBefore: number, nudgesAfter: number, duplicates: number}}
 */
function runRestart(opts = {}) {
  const fleet = buildFleet({ size: opts.size ?? 5, eligibleAt: 'last' });
  const world = install(fleet, opts);
  try {
    const eligible = fleet.find((x) => x.state === 'idle-mail');
    const count = () => world.injected.filter((n) => n.sessionId === eligible.record.id).length;
    runTicks(world, 3);
    const nudgesBefore = count();
    wake.stop();
    runTicks(world, opts.ticksAfter ?? 6);
    return { nudgesBefore, nudgesAfter: count(), duplicates: count() - 1 };
  } finally {
    world.restore();
  }
}

/**
 * A recipient that leaves mid-queue: it holds unread mail in `state`, is
 * scanned, then drops out of the live roster (ended), and optionally a
 * replacement session of the same project and workspace joins.
 * @param {object} [opts]
 * @param {string} [opts.state='busy'] - The departing session's state
 * @param {boolean} [opts.replaced=false] - Whether an idle replacement joins
 * @returns {{ledgerBefore: string[], ledgerAfter: string[], nudgedDeparted: number, nudgedReplacement: number}}
 */
function runDeparture(opts = {}) {
  const departing = makeSession(1, opts.state || 'busy');
  const fleet = [departing, makeSession(2, 'no-mail')];
  const world = install(fleet, opts);
  try {
    const rows = () => world.recorded.map((r) => `${r.sessionId}|${r.outcome}|${r.skipReason || ''}`);
    runTicks(world, 3);
    const ledgerBefore = rows();
    departing.gone = true;
    if (opts.replaced) {
      // The same project and workspace under a new session id, at rest.
      const next = makeSession(1, 'idle-mail');
      next.record = { ...next.record, id: 101, projectId: 1 };
      world.fleet.push(next);
    }
    runTicks(world, 6);
    return {
      ledgerBefore,
      ledgerAfter: rows(),
      nudgedDeparted: world.injected.filter((n) => n.sessionId === 1).length,
      nudgedReplacement: world.injected.filter((n) => n.sessionId === 101).length
    };
  } finally {
    world.restore();
  }
}

/** Fleet sizes the issue asks for. */
const SIZES = Object.freeze([1, 2, 5, 10, 20, 30]);

module.exports = {
  SIZES, INTERVAL_MS, DEFAULT_COSTS, P95_COSTS, FILLER_STATES,
  makeSession, buildFleet, install, runTicks, runCell, runRestart, runDeparture
};

'use strict';

/*
 * #1912, ADR 0020 §4, §6, §7, §8: the pure composition. One test per rule, the
 * currency (supersession and expiry) rules, the narrowing limits, the six
 * acceptance cases #1912 names, and the structural ban on transcript parsing.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  AVAILABILITY: A, EXPIRY_MS, receiptCurrency, composeBase, applyNarrowing, composeLane, parseTime
} = require('../lib/workload-compose');

const NOW = Date.parse('2026-09-26T21:00:00.000Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const receipt = (state, clearance, msAgo = 60 * 1000, extra = {}) => ({ state, clearance, receivedAt: at(msAgo), summary: 's', ...extra });
const eng = (activity) => ({ activity });
const live = { sessionActive: true, launchLive: true, controlEvents: [], wrapStartedAtMs: null, wrapRequested: false, nowMs: NOW };

describe('receipt currency (ADR 0020 §4)', () => {
  it('a fresh receipt on the live launch of an active session is current', () => {
    assert.deepEqual(receiptCurrency(receipt('complete', 'safe-to-clear'), live), { current: true, staleReason: null });
  });

  it('no receipt is simply absent, not stale', () => {
    assert.deepEqual(receiptCurrency(null, live), { current: false, staleReason: null });
  });

  it('an ended session, another launch or a malformed receipt is not current', () => {
    assert.equal(receiptCurrency(receipt('complete', 'safe-to-clear'), { ...live, sessionActive: false }).staleReason, 'session-ended');
    assert.equal(receiptCurrency(receipt('complete', 'safe-to-clear'), { ...live, launchLive: false }).staleReason, 'other-launch');
    assert.equal(receiptCurrency({ state: 'complete', clearance: 'safe-to-clear', receivedAt: 'garbage' }, live).staleReason, 'malformed');
    assert.equal(receiptCurrency({ state: 'idle', clearance: 'safe-to-clear', receivedAt: at(0) }, live).staleReason, 'malformed');
  });

  it('each state expires at its window and not a millisecond before', () => {
    for (const [state, ms] of Object.entries(EXPIRY_MS)) {
      const clearance = state === 'working' ? 'do-not-clear' : 'safe-to-clear';
      assert.equal(receiptCurrency(receipt(state, clearance, ms), live).current, true, `${state} at exactly its window`);
      assert.equal(receiptCurrency(receipt(state, clearance, ms + 1), live).staleReason, 'expired', `${state} past its window`);
    }
    assert.equal(EXPIRY_MS.working, 30 * 60 * 1000);
    assert.equal(EXPIRY_MS.complete, 120 * 60 * 1000, 'complete expires too: no assertion is trusted forever');
  });

  it('a pending wrap request, or a wrap of this session started after the receipt, supersedes it', () => {
    const r = receipt('complete', 'safe-to-clear', 60 * 1000);
    assert.equal(receiptCurrency(r, { ...live, wrapRequested: true }).staleReason, 'wrap-requested');
    assert.equal(receiptCurrency(r, { ...live, wrapStartedAtMs: NOW - 30 * 1000 }).staleReason, 'wrap-started');
    assert.equal(receiptCurrency(r, { ...live, wrapStartedAtMs: NOW - 120 * 1000 }).current, true, 'an earlier wrap does not');
  });

  it('a hold, release, stop, rebind or close after the receipt supersedes it; a create does not', () => {
    const r = receipt('complete', 'safe-to-clear', 60 * 1000);
    const later = new Date(NOW - 10 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    for (const kind of ['hold', 'release', 'stop', 'rebind', 'close']) {
      assert.equal(receiptCurrency(r, { ...live, controlEvents: [{ kind, createdAt: later }] }).staleReason, `control-${kind}`);
    }
    assert.equal(receiptCurrency(r, { ...live, controlEvents: [{ kind: 'create', createdAt: later }] }).current, true);
  });

  it('a control event in the same second as the receipt counts as after it (fail closed); one a second earlier does not', () => {
    const received = '2026-09-26T20:59:00.700Z';
    const r = { state: 'complete', clearance: 'safe-to-clear', receivedAt: received, summary: 's' };
    assert.equal(receiptCurrency(r, { ...live, controlEvents: [{ kind: 'hold', createdAt: '2026-09-26 20:59:00' }] }).current, false);
    assert.equal(receiptCurrency(r, { ...live, controlEvents: [{ kind: 'hold', createdAt: '2026-09-26 20:58:59' }] }).current, true);
  });

  it('ordinary Medusa traffic is not an input at all: nothing but control and wrap events supersede', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'workload-compose.js'), 'utf8');
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /medusa|exchange|message/i);
  });

  it('reads SQLite second-precision timestamps as UTC', () => {
    assert.equal(parseTime('2026-09-26 20:59:00'), Date.parse('2026-09-26T20:59:00Z'));
  });
});

describe('base composition, rule by rule (ADR 0020 §6)', () => {
  const base = (patch) => composeBase({
    sessionActive: true, masterLane: false, controlState: null, engine: eng('at-rest'),
    receipt: receipt('complete', 'safe-to-clear'), receiptCurrent: true, ...patch
  });

  it('rule 1: a session that is not active is UNKNOWN', () => {
    assert.deepEqual(base({ sessionActive: false }), { availability: A.UNKNOWN, clearance: 'unknown', reasons: ['session-not-active'] });
  });

  it('rule 2: a Project Master lane is UNKNOWN with an explicit unsupported reason', () => {
    assert.deepEqual(base({ masterLane: true }), { availability: A.UNKNOWN, clearance: 'unknown', reasons: ['unsupported-master-lane'] });
  });

  it('rule 3: a stopped lane is STOPPED; clearance is do-not-clear when busy, capped otherwise, unknown without a receipt', () => {
    assert.equal(base({ controlState: 'stopped' }).availability, A.STOPPED);
    assert.equal(base({ controlState: 'stopped' }).clearance, 'do-not-clear', 'safe is capped, never kept');
    assert.equal(base({ controlState: 'stopped', engine: eng('busy') }).clearance, 'do-not-clear');
    assert.equal(base({ controlState: 'stopped', receipt: null, receiptCurrent: false }).clearance, 'unknown');
  });

  it('rule 4: a held lane is HELD with the same clearance rule, and never AVAILABLE', () => {
    assert.equal(base({ controlState: 'held' }).availability, A.HELD);
    assert.equal(base({ controlState: 'held' }).clearance, 'do-not-clear');
    assert.equal(base({ controlState: 'held', receipt: receipt('blocked', 'unknown') }).clearance, 'unknown');
  });

  it('rule 5: engine busy is WORKING / do-not-clear, whatever the receipt says', () => {
    assert.deepEqual(base({ engine: eng('busy') }), { availability: A.WORKING, clearance: 'do-not-clear', reasons: ['engine-busy'] });
  });

  it('rule 6: no current receipt is UNKNOWN, even with the engine at rest', () => {
    assert.equal(base({ receipt: null, receiptCurrent: false }).availability, A.UNKNOWN);
    assert.equal(base({ receiptCurrent: false }).availability, A.UNKNOWN, 'a stale receipt counts for nothing');
  });

  it('rules 7–9: working, waiting-external and blocked', () => {
    assert.deepEqual(base({ receipt: receipt('working', 'do-not-clear') }), { availability: A.WORKING, clearance: 'do-not-clear', reasons: ['receipt-working'] });
    assert.equal(base({ receipt: receipt('waiting-external', 'safe-to-clear', 1000, { wait: 'ci' }) }).availability, A.WAITING);
    assert.equal(base({ receipt: receipt('waiting-external', 'safe-to-clear', 1000, { wait: 'ci' }) }).clearance, 'safe-to-clear', 'as asserted');
    assert.equal(base({ receipt: receipt('blocked', 'do-not-clear') }).availability, A.BLOCKED);
  });

  it('rule 10: AVAILABLE needs complete + safe-to-clear AND the engine observed at rest', () => {
    assert.deepEqual(base({}), { availability: A.AVAILABLE, clearance: 'safe-to-clear', reasons: ['receipt-complete-safe', 'engine-at-rest'] });
  });

  it('rule 11: complete otherwise is COMPLETE_NOT_CLEAR, with clearance capped', () => {
    for (const activity of ['not-at-rest', 'unknown']) {
      const r = base({ engine: eng(activity) });
      assert.equal(r.availability, A.COMPLETE_NOT_CLEAR, activity);
      assert.equal(r.clearance, 'do-not-clear', `${activity}: safe is capped without observed rest`);
    }
    assert.equal(base({ receipt: receipt('complete', 'do-not-clear') }).availability, A.COMPLETE_NOT_CLEAR);
    assert.equal(base({ receipt: receipt('complete', 'unknown') }).clearance, 'unknown');
  });
});

describe('operator narrowing is monotone and applied last (ADR 0020 §7)', () => {
  const v = (availability, clearance) => ({ availability, clearance, reasons: ['r'] });

  it('can cap clearance and force UNKNOWN over AVAILABLE, COMPLETE_NOT_CLEAR, WAITING and BLOCKED', () => {
    for (const av of [A.AVAILABLE, A.COMPLETE_NOT_CLEAR, A.WAITING, A.BLOCKED]) {
      const out = applyNarrowing(v(av, 'safe-to-clear'), { capClearance: false, forceUnknown: true });
      assert.equal(out.availability, A.UNKNOWN, av);
      assert.equal(out.clearance, 'do-not-clear', `${av}: never UNKNOWN yet safe`);
    }
    assert.equal(applyNarrowing(v(A.AVAILABLE, 'safe-to-clear'), { capClearance: true, forceUnknown: false }).clearance, 'do-not-clear');
  });

  it('never hides WORKING, HELD or STOPPED, and never raises anything', () => {
    for (const av of [A.WORKING, A.HELD, A.STOPPED, A.UNKNOWN]) {
      assert.equal(applyNarrowing(v(av, 'do-not-clear'), { capClearance: true, forceUnknown: true }).availability, av);
    }
    assert.equal(applyNarrowing(v(A.WAITING, 'unknown'), { capClearance: true, forceUnknown: false }).clearance, 'unknown', 'unknown is not raised');
  });

  it('keeps the base verdict beside the narrowed one in reasons', () => {
    const out = applyNarrowing(v(A.AVAILABLE, 'safe-to-clear'), { capClearance: false, forceUnknown: true });
    assert.ok(out.reasons.includes('base:AVAILABLE/safe-to-clear'));
    assert.ok(out.reasons.includes('operator-narrowed:UNKNOWN/do-not-clear'));
  });

  it('comes after engine busy: a narrowing on a busy lane still reads WORKING', () => {
    const { composed } = composeLane({
      ...live, receipt: receipt('complete', 'safe-to-clear'), engine: eng('busy'),
      narrowing: { capClearance: true, forceUnknown: true }
    });
    assert.equal(composed.availability, A.WORKING);
  });
});

describe('the #1912 acceptance cases', () => {
  const lane = (patch) => composeLane({ ...live, engine: eng('at-rest'), ...patch });

  it('1. a pane at rest with a current complete + safe-to-clear receipt is AVAILABLE, with evidence and summary', () => {
    const { composed, workload } = lane({ receipt: receipt('complete', 'safe-to-clear', 60000, { summary: 'Train 2 merged' }) });
    assert.equal(composed.availability, A.AVAILABLE);
    assert.equal(workload.provenance, 'explicit-receipt');
    assert.equal(workload.receipt.summary, 'Train 2 merged');
    assert.equal(workload.ageSeconds, 60);
  });

  it('2. a pane at its prompt with a current waiting-external + do-not-clear receipt for CI is WAITING, not available', () => {
    const { composed } = lane({ receipt: receipt('waiting-external', 'do-not-clear', 60000, { wait: 'ci' }) });
    assert.equal(composed.availability, A.WAITING);
    assert.equal(composed.clearance, 'do-not-clear');
  });

  it('3. a busy marker after a safe receipt is WORKING and not clear', () => {
    const { composed } = lane({ receipt: receipt('complete', 'safe-to-clear'), engine: eng('busy') });
    assert.equal(composed.availability, A.WORKING);
    assert.equal(composed.clearance, 'do-not-clear');
  });

  it('4. a new dispatch-equivalent control event, a new launch, a wrap or a killed session invalidates the old receipt', () => {
    const r = receipt('complete', 'safe-to-clear', 60000);
    const later = new Date(NOW - 1000).toISOString().replace('T', ' ').slice(0, 19);
    for (const patch of [
      { controlEvents: [{ kind: 'hold', createdAt: later }] },
      { launchLive: false },
      { wrapRequested: true },
      { wrapStartedAtMs: NOW - 1000 },
      { sessionActive: false }
    ]) {
      const { composed, workload } = lane({ receipt: r, ...patch });
      assert.notEqual(composed.availability, A.AVAILABLE, JSON.stringify(patch));
      assert.equal(workload.provenance, 'stale', JSON.stringify(patch));
    }
  });

  it('5. a missing, malformed or expired receipt is UNKNOWN (unauthorized writes are refused at the route)', () => {
    assert.equal(lane({ receipt: null }).composed.availability, A.UNKNOWN);
    assert.equal(lane({ receipt: { state: 'complete', clearance: 'safe-to-clear', receivedAt: 'x' } }).composed.availability, A.UNKNOWN);
    assert.equal(lane({ receipt: receipt('complete', 'safe-to-clear', EXPIRY_MS.complete + 1) }).composed.availability, A.UNKNOWN);
  });

  it('6. (the no-scan half is tested at the route in test/workload-fleet.test.js)', () => {
    assert.ok(true);
  });
});

/**
 * Lines of shipped code that PARSE a clearance phrase: the phrase inside a
 * regex, a RegExp(...) or a string-matching call. A message that merely says
 * "safe to clear" to a human is prose, not parsing.
 * @param {string} src - Source text
 * @returns {string[]} Offending lines
 */
function clearanceParsers(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // A separator is a space, `_`, `-`, or a regex whitespace token (`\s`, `\s+`, `\s*`).
  const sep = String.raw`(?:[\s_-]|\\s[+*]?)*`;
  const phrase = new RegExp(`safe${sep}to${sep}clear|do${sep}not${sep}clear`, 'i');
  const matcher = /RegExp\(|\.(includes|match|matchAll|test|indexOf|search|startsWith|endsWith)\(|(^|[=(,:!&|?\s])\/(?![/*])[^/\n]*\/[gimsuy]*/;
  return code.split('\n').filter((line) => phrase.test(line) && matcher.test(line));
}

describe('transcript parsing is banned as a source of clearance (ADR 0020 §8)', () => {
  it('the detector catches the forms parsing would take', () => {
    for (const line of [
      "if (paneText.includes('SAFE TO CLEAR')) clearance = 'safe-to-clear';",
      'const m = text.match(/DO NOT CLEAR/);',
      "const re = new RegExp('safe to clear', 'i');",
      'if (/SAFE\\s+TO\\s+CLEAR/.test(line)) {}'
    ]) {
      assert.equal(clearanceParsers(line).length, 1, line);
    }
    assert.deepEqual(clearanceParsers("return bad('X', 'work in flight is never safe to clear.');"), [], 'prose is not parsing');
  });

  it('no shipped file parses a clearance phrase', () => {
    const root = path.join(__dirname, '..');
    const files = ['server.js'];
    for (const dir of ['lib', 'public', 'bin']) {
      const walk = (d) => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, ent.name);
          if (ent.isDirectory()) walk(p);
          else if (/\.(js|mjs|cjs)$/.test(ent.name) || (dir === 'bin' && !ent.name.includes('.'))) files.push(path.relative(root, p));
        }
      };
      walk(path.join(root, dir));
    }
    const offenders = [];
    for (const f of files) {
      for (const line of clearanceParsers(fs.readFileSync(path.join(root, f), 'utf8'))) offenders.push(`${f}: ${line.trim()}`);
    }
    assert.deepEqual(offenders, []);
  });

  it('the composition takes no pane text: its inputs are facts, not captures', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'workload-compose.js'), 'utf8');
    assert.doesNotMatch(src, /capturePane|captureAsync|tmux|lines:/);
  });
});

'use strict';

/*
 * #429 (Critic R-6) — the wrap step-status vocabulary has one declared owner,
 * `wrapPipeline.STEP_STATUSES`, and every consumer must know every member.
 *
 * Adding `needs-operator` took five coordinated hand-edits across two files and
 * nothing failed when one was missed: the drawer's `STATUS_META` lookup falls
 * back to a pending tone, and `summarizeSkips` drops an unrecognized status
 * into no bucket at all — so a wrap that HALTED would render as one that was
 * merely queued, and the rollup would under-report the failure. That is the
 * defect class this train exists to close, one level up: a surface stating an
 * outcome it never measured.
 *
 * The guard is on the property (every declared status is understood by every
 * consumer), not on the current membership, so it keeps working when the next
 * status is added — which is the point.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { STEP_STATUSES } = require('../lib/wrap-pipeline');

const PUBLIC = path.join(__dirname, '..', 'public');
const CSS = fs.readFileSync(path.join(PUBLIC, 'session.css'), 'utf8');

/** @returns {object} the wrap-drawer helper namespace, loaded into a sandbox */
function loadHelpers() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'wrap-drawer.js'), 'utf8'), sandbox);
  return sandbox.window.tcWrapDrawerHelpers;
}

describe('wrap step-status vocabulary (#429 R-6)', () => {
  it('is non-empty and holds the statuses the runner itself assigns', () => {
    assert.ok(STEP_STATUSES.length > 0);
    // The runner writes these two without consulting a handler, so a
    // vocabulary that omitted them would be describing only half the states
    // the drawer actually receives.
    for (const own of ['pending', 'done', 'blocked']) {
      assert.ok(STEP_STATUSES.includes(own), `${own} missing from the declared vocabulary`);
    }
    assert.equal(new Set(STEP_STATUSES).size, STEP_STATUSES.length, 'duplicates');
  });

  for (const status of STEP_STATUSES) {
    describe(`status "${status}"`, () => {
      it('has a label and a tooltip in the drawer, not a raw fallback', () => {
        const H = loadHelpers();
        const row = H.buildStepRow({ stepId: 's', kind: 'ai-content', status, blockers: [] }, {});
        assert.notEqual(row.statusLabel, status,
          `no STATUS_META entry — the badge would render the raw status string "${status}"`);
        assert.ok(row.statusTooltip && row.statusTooltip.length > 0,
          'an unmapped status falls back to a blank tooltip');
      });

      it('has a stylesheet rule for its tone, so the badge is not unstyled', () => {
        const H = loadHelpers();
        const tone = H.buildStepRow({ stepId: 's', kind: 'ai-content', status, blockers: [] }, {}).statusTone;
        assert.ok(CSS.includes(`.wrap-step-status--${tone} {`),
          `no CSS rule for tone "${tone}" (status "${status}")`);
      });

      it('lands in exactly one bucket of the skip rollup', () => {
        const H = loadHelpers();
        const roll = H.summarizeSkips({ results: [{ stepId: 's', kind: 'ai-content', status }] });
        assert.equal(roll.total, 1);
        assert.equal(roll.done + roll.blocked + roll.pending + roll.running + roll.skipped, 1,
          `status "${status}" is counted in total but in no bucket — the rollup under-reports it`);
      });
    });
  }

  it('the drawer declares no status the pipeline does not', () => {
    // The other direction: a tone or label left behind after a status is
    // retired is dead code that reads as live vocabulary to the next author.
    const src = fs.readFileSync(path.join(PUBLIC, 'wrap-drawer.js'), 'utf8');
    const block = src.slice(src.indexOf('const STATUS_META'), src.indexOf('function buildStepRow'));
    const declared = [...block.matchAll(/^\s{4}'?([a-z-]+)'?:\s*\{/gm)].map((m) => m[1]);
    assert.ok(declared.length > 0, 'parsed no STATUS_META keys — this guard would be vacuous');
    for (const key of declared) {
      assert.ok(STEP_STATUSES.includes(key),
        `STATUS_META declares "${key}", which lib/wrap-pipeline.js STEP_STATUSES does not`);
    }
    assert.deepEqual([...declared].sort(), [...STEP_STATUSES].sort(),
      'STATUS_META and STEP_STATUSES describe different vocabularies');
  });
});

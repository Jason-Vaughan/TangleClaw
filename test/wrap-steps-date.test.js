'use strict';

// Tests for the shared `lib/wrap-steps/_date.js` helper. Pre-refactor,
// the `_todayIsoLocal` function lived inline in both
// `lib/wrap-steps/version-bump.js` (#216) and
// `lib/wrap-steps/features-toc.js` (#215 parity commit). This module
// consolidates that into a single source of truth.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dateUtil = require('../lib/wrap-steps/_date');
const versionBump = require('../lib/wrap-steps/version-bump');
const featuresToc = require('../lib/wrap-steps/features-toc');

describe('lib/wrap-steps/_date.todayIsoLocal (shared helper extraction)', () => {
  describe('shape', () => {
    it('returns YYYY-MM-DD (10 chars, separators at indices 4 and 7)', () => {
      const out = dateUtil.todayIsoLocal();
      assert.equal(typeof out, 'string');
      assert.equal(out.length, 10, 'should be exactly 10 characters');
      assert.equal(out[4], '-', 'separator at index 4');
      assert.equal(out[7], '-', 'separator at index 7');
      assert.match(out, /^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('local vs UTC behavior', () => {
    it('returns LOCAL date (not UTC) when the host is in a non-UTC zone', (t) => {
      // Skip on UTC-host CI where the bug-vs-fix distinction is
      // unobservable (local == UTC). The wiring pins below catch
      // regressions on any host regardless of TZ.
      if (new Date().getTimezoneOffset() === 0) {
        t.skip('host is in UTC; local-vs-UTC distinction is unobservable here');
        return;
      }

      const origDate = global.Date;
      try {
        // Construct candidate UTC moments and pick whichever puts UTC
        // and LOCAL on different calendar days for this host. Covers
        // both negative-offset (Americas) and positive-offset hosts.
        const candidates = [
          new origDate(origDate.UTC(2026, 4, 23, 6, 30, 0)),
          new origDate(origDate.UTC(2026, 4, 22, 18, 0, 0))
        ];
        const pinned = candidates.find((m) => {
          const utcDay = m.toISOString().slice(0, 10);
          const pad = (n) => String(n).padStart(2, '0');
          const localDay = `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
          return utcDay !== localDay;
        });
        if (!pinned) {
          t.skip('could not construct a UTC/LOCAL date-mismatch moment for this host TZ');
          return;
        }

        global.Date = class extends origDate {
          constructor(...args) {
            super(...(args.length === 0 ? [pinned.getTime()] : args));
          }
        };

        const out = dateUtil.todayIsoLocal();
        const pad = (n) => String(n).padStart(2, '0');
        const expectedLocal = `${pinned.getFullYear()}-${pad(pinned.getMonth() + 1)}-${pad(pinned.getDate())}`;
        assert.equal(out, expectedLocal,
          `must reflect local date ${expectedLocal} for the pinned UTC moment; got ${out}`);
        assert.notEqual(out, pinned.toISOString().slice(0, 10),
          'must NOT equal the UTC slice — that would mean the UTC-emitting pattern still ships');
      } finally {
        global.Date = origDate;
      }
    });
  });

  describe('handler wiring (post-refactor — single source of truth)', () => {
    it('version-bump._internal.todayIso points to the shared util', () => {
      assert.equal(versionBump._internal.todayIso, dateUtil.todayIsoLocal,
        'version-bump must consume the shared util, not a local copy');
    });

    it('version-bump._todayIsoLocal re-exports the shared util (preserves prior public name)', () => {
      // The prior public name `_todayIsoLocal` is preserved so the
      // chunk-3 / #216-era wiring-pin tests keep passing. Confirms
      // the re-export shape is referential, not a duplicate function.
      assert.equal(versionBump._todayIsoLocal, dateUtil.todayIsoLocal);
    });

    it('features-toc._internal.todayIso points to the shared util', () => {
      assert.equal(featuresToc._internal.todayIso, dateUtil.todayIsoLocal,
        'features-toc must consume the shared util, not a local copy');
    });

    it('features-toc._todayIsoLocal re-exports the shared util (preserves prior public name)', () => {
      assert.equal(featuresToc._todayIsoLocal, dateUtil.todayIsoLocal);
    });

    it('all five references resolve to one function — no drift between call sites', () => {
      // The whole point of the refactor: if any of these diverge, a
      // future "fix it in one place" patch silently regresses one
      // call site. This pin makes that impossible to ship.
      const refs = [
        dateUtil.todayIsoLocal,
        versionBump._internal.todayIso,
        versionBump._todayIsoLocal,
        featuresToc._internal.todayIso,
        featuresToc._todayIsoLocal
      ];
      for (let i = 1; i < refs.length; i++) {
        assert.equal(refs[i], refs[0],
          `reference at index ${i} drifted from the shared util — refactor invariant violated`);
      }
    });
  });
});

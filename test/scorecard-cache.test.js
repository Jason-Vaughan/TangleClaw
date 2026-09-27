'use strict';

/*
 * The local scorecard cache that served plan pages read (#1949): its closed
 * schema, what reading it reports in each state, and its atomic replacement.
 * The fixture is the versioned contract a producer writes.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sc = require('../lib/scorecard-cache');

const FIXTURE = path.join(__dirname, 'fixtures', 'scorecard-v1.json');
const fixture = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

/**
 * The reason a document is refused, or null when it validates.
 * @param {object} doc - Candidate.
 * @returns {string|null}
 */
function refusal(doc) {
  try {
    sc.validateScorecard(doc);
    return null;
  } catch (err) {
    assert.ok(err instanceof sc.ScorecardError, `unexpected ${err}`);
    return err.message;
  }
}

describe('lib/scorecard-cache.js (#1949)', () => {
  describe('validateScorecard — the tc.scorecard/v1 contract', () => {
    it('accepts the versioned fixture', () => {
      assert.equal(refusal(fixture()), null);
    });

    it('accepts a certification section as an object, leaving its contents to its own validator', () => {
      const doc = fixture();
      doc.certification = { anything: 'judged by lib/release-certification' };
      assert.equal(refusal(doc), null);
      doc.certification = [];
      assert.match(refusal(doc), /certification must be an object/);
    });

    it('refuses an unknown key at every level it owns', () => {
      const cases = [
        (d) => { d.extra = 1; },
        (d) => { d.development.extra = 1; },
        (d) => { d.development.windows.current.extra = 1; },
        (d) => { d.development.openBacklog.extra = 1; },
        (d) => { d.development.delivery.issuesClosed.extra = 1; },
        (d) => { d.development.delivery.extra = { current: 1, baseline: 1, trend: 'flat' }; },
        (d) => { d.development.today.delivery.extra = 1; },
        (d) => { d.development.days[3].intake.extra = 1; }
      ];
      for (const mutate of cases) {
        const doc = fixture();
        mutate(doc);
        assert.match(refusal(doc), /unknown key "extra"/, mutate.toString());
      }
    });

    it('refuses a missing measure, so Delivery and Intake are always complete', () => {
      const doc = fixture();
      delete doc.development.delivery.prsMerged;
      assert.match(refusal(doc), /development\.delivery\.prsMerged is missing/);
    });

    it('refuses the wrong schema tag, a non-Pacific zone, and bad times', () => {
      let doc = fixture(); doc.schema = 'tc.scorecard/v2';
      assert.match(refusal(doc), /schema must be tc\.scorecard\/v1/);
      doc = fixture(); doc.development.timeZone = 'UTC';
      assert.match(refusal(doc), /timeZone must be America\/Los_Angeles/);
      doc = fixture(); doc.generatedAt = '2026-09-27';
      assert.match(refusal(doc), /generatedAt must be epoch milliseconds/);
      doc = fixture(); doc.freshUntil = doc.generatedAt;
      assert.match(refusal(doc), /freshUntil must be epoch milliseconds after generatedAt/);
    });

    it('refuses a time a Date cannot hold, so a valid document can always be formatted', () => {
      const card = require('../lib/plan-progress-card');
      let doc = fixture();
      doc.freshUntil = sc.MAX_EPOCH_MS;
      assert.equal(refusal(doc), null, 'the last representable instant is accepted');
      assert.doesNotThrow(() => card.renderProgressBlock('{"card":"project-health"}', { scorecard: () => ({ status: sc.STATUS.STALE, doc }) }));
      doc = fixture(); doc.freshUntil = sc.MAX_EPOCH_MS + 1;
      assert.match(refusal(doc), /freshUntil must be epoch milliseconds/);
      doc = fixture(); doc.generatedAt = Number.MAX_SAFE_INTEGER - 1; doc.freshUntil = Number.MAX_SAFE_INTEGER;
      assert.match(refusal(doc), /generatedAt must be epoch milliseconds/);
    });

    it('refuses negative, fractional or oversized counts, and accepts a negative net', () => {
      for (const bad of [-1, 1.5, sc.LIMITS.count + 1, '3', null]) {
        const doc = fixture();
        doc.development.delivery.issuesClosed.current = bad;
        assert.match(refusal(doc), /issuesClosed\.current must be a whole number/, String(bad));
      }
      const doc = fixture();
      doc.development.days[3].openBacklogNet = -7;
      assert.equal(refusal(doc), null);
    });

    it('requires the 90+ day untouched count, bounded by the open count', () => {
      let doc = fixture(); delete doc.development.openBacklog.staleOver90Days;
      assert.match(refusal(doc), /openBacklog\.staleOver90Days is missing/);
      doc = fixture(); doc.development.openBacklog.staleOver90Days = 42;
      assert.match(refusal(doc), /staleOver90Days cannot exceed the open count/);
      doc = fixture(); doc.development.openBacklog.staleOver90Days = 41;
      assert.equal(refusal(doc), null);
    });

    it('ties "no-baseline" to a null baseline, in both directions', () => {
      let doc = fixture();
      doc.development.delivery.issuesClosed.baseline = null;
      assert.match(refusal(doc), /"no-baseline" exactly when the baseline is null/);
      doc = fixture();
      doc.development.delivery.trainsCompleted.baseline = 2;
      assert.match(refusal(doc), /"no-baseline" exactly when the baseline is null/);
      doc = fixture();
      doc.development.intake.issuesOpened.trend = 'sideways';
      assert.match(refusal(doc), /trend must be one of up, down, flat, no-baseline/);
    });

    it('refuses impossible dates, a window that ends before it starts, and overlapping windows', () => {
      let doc = fixture(); doc.development.today.date = '2026-02-30';
      assert.match(refusal(doc), /today\.date is not a real calendar date/);
      doc = fixture(); doc.development.windows.current.end = '2026-09-20';
      assert.match(refusal(doc), /windows\.current starts after it ends/);
      doc = fixture(); doc.development.windows.baseline.end = '2026-09-21';
      assert.match(refusal(doc), /baseline must end before the current window starts/);
    });

    it('requires the day-by-day record newest first with one entry per date', () => {
      let doc = fixture(); doc.development.days.reverse();
      assert.match(refusal(doc), /days must be newest first, one entry per date/);
      doc = fixture(); doc.development.days[1].date = doc.development.days[0].date;
      assert.match(refusal(doc), /days must be newest first, one entry per date/);
      doc = fixture(); doc.development.days = [];
      assert.match(refusal(doc), /days must list 1–31 days/);
    });

    it('requires today to be the same record as the newest day, so the summary and the drawer agree', () => {
      let doc = fixture(); doc.development.today.delivery.prsMerged = 4;
      assert.match(refusal(doc), /today must be the same record as development\.days\[0\]/);
      doc = fixture(); doc.development.today.date = '2026-09-28';
      assert.match(refusal(doc), /today must be the same record as development\.days\[0\]/);
      doc = fixture(); doc.development.today.openBacklogNet = 0;
      assert.match(refusal(doc), /today must be the same record as development\.days\[0\]/);
    });

    it('refuses a window label carrying control or markup-shaped characters', () => {
      for (const bad of ['Last‮7 days', 'Last 7 days\n', '<b>7</b>', '', 'x'.repeat(61)]) {
        const doc = fixture();
        doc.development.windows.current.label = bad;
        assert.match(refusal(doc), /windows\.current\.label must be/, JSON.stringify(bad));
      }
    });
  });

  describe('readScorecardCache and writeScorecardCache', () => {
    let dir;
    let file;
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-scorecard-'));
      file = sc.cachePath(dir);
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('lives at <base>/scorecard/v1.json', () => {
      assert.equal(sc.cachePath('/base'), path.join('/base', 'scorecard', 'v1.json'));
    });

    it('reports missing, with a reason, before anything is written', () => {
      const r = sc.readScorecardCache(file);
      assert.equal(r.status, sc.STATUS.MISSING);
      assert.match(r.reason, /no scorecard has been published/);
      assert.equal(r.doc, undefined);
    });

    it('writes atomically and reads back ok before freshUntil, stale after it', () => {
      const doc = fixture();
      sc.writeScorecardCache(file, doc);
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ['v1.json'], 'no staging file left behind');
      const ok = sc.readScorecardCache(file, { now: doc.freshUntil });
      assert.equal(ok.status, sc.STATUS.OK);
      assert.deepEqual(ok.doc, doc);
      const stale = sc.readScorecardCache(file, { now: doc.freshUntil + 1 });
      assert.equal(stale.status, sc.STATUS.STALE);
      assert.deepEqual(stale.doc, doc, 'a stale document keeps its figures so they can be shown marked');
    });

    it('refuses to write an invalid document and leaves the previous one in place', () => {
      const before = fs.readFileSync(file, 'utf8');
      const doc = fixture();
      doc.development.extra = 1;
      assert.throws(() => sc.writeScorecardCache(file, doc), sc.ScorecardError);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    });

    it('reports invalid JSON, an invalid document and an oversized file without throwing', () => {
      fs.writeFileSync(file, '{not json');
      assert.deepEqual(sc.readScorecardCache(file), { status: sc.STATUS.INVALID, reason: 'the scorecard cache is not valid JSON' });
      const doc = fixture();
      doc.development.timeZone = 'UTC';
      fs.writeFileSync(file, JSON.stringify(doc));
      const r = sc.readScorecardCache(file);
      assert.equal(r.status, sc.STATUS.INVALID);
      assert.match(r.reason, /timeZone must be America\/Los_Angeles/);
      assert.equal(r.doc, undefined, 'an invalid document is never handed to the renderer');
      fs.writeFileSync(file, ' '.repeat(sc.MAX_BYTES + 1));
      assert.equal(sc.readScorecardCache(file).status, sc.STATUS.INVALID);
    });

    it('reports a directory in place of the file as unreadable', () => {
      const other = path.join(dir, 'as-dir');
      fs.mkdirSync(path.join(other, 'scorecard', 'v1.json'), { recursive: true });
      assert.equal(sc.readScorecardCache(sc.cachePath(other)).status, sc.STATUS.UNREADABLE);
    });
  });
});

'use strict';

// #2144 — the local scorecard producer. gh is faked through `_internal.exec`;
// nothing here reaches the network. Several tests validate the produced
// document against the REAL `lib/scorecard-cache.js` validator, so a schema
// drift between the two modules fails here, not only at write time.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');
const producer = require('../lib/scorecard-producer');
const scorecardCache = require('../lib/scorecard-cache');

setLevel('error');

describe('pacific date helpers', () => {
  it('pacificDateString reads the Pacific calendar date, not the UTC one', () => {
    // 2026-01-01T07:30:00Z is 2025-12-31 23:30 PST (UTC-8) — still the prior Pacific day.
    assert.equal(producer.pacificDateString(Date.parse('2026-01-01T07:30:00Z')), '2025-12-31');
    assert.equal(producer.pacificDateString(Date.parse('2026-01-01T09:00:00Z')), '2026-01-01');
  });

  it('shiftDateString moves by whole calendar days, forward and backward', () => {
    assert.equal(producer.shiftDateString('2026-03-01', 1), '2026-03-02');
    assert.equal(producer.shiftDateString('2026-03-01', -1), '2026-02-28');
    assert.equal(producer.shiftDateString('2026-03-01', 7), '2026-03-08');
  });

  it('dateRange lists every date inclusive, oldest first', () => {
    assert.deepEqual(producer.dateRange('2026-03-01', '2026-03-03'), ['2026-03-01', '2026-03-02', '2026-03-03']);
  });

  it('computeWindows builds a current window ending today and a baseline window ending the day before it starts', () => {
    const now = Date.parse('2026-03-10T12:00:00-08:00');
    const w = producer.computeWindows(now, { windowDays: 7 });
    assert.deepEqual(w.current, { label: 'Last 7 days', start: '2026-03-04', end: '2026-03-10' });
    assert.deepEqual(w.baseline, { label: 'Preceding 7 days', start: '2026-02-25', end: '2026-03-03' });
  });

  it('computeWindows defaults to DEFAULT_WINDOW_DAYS when windowDays is omitted', () => {
    const now = Date.parse('2026-03-10T12:00:00-08:00');
    assert.equal(producer.DEFAULT_WINDOW_DAYS, 7);
    assert.deepEqual(producer.computeWindows(now), producer.computeWindows(now, { windowDays: producer.DEFAULT_WINDOW_DAYS }));
  });
});

describe('pure figure computation', () => {
  it('computeTrend', () => {
    assert.equal(producer.computeTrend(5, null), 'no-baseline');
    assert.equal(producer.computeTrend(5, 3), 'up');
    assert.equal(producer.computeTrend(3, 5), 'down');
    assert.equal(producer.computeTrend(5, 5), 'flat');
  });

  it('buildMeasure', () => {
    assert.deepEqual(producer.buildMeasure(5, 3), { current: 5, baseline: 3, trend: 'up' });
    assert.deepEqual(producer.buildMeasure(5, null), { current: 5, baseline: null, trend: 'no-baseline' });
  });

  it('buildOpenBacklog', () => {
    assert.deepEqual(
      producer.buildOpenBacklog({ count: 41, staleOver90Days: 38, net: -4, baselineNet: 3 }),
      { count: 41, staleOver90Days: 38, net: -4, baselineNet: 3, trend: 'down' }
    );
  });
});

describe('buildDevelopmentSection / buildScorecardDocument — validated against the real scorecard-cache contract', () => {
  function sampleDays() {
    return [
      { date: '2026-03-10', delivery: { issuesClosed: 2, prsMerged: 3, carsCompleted: 0, trainsCompleted: 0 }, intake: { issuesOpened: 1 }, openBacklogNet: -1 },
      { date: '2026-03-09', delivery: { issuesClosed: 1, prsMerged: 1, carsCompleted: 0, trainsCompleted: 1 }, intake: { issuesOpened: 2 }, openBacklogNet: 1 }
    ];
  }

  function sampleDevelopmentInputs() {
    return {
      windows: { current: { label: 'Last 2 days', start: '2026-03-09', end: '2026-03-10' }, baseline: { label: 'Preceding 2 days', start: '2026-03-07', end: '2026-03-08' } },
      openBacklog: { count: 10, staleOver90Days: 2, net: 0, baselineNet: -1 },
      delivery: {
        issuesClosed: { current: 3, baseline: 2 },
        prsMerged: { current: 4, baseline: 4 },
        carsCompleted: { current: 0, baseline: 0 },
        trainsCompleted: { current: 1, baseline: null }
      },
      intake: { issuesOpened: { current: 3, baseline: 5 } },
      days: sampleDays()
    };
  }

  it('builds a development section the real validator accepts', () => {
    const dev = producer.buildDevelopmentSection(sampleDevelopmentInputs());
    assert.doesNotThrow(() => scorecardCache.validateDevelopment(dev));
    assert.deepEqual(dev.today, dev.days[0]);
    assert.equal(dev.delivery.trainsCompleted.trend, 'no-baseline');
  });

  it('refuses when a required delivery or intake key is missing', () => {
    const inputs = sampleDevelopmentInputs();
    delete inputs.delivery.carsCompleted;
    assert.throws(() => producer.buildDevelopmentSection(inputs), producer.ScorecardProducerError);
  });

  it('builds a full document the real validator accepts, with no certification by default', () => {
    const dev = producer.buildDevelopmentSection(sampleDevelopmentInputs());
    const doc = producer.buildScorecardDocument({ development: dev, now: 5000 });
    assert.doesNotThrow(() => scorecardCache.validateScorecard(doc));
    assert.equal(doc.schema, scorecardCache.SCHEMA);
    assert.equal(doc.generatedAt, 5000);
    assert.equal(doc.freshUntil, 5000 + producer.DEFAULT_FRESH_FOR_MS);
    assert.equal('certification' in doc, false);
  });

  it('passes a supplied certification summary through unvalidated by this module, present in the document', () => {
    const dev = producer.buildDevelopmentSection(sampleDevelopmentInputs());
    const certification = { anything: 'this module never inspects it' };
    const doc = producer.buildScorecardDocument({ development: dev, certification, now: 5000 });
    assert.deepEqual(doc.certification, certification);
  });
});

describe('fetchScorecardFacts / produceScorecardDocument', () => {
  let original;
  beforeEach(() => { original = producer._internal.exec; });
  afterEach(() => { producer._internal.exec = original; });

  /**
   * A fake `gh` covering every call this module makes: `repo view`, search
   * counts (keyed by exact query string), and the milestones list.
   */
  function fakeGh({ slug, counts, milestoneLines = [] }) {
    const calls = [];
    const exec = async (file, args) => {
      calls.push(args);
      assert.equal(file, 'gh');
      if (args[0] === 'repo' && args[1] === 'view') {
        return { exitCode: 0, stdout: `${slug}\n`, stderr: '', error: null };
      }
      if (args[0] === 'api' && args[1] === 'search/issues') {
        const fIdx = args.indexOf('-f');
        const q = args[fIdx + 1].slice(2); // strip "q="
        const count = counts[q];
        assert.ok(count !== undefined, `unexpected search query: ${q}`);
        return { exitCode: 0, stdout: `${count}\n`, stderr: '', error: null };
      }
      if (args[0] === 'api' && args[1] === 'repos/{owner}/{repo}/milestones') {
        return { exitCode: 0, stdout: milestoneLines.map((m) => JSON.stringify(m)).join('\n'), stderr: '', error: null };
      }
      throw new Error(`fakeGh: unexpected call ${JSON.stringify(args)}`);
    };
    return { exec, calls };
  }

  it('produces a document the real validator accepts, from a 2-day window', async () => {
    const slug = 'Jason-Vaughan/TangleClaw';
    const now = Date.parse('2026-03-10T12:00:00-08:00'); // Pacific "today" = 2026-03-10
    // windowDays:2 ending 2026-03-10 → current [03-09, 03-10], baseline [03-07, 03-08].
    const staleBoundary = producer.pacificDateString(now - producer.STALE_BACKLOG_DAYS * 24 * 60 * 60 * 1000);
    const counts = {
      [`repo:${slug}+is:issue+created:2026-03-10`]: 1,
      [`repo:${slug}+is:issue+closed:2026-03-10`]: 2,
      [`repo:${slug}+is:pr+merged:2026-03-10`]: 3,
      [`repo:${slug}+is:issue+created:2026-03-09`]: 2,
      [`repo:${slug}+is:issue+closed:2026-03-09`]: 1,
      [`repo:${slug}+is:pr+merged:2026-03-09`]: 1,
      [`repo:${slug}+is:issue+created:2026-03-07..2026-03-08`]: 5,
      [`repo:${slug}+is:issue+closed:2026-03-07..2026-03-08`]: 4,
      [`repo:${slug}+is:pr+merged:2026-03-07..2026-03-08`]: 6,
      [`repo:${slug}+is:issue+is:open`]: 41,
      [`repo:${slug}+is:issue+is:open+updated:<${staleBoundary}`]: 9
    };
    // 03-09 closes within the current window; 03-01 falls outside both windows entirely.
    const gh = fakeGh({
      slug,
      counts,
      milestoneLines: [{ closedAt: '2026-03-09T18:00:00Z' }, { closedAt: '2026-03-01T18:00:00Z' }]
    });
    producer._internal.exec = gh.exec;

    const result = await producer.produceScorecardDocument('/repo', { now, windowDays: 2 });
    assert.equal(result.available, true);
    const { document } = result;
    assert.doesNotThrow(() => scorecardCache.validateScorecard(document));

    const dev = document.development;
    assert.deepEqual(dev.windows, {
      current: { label: 'Last 2 days', start: '2026-03-09', end: '2026-03-10' },
      baseline: { label: 'Preceding 2 days', start: '2026-03-07', end: '2026-03-08' }
    });
    assert.deepEqual(dev.openBacklog, { count: 41, staleOver90Days: 9, net: 0, baselineNet: 1, trend: 'down' });
    assert.deepEqual(dev.delivery, {
      issuesClosed: { current: 3, baseline: 4, trend: 'down' },
      prsMerged: { current: 4, baseline: 6, trend: 'down' },
      carsCompleted: { current: 0, baseline: 0, trend: 'flat' },
      trainsCompleted: { current: 1, baseline: 0, trend: 'up' }
    });
    assert.deepEqual(dev.intake, { issuesOpened: { current: 3, baseline: 5, trend: 'down' } });
    assert.deepEqual(dev.days, [
      { date: '2026-03-10', delivery: { issuesClosed: 2, prsMerged: 3, carsCompleted: 0, trainsCompleted: 0 }, intake: { issuesOpened: 1 }, openBacklogNet: -1 },
      { date: '2026-03-09', delivery: { issuesClosed: 1, prsMerged: 1, carsCompleted: 0, trainsCompleted: 1 }, intake: { issuesOpened: 2 }, openBacklogNet: 1 }
    ]);
    assert.deepEqual(dev.today, dev.days[0]);
  });

  it('fetchScorecardFacts returns the raw facts produceScorecardDocument builds the document from', async () => {
    const slug = 'Jason-Vaughan/TangleClaw';
    const now = Date.parse('2026-03-10T12:00:00-08:00');
    const staleBoundary = producer.pacificDateString(now - producer.STALE_BACKLOG_DAYS * 24 * 60 * 60 * 1000);
    const counts = {
      [`repo:${slug}+is:issue+created:2026-03-10`]: 0,
      [`repo:${slug}+is:issue+closed:2026-03-10`]: 0,
      [`repo:${slug}+is:pr+merged:2026-03-10`]: 0,
      [`repo:${slug}+is:issue+created:2026-03-09`]: 0,
      [`repo:${slug}+is:issue+closed:2026-03-09`]: 0,
      [`repo:${slug}+is:pr+merged:2026-03-09`]: 0,
      [`repo:${slug}+is:issue+created:2026-03-07..2026-03-08`]: 0,
      [`repo:${slug}+is:issue+closed:2026-03-07..2026-03-08`]: 0,
      [`repo:${slug}+is:pr+merged:2026-03-07..2026-03-08`]: 0,
      [`repo:${slug}+is:issue+is:open`]: 5,
      [`repo:${slug}+is:issue+is:open+updated:<${staleBoundary}`]: 1
    };
    const gh = fakeGh({ slug, counts, milestoneLines: [] });
    producer._internal.exec = gh.exec;

    const facts = await producer.fetchScorecardFacts('/repo', { now, windowDays: 2 });
    assert.equal(facts.available, true);
    assert.deepEqual(facts.openBacklog, { count: 5, staleOver90Days: 1, net: 0, baselineNet: 0 });
    assert.equal(facts.days.length, 2);
  });

  it('is unavailable, never a guess, when gh repo view fails', async () => {
    producer._internal.exec = async (file, args) => {
      if (args[0] === 'repo') return { exitCode: 1, stdout: '', stderr: '', error: null, errorCode: 'ENOENT', timedOut: false };
      throw new Error('should not reach a search call once repo view fails');
    };
    const result = await producer.produceScorecardDocument('/repo', { now: Date.now() });
    assert.equal(result.available, false);
    assert.ok(result.reason);
  });

  it('is unavailable when a single search query fails, rather than silently zeroing that figure', async () => {
    const slug = 'Jason-Vaughan/TangleClaw';
    producer._internal.exec = async (file, args) => {
      if (args[0] === 'repo' && args[1] === 'view') return { exitCode: 0, stdout: `${slug}\n`, stderr: '', error: null };
      if (args[0] === 'api' && args[1] === 'search/issues') return { exitCode: 1, stdout: '', stderr: 'API rate limit exceeded', error: 'boom', errorCode: null, timedOut: false };
      return { exitCode: 0, stdout: '', stderr: '', error: null };
    };
    const result = await producer.produceScorecardDocument('/repo', { now: Date.now() });
    assert.equal(result.available, false);
  });
});

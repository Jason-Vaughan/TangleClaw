'use strict';

/*
 * `tc-progress` cards on served plan pages (#1949): the block names a card and
 * carries no figures; the figures come from the scorecard cache and are shown
 * as the producer stated them, in Pacific time, with Delivery apart from
 * Intake and both comparison windows labelled. Missing and stale data are
 * shown as such.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const card = require('../lib/plan-progress-card');
const sc = require('../lib/scorecard-cache');
const planDocs = require('../lib/plan-docs');

const fixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'scorecard-v1.json'), 'utf8'));
const ok = (doc = fixture()) => () => ({ status: sc.STATUS.OK, doc });

describe('lib/plan-progress-card.js (#1949)', () => {
  describe('parseProgressBlock — a closed schema naming one card', () => {
    it('accepts exactly the two cards', () => {
      assert.deepEqual(card.parseProgressBlock('{"card":"project-health"}'), { card: 'project-health' });
      assert.deepEqual(card.parseProgressBlock('{"card":"recent-progress"}'), { card: 'recent-progress' });
    });

    it('refuses figures, unknown cards and non-objects', () => {
      assert.throws(() => card.parseProgressBlock('{"card":"project-health","openBacklog":3}'), /unknown key "openBacklog"/);
      assert.throws(() => card.parseProgressBlock('{"card":"velocity"}'), /card must be one of project-health, recent-progress/);
      assert.throws(() => card.parseProgressBlock('["project-health"]'), /must be a JSON object/);
      assert.throws(() => card.parseProgressBlock('card: project-health'), /not valid JSON/);
    });

    it('renders a refused block as escaped code with the reason', () => {
      const html = card.renderProgressBlock('{"card":"<img src=x>"}', { scorecard: ok() });
      assert.match(html, /<p class="block-error">Progress block not rendered: card must be one of/);
      assert.match(html, /<pre><code class="language-tc-progress">\{&quot;card&quot;:&quot;&lt;img src=x&gt;&quot;\}<\/code><\/pre>/);
      assert.doesNotMatch(html, /<img/);
    });
  });

  describe('Pacific formatting', () => {
    it('shows instants in America/Los_Angeles with PDT or PST, never UTC', () => {
      assert.equal(card.formatPacific(Date.parse('2026-09-27T23:00:00Z')), '2026-09-27 16:00 PDT');
      assert.equal(card.formatPacific(Date.parse('2026-01-15T08:05:00Z')), '2026-01-15 00:05 PST');
    });

    it('is independent of the host zone', () => {
      const realTz = process.env.TZ;
      process.env.TZ = 'Asia/Tokyo';
      try {
        assert.equal(card.formatPacific(Date.parse('2026-09-27T23:00:00Z')), '2026-09-27 16:00 PDT');
        assert.equal(card.formatDay('2026-09-27'), 'Sun Sep 27');
      } finally {
        if (realTz === undefined) delete process.env.TZ; else process.env.TZ = realTz;
      }
    });

    it('signs a net change with a real minus sign', () => {
      assert.equal(card.formatNet(3), '+3');
      assert.equal(card.formatNet(-4), '−4');
      assert.equal(card.formatNet(0), '0');
    });
  });

  describe('Project Health card', () => {
    const html = card.renderProgressBlock('{"card":"project-health"}', { scorecard: ok() });

    it('leads with the open backlog, its 90+ day untouched part, and its stated net and trend', () => {
      assert.match(html, /<span class="progress-figure">41<\/span> open issues in the backlog \(<strong>38<\/strong> untouched 90\+ days\) · net <strong>−4<\/strong> over last 7 days \(baseline \+3, ▼ down\)/);
    });

    it('keeps Delivery and Discovery / Intake as separate groups', () => {
      const delivery = html.indexOf('>Delivery<');
      const intake = html.indexOf('>Discovery / Intake<');
      assert.ok(delivery > 0 && intake > delivery);
      assert.ok(html.indexOf('Issues closed') < intake && html.indexOf('Trains completed') < intake);
      assert.ok(html.indexOf('Issues opened') > intake);
    });

    it('shows each measure as stated, with a word and symbol for its trend', () => {
      assert.match(html, /<th scope="row">Issues closed<\/th><td>12<\/td><td>9<\/td><td class="progress-trend">▲ up<\/td>/);
      assert.match(html, /<th scope="row">PRs merged<\/th><td>15<\/td><td>15<\/td><td class="progress-trend">→ flat<\/td>/);
      assert.match(html, /<th scope="row">Trains completed<\/th><td>1<\/td><td>—<\/td><td class="progress-trend">— no baseline<\/td>/);
    });

    it('does not recompute: a stated trend is shown even when the figures would suggest another', () => {
      const doc = fixture();
      doc.development.delivery.issuesClosed = { current: 1, baseline: 9, trend: 'up' };
      const out = card.renderProgressBlock('{"card":"project-health"}', { scorecard: ok(doc) });
      assert.match(out, /Issues closed<\/th><td>1<\/td><td>9<\/td><td class="progress-trend">▲ up</);
    });

    it('labels both comparison windows with their dates, and the refresh time in Pacific', () => {
      assert.match(html, /<th scope="col">Last 7 days<br><small>Sep 21 – Sep 27<\/small><\/th>/);
      assert.match(html, /<th scope="col">Preceding 7 days<br><small>Sep 14 – Sep 20<\/small><\/th>/);
      assert.match(html, /Last refreshed <time datetime="2026-09-27T23:00:00\.000Z">2026-09-27 16:00 PDT<\/time>/);
      assert.match(html, /Baseline: <strong>Preceding 7 days<\/strong> \(Sep 14 – Sep 20\)/);
      assert.doesNotMatch(html.replace(/datetime="[^"]*"/g, ''), /UTC|Z</);
    });
  });

  describe('Recent Progress card', () => {
    // 2026-09-27 16:30 PDT: the fixture's newest day is today in Pacific time.
    const NOW = Date.parse('2026-09-27T23:30:00Z');
    const html = card.renderProgressBlock('{"card":"recent-progress"}', { scorecard: ok(), now: NOW });

    it('is a closed drawer whose summary shows today (PT) and the window', () => {
      assert.match(html, /^<details class="progress-card progress-recent"><summary/);
      assert.doesNotMatch(html, /<details[^>]* open/);
      assert.match(html, /<strong>Today \(Sun Sep 27, PT\):<\/strong> Delivery: 2 closed, 3 PRs merged, 1 cars, 0 trains · Intake: 1 opened · backlog −1/);
      assert.match(html, /<strong>Last 7 days:<\/strong> Delivery: 12 closed, 15 PRs merged, 6 cars, 1 trains · Intake: 8 opened · backlog −4/);
    });

    it('calls the newest day "Latest day", not "Today", once the Pacific date has moved on', () => {
      // 2026-09-28 00:30 PDT: the Pacific date has rolled over.
      const next = card.renderProgressBlock('{"card":"recent-progress"}', { scorecard: ok(), now: Date.parse('2026-09-28T07:30:00Z') });
      assert.match(next, /<strong>Latest day \(Sun Sep 27, PT\):<\/strong>/);
      assert.doesNotMatch(next, />Today /);
      // 2026-09-27 23:59 PDT is already Sep 28 in UTC, and still today in Pacific.
      const late = card.renderProgressBlock('{"card":"recent-progress"}', { scorecard: ok(), now: Date.parse('2026-09-28T06:59:00Z') });
      assert.match(late, /<strong>Today \(Sun Sep 27, PT\):<\/strong>/);
    });

    it('opens to a day-by-day table, newest first, with Intake in its own column group', () => {
      assert.match(html, /<th scope="colgroup" colspan="4">Delivery<\/th><th scope="colgroup" colspan="1" class="progress-intake">Discovery \/ Intake<\/th>/);
      const days = [...html.matchAll(/<tr><th scope="row">([^<]+)<\/th>/g)].map((m) => m[1]);
      assert.deepEqual(days, ['Sun Sep 27', 'Sat Sep 26', 'Fri Sep 25', 'Thu Sep 24', 'Wed Sep 23', 'Tue Sep 22', 'Mon Sep 21']);
      assert.match(html, /<th scope="row">Sat Sep 26<\/th><td>3<\/td><td>4<\/td><td>2<\/td><td>1<\/td><td class="progress-intake">2<\/td><td>−1<\/td><\/tr>/);
    });
  });

  describe('missing and stale data', () => {
    it('shows no figures, and the reason, when the cache has none', () => {
      for (const status of [sc.STATUS.MISSING, sc.STATUS.UNREADABLE, sc.STATUS.INVALID]) {
        const html = card.renderProgressBlock('{"card":"project-health"}', { scorecard: () => ({ status, reason: 'because <reasons>' }) });
        assert.match(html, /progress-unavailable/);
        assert.match(html, /Project Health: no figures to show/);
        assert.match(html, /because &lt;reasons&gt;\./);
        assert.doesNotMatch(html, /progress-figure/);
      }
    });

    it('says it has no source when the caller supplies none', () => {
      assert.match(card.renderProgressBlock('{"card":"recent-progress"}'), /Recent Progress: no figures to show.*this page has no scorecard source/s);
    });

    it('shows stale figures under a visible warning with the missed deadline in Pacific', () => {
      const doc = fixture();
      const html = card.renderProgressBlock('{"card":"project-health"}', { scorecard: () => ({ status: sc.STATUS.STALE, doc, reason: 'x' }) });
      assert.match(html, /<p class="progress-stale" role="status">⚠ Stale: these figures were due to be refreshed by <time datetime="2026-09-28T05:00:00\.000Z">2026-09-27 22:00 PDT<\/time>/);
      assert.match(html, /progress-figure">41</);
    });
  });

  describe('in a plan page', () => {
    const md = '# Registry\n\n```tc-progress\n{"card":"project-health"}\n```\n\n> ```tc-progress\n> {"card":"recent-progress"}\n> ```\n';

    it('renders both cards from one read of the cache, including inside a blockquote', () => {
      let reads = 0;
      const page = planDocs.renderPlanPage({
        project: { id: 1, name: 'p' }, file: 'r.md', relative: '.tangleclaw/plans/r.md',
        modifiedAt: '2026-09-27T00:00:00Z', markdown: md, now: Date.parse('2026-09-28T07:30:00Z'),
        scorecard: () => { reads += 1; return { status: sc.STATUS.OK, doc: fixture() }; }
      });
      assert.equal(reads, 1);
      assert.match(page, /aria-label="Project Health"/);
      assert.match(page, /<blockquote><details class="progress-card progress-recent">/);
      assert.match(page, /Latest day \(Sun Sep 27, PT\)/, 'the page passes its render time through to the card');
      assert.match(page, /\.progress-card\{/, 'the card styles ship with the page');
      assert.doesNotMatch(page, /<script/);
    });

    it('never reads the cache for a plan without a progress block', () => {
      let reads = 0;
      planDocs.renderPlanPage({
        project: { id: 1, name: 'p' }, file: 'r.md', relative: 'r.md', modifiedAt: '2026-09-27T00:00:00Z',
        markdown: '# Plain\n\n```js\n1\n```\n', scorecard: () => { reads += 1; return { status: sc.STATUS.MISSING, reason: 'x' }; }
      });
      assert.equal(reads, 0);
    });
  });
});

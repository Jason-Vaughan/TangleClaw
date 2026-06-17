'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const continuity = require('../lib/continuity');

describe('continuity store (CC-1)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-continuity-'));
  });

  after(() => {
    // Teardown only removes the temp dir (learning #6 — never touch real paths).
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('path helpers', () => {
    it('roots the store under .tangleclaw/continuity (gitignored dir)', () => {
      assert.equal(
        continuity.storeDir('/proj'),
        path.join('/proj', '.tangleclaw', 'continuity')
      );
      assert.equal(
        continuity.indexPath('/proj'),
        path.join('/proj', '.tangleclaw', 'continuity', 'index.md')
      );
    });

    it('exposes the sessions/ root (CC-4)', () => {
      assert.equal(
        continuity.sessionsRoot('/proj'),
        path.join('/proj', '.tangleclaw', 'continuity', 'sessions')
      );
      // sessionDir must nest directly under it.
      assert.equal(
        path.dirname(continuity.sessionDir('/proj', 42)),
        continuity.sessionsRoot('/proj')
      );
    });

    it('keys a session dir by sid under sessions/ (CC-4)', () => {
      assert.equal(
        continuity.sessionDir('/proj', 42),
        path.join('/proj', '.tangleclaw', 'continuity', 'sessions', '42')
      );
    });

    it('nests session uploads under sessions/<sid>/uploads (CC-4)', () => {
      assert.equal(
        continuity.sessionUploadsDir('/proj', 42),
        path.join('/proj', '.tangleclaw', 'continuity', 'sessions', '42', 'uploads')
      );
    });

    it('coerces a numeric sid to a string dir name', () => {
      // The sessions root is shared by sessionDir/sessionUploadsDir; a numeric
      // sid and its string form must resolve to the same path so listUploads
      // (which reads dir names as strings) lines up with saves keyed by number.
      assert.equal(
        continuity.sessionDir('/proj', 7),
        continuity.sessionDir('/proj', '7')
      );
    });
  });

  describe('renderIndex / parseIndex round-trip', () => {
    it('round-trips all fields', () => {
      const fields = {
        project: 'demo',
        currentState: 'Mid CC-1; spine + step landed.',
        nextAction: 'stopped at CC-1 · next is CC-2 · open continuity-contract.md',
        freshness: { sha: 'abc1234', branch: 'feat/cc-1', writtenAt: '2026-06-15' }
      };
      const parsed = continuity.parseIndex(continuity.renderIndex(fields));
      assert.equal(parsed.currentState, fields.currentState);
      assert.equal(parsed.nextAction, fields.nextAction);
      assert.deepEqual(parsed.freshness, fields.freshness);
    });

    it('renders the project name into the header', () => {
      assert.match(continuity.renderIndex({ project: 'demo' }), /^# Continuity Index — demo/);
    });

    it('flags empty judgment fields rather than dropping them', () => {
      const md = continuity.renderIndex({ freshness: { sha: 'x', branch: 'main', writtenAt: '2026-06-15' } });
      assert.match(md, /## Next action\n_⚠ not captured/);
      assert.match(md, /## Current state\n_⚠ not captured/);
    });

    it('parses a flagged-empty field back to an empty string', () => {
      const md = continuity.renderIndex({ nextAction: '', currentState: 'here' });
      const parsed = continuity.parseIndex(md);
      assert.equal(parsed.nextAction, '');
      assert.equal(parsed.currentState, 'here');
    });

    it('renders unknown freshness sentinels and parses them back to empty', () => {
      const md = continuity.renderIndex({ currentState: 'x' });
      assert.match(md, /- sha: unknown/);
      const parsed = continuity.parseIndex(md);
      assert.equal(parsed.freshness.sha, '');
      assert.equal(parsed.freshness.branch, '');
      assert.equal(parsed.freshness.writtenAt, '');
    });

    it('ignores unknown headings and tolerates junk', () => {
      const parsed = continuity.parseIndex('## Bogus\nstuff\n## Next action\ndo X\n');
      assert.equal(parsed.nextAction, 'do X');
      assert.equal(parsed.currentState, '');
    });

    it('returns empty fields for non-string input', () => {
      const parsed = continuity.parseIndex(null);
      assert.equal(parsed.nextAction, '');
      assert.deepEqual(parsed.freshness, { sha: '', branch: '', writtenAt: '' });
    });
  });

  describe('writeIndex / readIndex', () => {
    it('creates the store dir and writes the index file', () => {
      const proj = path.join(tmpDir, 'p1');
      fs.mkdirSync(proj, { recursive: true });
      const written = continuity.writeIndex(proj, {
        project: 'p1',
        currentState: 'state A',
        nextAction: 'next B',
        freshness: { sha: 'deadbee', branch: 'main', writtenAt: '2026-06-15' }
      });
      assert.equal(written, continuity.indexPath(proj));
      assert.ok(fs.existsSync(written));

      const read = continuity.readIndex(proj);
      assert.equal(read.currentState, 'state A');
      assert.equal(read.nextAction, 'next B');
      assert.equal(read.freshness.sha, 'deadbee');
      assert.equal(read.freshness.branch, 'main');
    });

    it('rewrites (not appends) on a second wrap', () => {
      const proj = path.join(tmpDir, 'p2');
      fs.mkdirSync(proj, { recursive: true });
      continuity.writeIndex(proj, { currentState: 'first', nextAction: 'a' });
      continuity.writeIndex(proj, { currentState: 'second', nextAction: 'b' });
      const raw = fs.readFileSync(continuity.indexPath(proj), 'utf8');
      assert.equal((raw.match(/## Next action/g) || []).length, 1);
      assert.equal(continuity.readIndex(proj).nextAction, 'b');
    });

    it('returns null when no index exists yet', () => {
      const proj = path.join(tmpDir, 'never-wrapped');
      fs.mkdirSync(proj, { recursive: true });
      assert.equal(continuity.readIndex(proj), null);
    });

    it('returns null for a degraded index with no judgment content', () => {
      const proj = path.join(tmpDir, 'p3');
      fs.mkdirSync(proj, { recursive: true });
      // mechanical-floor wrap: only a freshness stamp, no AI capture
      continuity.writeIndex(proj, { freshness: { sha: 'x', branch: 'main', writtenAt: '2026-06-15' } });
      assert.equal(continuity.readIndex(proj), null);
    });

    it('readIndex is non-throwing on a corrupt file', () => {
      const proj = path.join(tmpDir, 'p4');
      fs.mkdirSync(continuity.storeDir(proj), { recursive: true });
      fs.writeFileSync(continuity.indexPath(proj), 'XX not markdown');
      assert.doesNotThrow(() => continuity.readIndex(proj));
      assert.equal(continuity.readIndex(proj), null);
    });
  });
});

describe('continuity warm tier (CC-2)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-continuity-cc2-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('changelog entry', () => {
    it('renders date, session pointer, and one-line in the fixed shape', () => {
      const entry = continuity.renderChangelogEntry({
        date: '2026-06-17', sid: 42, line: 'Shipped CC-2 schemas', tags: 'continuity, schema', refs: '#352'
      });
      assert.equal(entry.split('\n')[0], '- 2026-06-17 (session:42) Shipped CC-2 schemas');
      assert.match(entry, /\n {2}tags: continuity, schema/);
      assert.match(entry, /\n {2}refs: #352/);
    });

    it('omits empty tags/refs lines (honest absence, not empty labels)', () => {
      const entry = continuity.renderChangelogEntry({ date: '2026-06-17', sid: 7, line: 'x' });
      assert.equal(entry, '- 2026-06-17 (session:7) x');
      assert.doesNotMatch(entry, /tags:|refs:/);
    });

    it('honest-flags a missing line rather than fabricating one', () => {
      const entry = continuity.renderChangelogEntry({ date: '2026-06-17', sid: 7 });
      assert.match(entry, /not captured/);
    });

    it('collapses a multi-line summary to a single entry line (grep contract)', () => {
      const entry = continuity.renderChangelogEntry({
        date: '2026-06-17', sid: 8, line: 'Did a thing.\nThen another thing.\n\nAnd more.'
      });
      assert.equal(entry, '- 2026-06-17 (session:8) Did a thing. Then another thing. And more.');
      assert.equal(entry.split('\n').length, 1, 'no spilled lines');
    });

    it('appends append-only: creates a titled file, then accretes', () => {
      const proj = path.join(tmpDir, 'cl1');
      continuity.appendChangelogEntry(proj, { date: '2026-06-15', sid: 1, line: 'first' });
      continuity.appendChangelogEntry(proj, { date: '2026-06-16', sid: 2, line: 'second' });
      const text = fs.readFileSync(continuity.changelogPath(proj), 'utf8');
      assert.match(text, /^# Continuity Changelog/);
      assert.ok(text.indexOf('session:1') < text.indexOf('session:2'), 'most-recent-last accretion');
      assert.match(text, /first/);
      assert.match(text, /second/);
    });
  });

  describe('wrap summary', () => {
    it('renders frontmatter + all 8 fixed sections, honest-flagging the uncaptured', () => {
      const doc = continuity.renderWrapSummary({
        meta: { session: 42, date: '2026-06-17', project: 'tangleclaw', methodology: 'prawduct', harness: 'claude', branch: 'main', sha: 'abc1234' },
        sections: { 'Where we are': 'mid CC-2', 'Next action': 'write tests' }
      });
      assert.match(doc, /^---\nsession: 42\n/);
      for (const s of continuity.WRAP_SECTIONS) assert.match(doc, new RegExp(`## ${s}`));
      assert.match(doc, /## Where we are\nmid CC-2/);
      assert.match(doc, /## Delta\n_⚠ not captured_/);
    });

    it('omits frontmatter keys that are absent (no key: clutter)', () => {
      const doc = continuity.renderWrapSummary({ meta: { session: 9 }, sections: {} });
      assert.match(doc, /session: 9/);
      assert.doesNotMatch(doc, /tags:|methodology:/);
    });

    it('round-trips through parseWrapSummary (meta + captured sections; flagged → empty)', () => {
      const doc = continuity.renderWrapSummary({
        meta: { session: 42, methodology: 'prawduct' },
        sections: { 'Where we are': 'here', 'Landmines': 'branch hygiene' }
      });
      const parsed = continuity.parseWrapSummary(doc);
      assert.equal(parsed.meta.session, '42');
      assert.equal(parsed.meta.methodology, 'prawduct');
      assert.equal(parsed.sections['Where we are'], 'here');
      assert.equal(parsed.sections['Landmines'], 'branch hygiene');
      assert.equal(parsed.sections['Delta'], '', 'flagged-empty parses back to empty');
    });

    it('write + read round-trips a session summary; readWrapSummary is null when absent', () => {
      const proj = path.join(tmpDir, 'ws1');
      assert.equal(continuity.readWrapSummary(proj, 99), null);
      continuity.writeWrapSummary(proj, 99, { meta: { session: 99 }, sections: { 'Next action': 'do X' } });
      const parsed = continuity.readWrapSummary(proj, 99);
      assert.equal(parsed.sections['Next action'], 'do X');
    });
  });

  describe('search (grep over structured markdown)', () => {
    function seed() {
      const proj = path.join(tmpDir, 'srch-' + Math.random().toString(36).slice(2, 8));
      continuity.appendChangelogEntry(proj, { date: '2026-06-15', sid: 3, line: 'Fixed tunnel ECONNREFUSED on reconnect', tags: 'tunnel, econnrefused' });
      continuity.writeWrapSummary(proj, 3, {
        meta: { session: 3 },
        sections: { 'Landmines': 'ECONNREFUSED came from a stale SSH pid', 'Next action': 'verify reconnect' }
      });
      return proj;
    }

    it('finds a changelog hit and surfaces its session pointer', () => {
      const proj = seed();
      const hits = continuity.search(proj, 'ECONNREFUSED');
      const cl = hits.find((h) => h.source === 'changelog');
      assert.ok(cl, 'matched the changelog line');
      assert.equal(cl.sid, '3', 'carries the session:<sid> pointer for drill-down');
    });

    it('finds a wrap-summary hit tagged with sid + section', () => {
      const proj = seed();
      const hits = continuity.search(proj, 'stale SSH pid');
      const ws = hits.find((h) => h.source === 'wrap-summary');
      assert.ok(ws);
      assert.equal(ws.sid, '3');
      assert.equal(ws.section, 'Landmines');
    });

    it('section filter scopes wrap-summary hits to one heading', () => {
      const proj = seed();
      const inLandmines = continuity.search(proj, 'ECONNREFUSED', { section: 'Landmines' });
      assert.ok(inLandmines.every((h) => h.source === 'wrap-summary' && h.section === 'Landmines'),
        'section filter excludes the changelog and other sections');
    });

    it('is case-insensitive, empty on no-match, and empty on an absent store', () => {
      const proj = seed();
      assert.ok(continuity.search(proj, 'econnrefused').length > 0, 'case-insensitive');
      assert.deepEqual(continuity.search(proj, 'no-such-token-xyz'), []);
      assert.deepEqual(continuity.search(path.join(tmpDir, 'nonexistent'), 'anything'), []);
      assert.deepEqual(continuity.search(proj, ''), [], 'empty query returns nothing');
    });
  });
});

describe('continuity Map (CC-3)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-continuity-cc3-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('index schema — Map section', () => {
    it('renders a ## Map section with the empty placeholder when no entries', () => {
      const md = continuity.renderIndex({ currentState: 'x' });
      assert.match(md, /## Map\n_no entries yet_/);
      // Map sits between Next action and Freshness
      assert.ok(md.indexOf('## Next action') < md.indexOf('## Map'));
      assert.ok(md.indexOf('## Map') < md.indexOf('## Freshness'));
    });

    it('round-trips a curated Map body verbatim through render/parse', () => {
      const mapBody = '- **Upload handling** — any-type uploads. `lib/uploads.js`\n- **TBD** — `server.js` <!-- describe -->';
      const md = continuity.renderIndex({ currentState: 'x', map: mapBody });
      const parsed = continuity.parseIndex(md);
      assert.equal(parsed.map, mapBody);
    });

    it('parses the empty placeholder back to an empty Map', () => {
      const parsed = continuity.parseIndex(continuity.renderIndex({ currentState: 'x' }));
      assert.equal(parsed.map, '');
    });
  });

  describe('updateMap', () => {
    it('stubs a touched file not yet in the Map', () => {
      const next = continuity.updateMap('', { touched: ['lib/foo.js'] });
      assert.equal(next, '- **TBD** — `lib/foo.js` <!-- describe -->');
    });

    it('does not re-stub a file already referenced (idempotent)', () => {
      const existing = '- **Foo** — does foo. `lib/foo.js:42`';
      const next = continuity.updateMap(existing, { touched: ['lib/foo.js'] });
      assert.equal(next, existing, 'already-referenced file produces no new stub');
    });

    it('prunes an entry when every referenced path is deleted', () => {
      const existing = '- **TBD** — `lib/gone.js` <!-- describe -->\n- **Keep** — `lib/stay.js`';
      const next = continuity.updateMap(existing, { deleted: ['lib/gone.js'] });
      assert.doesNotMatch(next, /gone\.js/);
      assert.match(next, /stay\.js/);
    });

    it('keeps a multi-file curated entry when only one of its files is deleted', () => {
      const existing = '- **Wrap** — the wrap. `lib/sessions.js`, `lib/wrap-pipeline.js`';
      const next = continuity.updateMap(existing, { deleted: ['lib/wrap-pipeline.js'] });
      assert.match(next, /sessions\.js/, 'entry survives — a referenced file remains');
    });

    it('never prunes a pure-prose entry (no path tokens)', () => {
      const existing = '- A note with no file references';
      const next = continuity.updateMap(existing, { deleted: ['lib/foo.js'] });
      assert.match(next, /A note with no file references/);
    });

    it('combines prune + stub in one pass', () => {
      const existing = '- **Old** — `lib/old.js`\n- **Foo** — `lib/foo.js`';
      const next = continuity.updateMap(existing, { touched: ['lib/new.js'], deleted: ['lib/old.js'] });
      assert.doesNotMatch(next, /old\.js/);
      assert.match(next, /foo\.js/);
      assert.match(next, /- \*\*TBD\*\* — `lib\/new\.js`/);
    });

    it('is a no-op on an empty Map with no delta', () => {
      assert.equal(continuity.updateMap('', {}), '');
    });
  });

  describe('readIndexRaw', () => {
    it('returns the Map even for a degraded index with no judgment content', () => {
      const proj = path.join(tmpDir, 'raw1');
      // Only a Map + freshness, no currentState/nextAction — readIndex would null this out.
      continuity.writeIndex(proj, { map: '- **Foo** — `lib/foo.js`', freshness: { sha: 'x', branch: 'main', writtenAt: '2026-06-17' } });
      assert.equal(continuity.readIndex(proj), null, 'readIndex nulls a no-judgment index');
      const raw = continuity.readIndexRaw(proj);
      assert.ok(raw, 'readIndexRaw still returns it');
      assert.match(raw.map, /foo\.js/);
    });

    it('returns null when the index file is absent', () => {
      assert.equal(continuity.readIndexRaw(path.join(tmpDir, 'never')), null);
    });
  });
});

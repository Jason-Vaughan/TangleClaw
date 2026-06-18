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

  describe('wrap-section selection (CC-6, #381)', () => {
    it('effectiveWrapSections returns all 8 for null/undefined (deep default)', () => {
      assert.deepEqual(continuity.effectiveWrapSections(null), continuity.WRAP_SECTIONS);
      assert.deepEqual(continuity.effectiveWrapSections(undefined), continuity.WRAP_SECTIONS);
    });

    it('effectiveWrapSections renders only chosen sections, in canonical order', () => {
      const chosen = continuity.effectiveWrapSections(['Freshness', 'Where we are']);
      assert.deepEqual(chosen, ['Where we are', 'Next action', 'Freshness']);
    });

    it('effectiveWrapSections always forces Next action even when unchecked', () => {
      const chosen = continuity.effectiveWrapSections(['Delta']);
      assert.ok(chosen.includes('Next action'), 'Next action is the keystone — never droppable');
      assert.deepEqual(chosen, ['Next action', 'Delta']);
    });

    it('effectiveWrapSections ignores unknown section names', () => {
      assert.deepEqual(continuity.effectiveWrapSections(['Bogus', 'Decisions']), ['Next action', 'Decisions']);
    });

    it('renderWrapSummary honors enabledSections — disabled sections are omitted entirely', () => {
      const doc = continuity.renderWrapSummary({
        enabledSections: ['Where we are'],
        meta: { session: 7 },
        sections: { 'Where we are': 'here', 'Next action': 'go' }
      });
      assert.match(doc, /## Where we are/);
      assert.match(doc, /## Next action/); // forced
      assert.doesNotMatch(doc, /## Delta/);
      assert.doesNotMatch(doc, /## Landmines/);
    });

    it('renderWrapSummary with null enabledSections still renders all 8 (no regression)', () => {
      const doc = continuity.renderWrapSummary({ meta: { session: 7 }, sections: {} });
      for (const s of continuity.WRAP_SECTIONS) assert.match(doc, new RegExp(`## ${s}`));
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

describe('continuity operator search (CC-5)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-continuity-cc5-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Seed a project with two fully-indexed sessions (42 newer, 41 older) plus a
  // cold-tier transcript for 42. Returns the project path.
  function seed() {
    const proj = path.join(tmpDir, 'p-' + Math.random().toString(36).slice(2, 8));
    continuity.appendChangelogEntry(proj, {
      date: '2026-06-17', sid: 42, line: 'auth redirect fix', tags: 'auth, redirect', refs: '#344', type: 'fix', files: ['lib/auth.js', 'server.js']
    });
    continuity.appendChangelogEntry(proj, {
      date: '2026-06-10', sid: 41, line: 'added widget', tags: 'widget', type: 'feat', files: ['lib/widget.js']
    });
    continuity.writeWrapSummary(proj, 42, {
      meta: { session: 42, date: '2026-06-17', tags: 'auth, redirect', type: 'fix', files: ['lib/auth.js', 'server.js'] },
      sections: { 'Where we are': 'fixed the auth redirect bug', 'Next action': 'ship it' }
    });
    continuity.writeWrapSummary(proj, 41, {
      meta: { session: 41, date: '2026-06-10', tags: 'widget', type: 'feat', files: ['lib/widget.js'] },
      sections: { 'Where we are': 'built a widget' }
    });
    const sd = continuity.sessionDir(proj, 42);
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'transcript.jsonl'),
      JSON.stringify({ type: 'user', timestamp: '2026-06-17T10:00:00Z', message: { role: 'user', content: 'the auth redirect keeps looping' } }) + '\n' +
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-17T10:01:00Z', message: { role: 'assistant', content: [
        { type: 'text', text: 'I see the redirect bug in lib/auth.js' },
        { type: 'thinking', thinking: 'the loop is in the guard clause' },
        { type: 'tool_use', name: 'Edit', input: { file: 'lib/auth.js' } }
      ] } }) + '\n' +
      JSON.stringify({ type: 'user', timestamp: '2026-06-17T10:02:00Z', message: { role: 'user', content: [
        { type: 'tool_result', content: [{ type: 'text', text: 'patched the redirect guard' }] }
      ] } }) + '\n' +
      JSON.stringify({ type: 'system', timestamp: '2026-06-17T10:03:00Z', content: 'system note: redirect resolved' }) + '\n' +
      JSON.stringify({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} }) + '\n');
    fs.writeFileSync(path.join(sd, 'transcript.meta.json'),
      JSON.stringify({ harness: 'claude', secretsFlagged: false, secretTypes: [], bytes: 400, capturedAt: '2026-06-17T10:05:00Z' }));
    return proj;
  }

  describe('schema round-trip (files: / type:)', () => {
    it('renders [type] on the changelog line and a files: list line', () => {
      const entry = continuity.renderChangelogEntry({
        date: '2026-06-17', sid: 5, line: 'did a thing', type: 'fix', files: ['lib/a.js', 'lib/b.js']
      });
      assert.equal(entry.split('\n')[0], '- 2026-06-17 (session:5) [fix] did a thing');
      assert.match(entry, /\n {2}files: lib\/a\.js, lib\/b\.js/);
    });

    it('accepts files as a comma-string or an array, normalizing both', () => {
      const fromArr = continuity.renderChangelogEntry({ date: 'd', sid: 1, line: 'x', files: ['a.js', 'b.js'] });
      const fromStr = continuity.renderChangelogEntry({ date: 'd', sid: 1, line: 'x', files: 'a.js, b.js' });
      assert.match(fromArr, /files: a\.js, b\.js/);
      assert.equal(fromArr, fromStr);
    });

    it('round-trips type + files through render/parseWrapSummary', () => {
      const doc = continuity.renderWrapSummary({
        meta: { session: 9, type: 'feat', files: ['lib/x.js', 'lib/y.js'] }, sections: {}
      });
      const parsed = continuity.parseWrapSummary(doc);
      assert.equal(parsed.meta.type, 'feat');
      assert.equal(parsed.meta.files, 'lib/x.js, lib/y.js');
    });
  });

  describe('listSessions', () => {
    it('merges changelog + wrap + transcript meta, newest first', () => {
      const proj = seed();
      const sessions = continuity.listSessions(proj);
      assert.deepEqual(sessions.map((s) => s.sid), ['42', '41'], 'recency-sorted, newest first');
      const s42 = sessions[0];
      assert.equal(s42.type, 'fix');
      assert.deepEqual(s42.tags.sort(), ['auth', 'redirect']);
      assert.deepEqual(s42.refs, ['#344']);
      assert.deepEqual(s42.files.sort(), ['lib/auth.js', 'server.js']);
      assert.equal(s42.hasTranscript, true);
      assert.equal(s41Has(sessions), false);
    });

    function s41Has(sessions) { return sessions.find((s) => s.sid === '41').hasTranscript; }

    it('surfaces a transcript-only session that has no wrap or changelog', () => {
      const proj = path.join(tmpDir, 'tonly-' + Math.random().toString(36).slice(2, 6));
      const sd = continuity.sessionDir(proj, 77);
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(sd, 'transcript.jsonl'), '{}\n');
      fs.writeFileSync(path.join(sd, 'transcript.meta.json'), JSON.stringify({ harness: 'claude', secretsFlagged: true, secretTypes: ['aws-key'], bytes: 9 }));
      const rec = continuity.listSessions(proj).find((s) => s.sid === '77');
      assert.ok(rec, 'transcript-only session surfaces');
      assert.equal(rec.secretsFlagged, true);
      assert.deepEqual(rec.secretTypes, ['aws-key']);
    });

    it('returns [] for a project with no store', () => {
      assert.deepEqual(continuity.listSessions(path.join(tmpDir, 'empty')), []);
    });
  });

  describe('searchSessions', () => {
    it('groups query hits by session and ranks recency-primary', () => {
      const proj = seed();
      const { sessions, meta } = continuity.searchSessions(proj, 'auth');
      assert.deepEqual(sessions.map((s) => s.sid), ['42']);
      assert.ok(sessions[0].matchCount >= 1);
      assert.equal(meta.matched, 1);
    });

    it('applies each of the five filters', () => {
      const proj = seed();
      const sids = (q, opts) => continuity.searchSessions(proj, q, opts).sessions.map((s) => s.sid);
      assert.deepEqual(sids('', { type: 'feat' }), ['41'], 'type');
      assert.deepEqual(sids('', { file: 'auth' }), ['42'], 'file-touched substring');
      assert.deepEqual(sids('', { tags: 'auth,redirect' }), ['42'], 'tags AND');
      assert.deepEqual(sids('', { tags: 'auth,nope' }), [], 'tags AND excludes when not all present');
      assert.deepEqual(sids('', { refs: '344' }), ['42'], 'refs (# optional)');
      assert.deepEqual(sids('', { dateFrom: '2026-06-15' }), ['42'], 'date lower bound');
      assert.deepEqual(sids('', { dateTo: '2026-06-12' }), ['41'], 'date upper bound');
    });

    it('combines a query with a filter (AND)', () => {
      const proj = seed();
      assert.deepEqual(continuity.searchSessions(proj, 'auth', { type: 'fix' }).sessions.map((s) => s.sid), ['42']);
      assert.deepEqual(continuity.searchSessions(proj, 'auth', { type: 'feat' }).sessions.map((s) => s.sid), [], 'filter excludes the query hit');
    });

    it('browse mode (empty query, no filters) returns all sessions', () => {
      const proj = seed();
      assert.deepEqual(continuity.searchSessions(proj, '').sessions.map((s) => s.sid), ['42', '41']);
    });

    it('reports unindexed counts for type/file (forward-only gap)', () => {
      const proj = path.join(tmpDir, 'old-' + Math.random().toString(36).slice(2, 6));
      // An "old" session with neither type nor files (pre-CC-5 shape).
      continuity.appendChangelogEntry(proj, { date: '2026-05-01', sid: 1, line: 'legacy' });
      const { meta } = continuity.searchSessions(proj, '');
      assert.equal(meta.unindexed.type, 1);
      assert.equal(meta.unindexed.file, 1);
    });

    it('respects limit', () => {
      const proj = seed();
      const { sessions, meta } = continuity.searchSessions(proj, '', { limit: 1 });
      assert.equal(sessions.length, 1);
      assert.equal(meta.matched, 2, 'matched is the full count; returned is capped');
      assert.equal(meta.returned, 1);
    });
  });

  describe('searchTranscript (cold drill-down)', () => {
    it('finds matches across user, assistant, and tool_result text with role + lineNo', async () => {
      const proj = seed();
      const r = await continuity.searchTranscript(proj, 42, 'redirect');
      assert.equal(r.available, true);
      const roles = r.excerpts.map((e) => e.role);
      assert.ok(roles.includes('user'));
      assert.ok(roles.includes('assistant'));
      assert.ok(r.excerpts.every((e) => typeof e.lineNo === 'number' && e.snippet));
    });

    it('searches assistant thinking and tool_use blocks too', async () => {
      const proj = seed();
      assert.ok((await continuity.searchTranscript(proj, 42, 'guard clause')).excerpts.length >= 1, 'thinking');
      assert.ok((await continuity.searchTranscript(proj, 42, 'Edit')).excerpts.length >= 1, 'tool_use name');
    });

    it('passes the transcript secret flag through from the meta envelope', async () => {
      const proj = path.join(tmpDir, 'sec-' + Math.random().toString(36).slice(2, 6));
      const sd = continuity.sessionDir(proj, 8);
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(sd, 'transcript.jsonl'), JSON.stringify({ type: 'system', content: 'token here' }) + '\n');
      fs.writeFileSync(path.join(sd, 'transcript.meta.json'), JSON.stringify({ harness: 'claude', secretsFlagged: true, secretTypes: ['github-pat'] }));
      const r = await continuity.searchTranscript(proj, 8, 'token');
      assert.equal(r.secretsFlagged, true);
      assert.deepEqual(r.secretTypes, ['github-pat']);
    });

    it('is an honest stub for a non-Claude harness (only the Claude payload is stored)', async () => {
      const proj = path.join(tmpDir, 'gem-' + Math.random().toString(36).slice(2, 6));
      const sd = continuity.sessionDir(proj, 3);
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(sd, 'transcript.meta.json'), JSON.stringify({ harness: 'gemini', secretsFlagged: false }));
      const r = await continuity.searchTranscript(proj, 3, 'anything');
      assert.equal(r.available, false);
      assert.match(r.reason, /gemini/);
    });

    it('reports no transcript captured when the file is absent', async () => {
      const proj = seed();
      const r = await continuity.searchTranscript(proj, 41, 'anything');
      assert.equal(r.available, false);
      assert.match(r.reason, /no transcript/);
    });

    it('an empty query is an availability probe (no excerpts, no throw)', async () => {
      const proj = seed();
      const r = await continuity.searchTranscript(proj, 42, '');
      assert.equal(r.available, true);
      assert.deepEqual(r.excerpts, []);
    });

    it('caps excerpts and flags truncation', async () => {
      const proj = path.join(tmpDir, 'cap-' + Math.random().toString(36).slice(2, 6));
      const sd = continuity.sessionDir(proj, 9);
      fs.mkdirSync(sd, { recursive: true });
      const lines = [];
      for (let i = 0; i < 5; i++) lines.push(JSON.stringify({ type: 'system', content: 'needle line' }));
      fs.writeFileSync(path.join(sd, 'transcript.jsonl'), lines.join('\n') + '\n');
      fs.writeFileSync(path.join(sd, 'transcript.meta.json'), JSON.stringify({ harness: 'claude' }));
      const r = await continuity.searchTranscript(proj, 9, 'needle', { cap: 2 });
      assert.equal(r.excerpts.length, 2);
      assert.equal(r.truncated, true);
    });
  });

  describe('searchProjectTranscripts (project-wide cold search)', () => {
    // Seed two sessions that BOTH have transcripts so we can prove it searches
    // across all of them, not just one.
    function seedMulti() {
      const proj = path.join(tmpDir, 'multi-' + Math.random().toString(36).slice(2, 6));
      for (const [sid, date, text] of [[1, '2026-06-10', 'the deploy failed with ECONNREFUSED'], [2, '2026-06-17', 'fixed the ECONNREFUSED by clearing the stale pid']]) {
        continuity.appendChangelogEntry(proj, { date, sid, line: 'work', type: 'fix' });
        continuity.writeWrapSummary(proj, sid, { meta: { session: sid, date, type: 'fix' }, sections: { 'Where we are': 'x' } });
        const sd = continuity.sessionDir(proj, sid);
        fs.mkdirSync(sd, { recursive: true });
        fs.writeFileSync(path.join(sd, 'transcript.jsonl'),
          JSON.stringify({ type: 'assistant', timestamp: `${date}T10:00:00Z`, message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n');
        fs.writeFileSync(path.join(sd, 'transcript.meta.json'), JSON.stringify({ harness: 'claude' }));
      }
      return proj;
    }

    it('finds a term across EVERY session transcript in the project', async () => {
      const proj = seedMulti();
      const r = await continuity.searchProjectTranscripts(proj, 'econnrefused');
      assert.deepEqual(r.sessions.map((s) => s.sid).sort(), ['1', '2'], 'both transcripts matched');
      assert.equal(r.meta.matched, 2);
      assert.equal(r.meta.withTranscript, 2);
      assert.ok(r.sessions[0].hits[0].source === 'transcript');
    });

    it('ranks recency-first and shapes excerpts as hits', async () => {
      const proj = seedMulti();
      const r = await continuity.searchProjectTranscripts(proj, 'econnrefused');
      assert.equal(r.sessions[0].sid, '2', 'newest session first');
      assert.ok(r.sessions[0].hits.length >= 1);
    });

    it('honors the session filters (e.g. date range narrows which transcripts are searched)', async () => {
      const proj = seedMulti();
      const r = await continuity.searchProjectTranscripts(proj, 'econnrefused', { dateFrom: '2026-06-15' });
      assert.deepEqual(r.sessions.map((s) => s.sid), ['2']);
    });

    it('skips sessions with no captured transcript', async () => {
      const proj = seedMulti();
      // Add a transcript-less session — it must not appear in transcript results.
      continuity.appendChangelogEntry(proj, { date: '2026-06-18', sid: 3, line: 'no transcript here' });
      const r = await continuity.searchProjectTranscripts(proj, 'econnrefused');
      assert.ok(!r.sessions.some((s) => s.sid === '3'));
    });

    it('empty query returns no excerpts (transcript mode needs a term)', async () => {
      const proj = seedMulti();
      const r = await continuity.searchProjectTranscripts(proj, '');
      assert.deepEqual(r.sessions, []);
    });

    it('returns empty (not throw) for a project with no store', async () => {
      const r = await continuity.searchProjectTranscripts(path.join(tmpDir, 'nostore'), 'x');
      assert.deepEqual(r.sessions, []);
      assert.equal(r.meta.scanned, 0);
    });
  });
});

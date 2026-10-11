'use strict';

/**
 * #1796 — this repository's tracked `CLAUDE.md` holds, between its tangleclaw
 * markers, exactly what TangleClaw writes there.
 *
 * The block is generated: a launch of any session in a checkout splices it.
 * When the generator's output moved and the tracked file did not, every
 * checkout carried an uncommitted `CLAUDE.md` and nothing said so. The verb
 * list is the usual mover: a new `tc` verb reaches the block by existing in
 * `lib/tc-verbs.js#VERB_ROSTER`.
 *
 * So the expected bytes come from the production renderer and the production
 * splice, never from a list kept here, and this file only reads: syncing is
 * `scripts/sync-claude-md-block.js --write`, a person's deliberate act.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../lib/store');
const engines = require('../lib/engines');
const managedBlock = require('../lib/managed-block');
const tcVerbs = require('../lib/tc-verbs');
const sync = require('../scripts/sync-claude-md-block');

const REPO_DIR = path.resolve(__dirname, '..');
const TRACKED_PATH = path.join(REPO_DIR, sync.CARRIER);
const SCRIPT_PATH = path.join(REPO_DIR, 'scripts', 'sync-claude-md-block.js');
const MARKERS = engines.managedBlockMarkers('markdown');

/**
 * Count non-overlapping occurrences of a literal.
 * @param {string} text
 * @param {string} needle
 * @returns {number}
 */
function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

/**
 * Run the script as a person would, on a named copy of the carrier.
 * @param {string[]} args
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function runScript(args) {
  const r = spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('#1796 — the tracked CLAUDE.md block is what the generator writes', () => {
  let tracked;
  let trackedStat;
  let scratchStore;
  let scratchDir;

  before(() => {
    tracked = fs.readFileSync(TRACKED_PATH, 'utf8');
    trackedStat = fs.statSync(TRACKED_PATH);
    // A scratch store, so nothing this host has configured or registered is
    // read, and the one case below that renders with a project path has a
    // database to ask.
    scratchStore = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1796-store-'));
    store._setBasePath(scratchStore);
    store.init();
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1796-copies-'));
  });

  after(() => {
    store.close();
    fs.rmSync(scratchStore, { recursive: true, force: true });
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('holds exactly one begin marker and one end marker, in that order', () => {
    assert.equal(occurrences(tracked, MARKERS.begin), 1, `expected one ${MARKERS.begin}`);
    assert.equal(occurrences(tracked, MARKERS.end), 1, `expected one ${MARKERS.end}`);
    assert.ok(tracked.indexOf(MARKERS.begin) < tracked.indexOf(MARKERS.end), 'the begin marker must come first');
  });

  it('the block between the markers equals the generated block', () => {
    const result = sync.compareCarrier(tracked);
    // The splice trims the body's trailing whitespace and puts each marker on
    // its own line, so the two are compared the way the splice leaves them.
    const generated = managedBlock.extractManagedBlock(result.merged, MARKERS);
    assert.equal(managedBlock.extractManagedBlock(tracked, MARKERS), generated, result.message);
  });

  it('a launch would leave the tracked file byte-identical', () => {
    const result = sync.compareCarrier(tracked);
    assert.equal(result.merged, tracked, result.message);
    assert.equal(result.inSync, true, result.message);
  });

  it('git classifies the file as committed, and the rendering with this checkout as the project is the same', () => {
    assert.equal(engines._carrierIsCommitted(REPO_DIR, sync.CARRIER), true);
    assert.equal(
      engines._generateOperationalBlock(sync.PINNED_PROFILE, REPO_DIR, sync.CARRIER),
      sync.renderExpectedBlock()
    );
  });

  it('carries no origin of any install', () => {
    const block = managedBlock.extractManagedBlock(tracked, MARKERS);
    assert.doesNotMatch(block, /https?:\/\/(localhost|127\.0\.0\.1):\d+/);
  });

  it('the rendering does not move with the host store: a token gate that is on there adds nothing', () => {
    const baseline = sync.renderExpectedBlock();
    const config = store.config.load();
    store.config.save({ ...config, serviceTokenEnabled: true, serviceToken: 'tok-that-must-not-appear' });
    try {
      const gated = sync.renderExpectedBlock();
      assert.equal(gated, baseline);
      assert.ok(!gated.includes('tok-that-must-not-appear'));
      assert.equal(store._getBasePath(), scratchStore, 'the store is handed back where it was');
    } finally {
      store.config.save(config);
    }
  });

  it('every verb a pane is primed with reaches the block, read from the roster', () => {
    const block = managedBlock.extractManagedBlock(tracked, MARKERS);
    const verbs = tcVerbs.verbsFor('pane').map((v) => v.id);
    assert.ok(verbs.length > 0, 'the roster yielded no pane verbs');
    for (const id of verbs) {
      assert.ok(block.includes(`\`${id}\``), `tc ${id} is in the roster and not in the tracked block`);
    }
  });

  it('a verb added to the roster with no change to CLAUDE.md fails the comparison, and the message says what to run', () => {
    const added = { id: 'zz-drift-probe', usage: 'tc zz-drift-probe', summary: 'not a real verb', run: async () => ({ code: 0 }) };
    tcVerbs.VERB_ROSTER.push(added);
    let result;
    try {
      result = sync.compareCarrier(tracked);
    } finally {
      tcVerbs.VERB_ROSTER.splice(tcVerbs.VERB_ROSTER.indexOf(added), 1);
    }
    assert.equal(result.inSync, false);
    assert.notEqual(result.merged, tracked);
    assert.ok(result.message.includes(sync.SYNC_COMMAND), result.message);
    assert.match(result.message, /zz-drift-probe/, 'the message shows where the blocks part');
    assert.equal(sync.compareCarrier(tracked).inSync, true, 'the roster is as it was');
  });

  it('a changed expected block fails the same comparison', () => {
    const body = sync.renderExpectedBlock().replace('`whoami`', '`whoami`, `one-more`');
    assert.notEqual(body, sync.renderExpectedBlock());
    const result = sync.compareCarrier(tracked, body);
    assert.equal(result.inSync, false);
    assert.ok(result.message.includes(sync.SYNC_COMMAND));
  });

  it('a file without one well-formed marker pair is refused, not appended to', () => {
    for (const broken of [
      'no markers at all\n',
      tracked.replace(MARKERS.end, ''),
      `${tracked}\n${MARKERS.begin}\n`,
      tracked.replace(MARKERS.begin, '\u0000').replace(MARKERS.end, MARKERS.begin).replace('\u0000', MARKERS.end)
    ]) {
      const result = sync.compareCarrier(broken);
      assert.equal(result.inSync, false);
      assert.equal(result.merged, null);
      assert.match(result.message, /exactly one/);
    }
  });

  describe('the script', () => {
    /**
     * A copy of the tracked file whose block has drifted, plus text outside it.
     * @param {string} name
     * @returns {{file: string, text: string}}
     */
    function driftedCopy(name) {
      const file = path.join(scratchDir, name);
      const text = tracked.replace('`whoami`', '`whoami-as-it-was`');
      assert.notEqual(text, tracked, 'the fixture must differ from the tracked file');
      fs.writeFileSync(file, text);
      return { file, text };
    }

    it('exits 0 on a matching file and writes nothing', () => {
      const file = path.join(scratchDir, 'matching.md');
      fs.writeFileSync(file, tracked);
      const r = runScript(['--file', file]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.readFileSync(file, 'utf8'), tracked);
    });

    it('exits 1 on a drifted copy, names the sync command, and writes nothing', () => {
      const { file, text } = driftedCopy('drifted-check.md');
      const r = runScript(['--file', file]);
      assert.equal(r.status, 1);
      assert.ok(r.stderr.includes(sync.SYNC_COMMAND), r.stderr);
      assert.equal(fs.readFileSync(file, 'utf8'), text);
      assert.deepEqual(fs.readdirSync(scratchDir).filter((f) => f.endsWith('.tmp')), []);
    });

    it('with --write changes only the marked block, and a second run finds nothing to do', () => {
      const { file, text } = driftedCopy('drifted-write.md');
      const r = runScript(['--write', '--file', file]);
      assert.equal(r.status, 0, r.stderr);
      const written = fs.readFileSync(file, 'utf8');
      assert.equal(written, tracked);
      assert.equal(managedBlock.outsideManagedBlock(written, MARKERS), managedBlock.outsideManagedBlock(text, MARKERS));
      assert.deepEqual(fs.readdirSync(scratchDir).filter((f) => f.endsWith('.tmp')), []);
      assert.equal(runScript(['--file', file]).status, 0);
    });

    it('with --write refuses a file whose markers are broken and leaves it as it was', () => {
      const file = path.join(scratchDir, 'broken.md');
      const text = tracked.replace(MARKERS.end, '');
      fs.writeFileSync(file, text);
      const r = runScript(['--write', '--file', file]);
      assert.equal(r.status, 1);
      assert.equal(fs.readFileSync(file, 'utf8'), text);
    });

    it('exits 2 on an argument it does not know, and 1 on a file it cannot read', () => {
      assert.equal(runScript(['--apply']).status, 2);
      assert.equal(runScript(['--file']).status, 2);
      assert.equal(runScript(['--file', path.join(scratchDir, 'absent.md')]).status, 1);
    });
  });

  it('leaves the tracked file untouched: same bytes, same modification time', () => {
    const now = fs.statSync(TRACKED_PATH);
    assert.equal(fs.readFileSync(TRACKED_PATH, 'utf8'), tracked);
    assert.equal(now.mtimeMs, trackedStat.mtimeMs);
    assert.equal(now.size, trackedStat.size);
  });
});

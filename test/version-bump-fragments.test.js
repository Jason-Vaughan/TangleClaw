'use strict';

/*
 * `version-bump` compiles changelog fragments into the release (#1220 C03).
 *
 * Every fragment under `changelog.d/` is spliced into `[Unreleased]` in memory
 * before the bump level is decided, so the level, the readiness gate and the
 * promotion read one text, and each consumed fragment is staged for deletion
 * beside the promoted CHANGELOG. A hold stages nothing. A leftover release-
 * recovery record from a cut that did not land refuses the next cut until it
 * is recovered and removed. Real temporary projects throughout: the fragment
 * read, the recovery check and the CHANGELOG read all go to disk.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const vb = require('../lib/wrap-steps/version-bump');
const commit = require('../lib/wrap-steps/commit');
const store = require('../lib/store');

const EMPTY_UNRELEASED = '# Changelog\n\n## [Unreleased]\n\n## [1.4.2] - 2026-05-01\n\n### Fixed\n- something old\n';
const HAND_WRITTEN = '# Changelog\n\n## [Unreleased]\n\n### Added\n- A feature (#12)\n\n### Fixed\n- a fix (#13)\n\n## [1.4.2] - 2026-05-01\n\n### Fixed\n- something old\n';
const FRAGMENTS = {
  '12.feature.added.md': '- A feature (#12)\n',
  '13.fix.fixed.md': '- a fix (#13)\n'
};

let tmpRoot;
before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-vb-fragments-')); });
after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

/**
 * A versioned project on disk.
 * @param {object} opts
 * @param {string|null} [opts.changelog] - CHANGELOG.md text; null for none
 * @param {Record<string,string>} [opts.fragments] - changelog.d/ files by name
 * @param {string} [opts.version] - version.json version
 * @returns {{name:string, path:string}}
 */
function makeProject({ changelog = EMPTY_UNRELEASED, fragments = null, version = '1.4.2' } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'p-'));
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version }, null, 2) + '\n');
  if (changelog !== null) fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  if (fragments) {
    fs.mkdirSync(path.join(dir, 'changelog.d'));
    for (const [name, body] of Object.entries(fragments)) fs.writeFileSync(path.join(dir, 'changelog.d', name), body);
  }
  return { name: path.basename(dir), path: dir };
}

/**
 * Run the step as the pipeline would.
 * @param {{name:string, path:string}} project
 * @param {object} [options]
 * @returns {Promise<{res:object, staged:object}>}
 */
async function runBump(project, options = {}) {
  const context = { project, step: { id: 'version-bump', kind: 'version-bump' }, staged: {}, options, previousResults: [] };
  const res = await vb.run(context);
  return { res, staged: context.staged };
}

describe('version-bump compiles changelog fragments into the release (#1220)', () => {
  let savedInternal;
  let savedLoad;
  let config;

  beforeEach(() => {
    savedInternal = { ...vb._internal };
    savedLoad = store.projectConfig.load;
    config = { releaseMode: 'auto' };
    store.projectConfig.load = () => config;
    vb._internal.todayIso = () => '2026-10-21';
  });

  afterEach(() => {
    Object.assign(vb._internal, savedInternal);
    store.projectConfig.load = savedLoad;
  });

  it('compile then bump derives the same level, and the same promoted text, as the entries written by hand', async () => {
    const fromFragments = await runBump(makeProject({ fragments: FRAGMENTS }));
    const byHand = await runBump(makeProject({ changelog: HAND_WRITTEN }));

    assert.equal(fromFragments.res.status, 'done', JSON.stringify(fromFragments.res));
    assert.equal(byHand.res.status, 'done');
    assert.equal(fromFragments.res.output.bumpLevel, 'minor');
    assert.equal(fromFragments.res.output.to, byHand.res.output.to);
    assert.equal(fromFragments.staged['version-bump:changelog'].newContent, byHand.staged['version-bump:changelog'].newContent,
      'the promoted CHANGELOG is byte-identical to one whose [Unreleased] carried the same entries');
    assert.deepEqual(fromFragments.res.output.subsections, ['Added', 'Fixed']);
    assert.equal(fromFragments.res.output.decidedBy, 'readiness', 'an empty [Unreleased] with fragments pending is ready');
    assert.match(fromFragments.res.output.readiness.reason, /\[Unreleased\] has entries, 2 of them changelog fragment\(s\)/,
      'the readiness signal reads the spliced text, and says which entries were fragments');
  });

  it('direct [Unreleased] entries and fragments coexist: nothing lost, nothing duplicated', async () => {
    const changelog = '# Changelog\n\n## [Unreleased]\n\n### Added\n- direct (#1)\n\n## [1.4.2] - 2026-05-01\n\n- old\n';
    const { res, staged } = await runBump(makeProject({ changelog, fragments: { '2.x.added.md': '- from a fragment (#2)\n', '3.y.fixed.md': '- fixed by a fragment (#3)\n' } }));

    assert.equal(res.status, 'done');
    const promoted = staged['version-bump:changelog'].newContent;
    const section = promoted.slice(promoted.indexOf('## [1.5.0]'), promoted.indexOf('## [1.4.2]'));
    assert.equal((section.match(/- direct \(#1\)/g) || []).length, 1);
    assert.equal((section.match(/- from a fragment \(#2\)/g) || []).length, 1);
    assert.equal((section.match(/- fixed by a fragment \(#3\)/g) || []).length, 1);
    assert.ok(section.indexOf('- direct (#1)') < section.indexOf('- from a fragment (#2)'), 'the direct entry keeps its place; the fragment is appended');
    assert.ok(section.indexOf('### Added') < section.indexOf('### Fixed'), 'subsections in Keep a Changelog order');
    assert.equal(promoted.slice(promoted.indexOf('## [1.4.2]')), changelog.slice(changelog.indexOf('## [1.4.2]')),
      'released sections are byte-identical before and after compilation');
    assert.equal((promoted.match(/## \[Unreleased\]\n\n## \[1\.5\.0\]/g) || []).length, 1, '[Unreleased] is left empty');
  });

  it('stages the deletion of exactly the consumed fragments, and records what it compiled', async () => {
    const project = makeProject({ fragments: FRAGMENTS });
    const { res, staged } = await runBump(project);

    assert.equal(res.status, 'done');
    assert.deepEqual(Object.keys(staged).sort(), [
      'version-bump:changelog',
      'version-bump:fragment:12.feature.added.md',
      'version-bump:fragment:13.fix.fixed.md',
      'version-bump:version-json'
    ]);
    for (const name of Object.keys(FRAGMENTS)) {
      assert.deepEqual(staged[`version-bump:fragment:${name}`], {
        primingPath: path.join(project.path, 'changelog.d', name),
        newContent: null,
        delete: true,
        changed: true,
        fragment: true
      });
      assert.ok(commit._isDeleteEntry(staged[`version-bump:fragment:${name}`]), 'the shape the commit step unlinks');
    }
    assert.deepEqual(res.output.fragments, { compiled: 2, files: ['12.feature.added.md', '13.fix.fixed.md'] });
    assert.match(res.output.detail, /1\.4\.2 → 1\.5\.0 \(minor, version\.json\), 2 changelog fragment\(s\) compiled/);
    assert.ok(fs.existsSync(path.join(project.path, 'changelog.d', '12.feature.added.md')), 'the step writes nothing: the commit step deletes');
  });

  it('a second run with no fragments and an empty [Unreleased] skips with "no entries"', async () => {
    const project = makeProject({ fragments: FRAGMENTS });
    const first = await runBump(project);
    assert.equal(first.res.status, 'done');
    // What the commit step's flush would leave behind.
    fs.writeFileSync(path.join(project.path, 'CHANGELOG.md'), first.staged['version-bump:changelog'].newContent);
    fs.writeFileSync(path.join(project.path, 'version.json'), first.staged['version-bump:version-json'].newContent);
    for (const name of Object.keys(FRAGMENTS)) fs.rmSync(path.join(project.path, 'changelog.d', name));

    const second = await runBump(project);
    assert.equal(second.res.status, 'skipped');
    assert.match(second.res.output.reason, /\[Unreleased\] has no entries to promote/);
    assert.match(second.res.output.reason, /changelog\.d\/ holds no fragments/);
    assert.deepEqual(second.staged, {});
    assert.equal(fs.readFileSync(path.join(project.path, 'CHANGELOG.md'), 'utf8'), first.staged['version-bump:changelog'].newContent,
      'a second compile with no new fragments is a byte-for-byte no-op');
  });

  it('a hold stages nothing and deletes nothing, and still says what is pending', async () => {
    config = { releaseMode: 'ask' };
    const project = makeProject({ fragments: FRAGMENTS });
    const { res, staged } = await runBump(project);

    assert.equal(res.status, 'needs-operator');
    assert.equal(res.output.held, true);
    assert.deepEqual(res.output.wouldBump, { from: '1.4.2', to: '1.5.0', bumpLevel: 'minor' });
    assert.deepEqual(res.output.fragments, { pending: 2, files: ['12.feature.added.md', '13.fix.fixed.md'] });
    assert.deepEqual(staged, {});
    for (const name of Object.keys(FRAGMENTS)) assert.ok(fs.existsSync(path.join(project.path, 'changelog.d', name)));

    const held = await runBump(project, { release: 'hold' });
    assert.equal(held.res.status, 'skipped');
    assert.deepEqual(held.staged, {});
  });

  it('a pending fragment opens a release an empty [Unreleased] would have held', async () => {
    const without = await runBump(makeProject());
    assert.equal(without.res.status, 'skipped');
    assert.match(without.res.output.reason, /no entries/);
    const withOne = await runBump(makeProject({ fragments: { '5.one.internal.md': '- an internal change (#5)\n' } }));
    assert.equal(withOne.res.status, 'done');
    assert.equal(withOne.res.output.bumpLevel, 'patch', 'an internal fragment is patch-tier, as a hand-written ### Internal entry is');
    assert.equal(withOne.res.output.to, '1.4.3');
  });

  it('a CHANGELOG with no [Unreleased] heading skips, naming the fragments that wait for one', async () => {
    const { res, staged } = await runBump(makeProject({ changelog: '# Changelog\n\n## [1.4.2] - 2026-05-01\n\n- old\n', fragments: FRAGMENTS }));
    assert.equal(res.status, 'skipped');
    assert.match(res.output.reason, /\[Unreleased\] section not found in CHANGELOG\.md, and 2 changelog fragment\(s\) wait under changelog\.d\/.*12\.feature\.added\.md, 13\.fix\.fixed\.md/);
    assert.deepEqual(staged, {});
  });

  it('a BREAKING marker inside a fragment forces a major release, whatever the fragment type', async () => {
    const { res } = await runBump(makeProject({ fragments: { '9.big.fixed.md': '- BREAKING: the config key moved (#9)\n' } }));
    assert.equal(res.status, 'done');
    assert.equal(res.output.bumpLevel, 'major');
    assert.equal(res.output.to, '2.0.0');
  });

  describe('a leftover release-recovery record refuses the cut (#1220, Safeguard 3(d))', () => {
    it('halts with needs-operator naming the manifest, before any version or CHANGELOG file is read', async () => {
      const project = makeProject({ fragments: FRAGMENTS });
      const runDir = path.join(project.path, vb.RELEASE_RECOVERY_REL, 'run-abc');
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'manifest.json'), '{}\n');
      let reads = 0;
      vb._internal.readFileSync = (...args) => { reads += 1; return fs.readFileSync(...args); };

      const { res, staged } = await runBump(project);
      assert.equal(res.ok, false);
      assert.equal(res.status, 'needs-operator');
      assert.match(res.output.reason, /refusing to cut: an earlier release cut did not land/);
      assert.ok(res.output.reason.includes(path.join(runDir, 'manifest.json')), res.output.reason);
      assert.deepEqual(res.output.releaseRecovery, [path.join(runDir, 'manifest.json')]);
      assert.match(res.output.remediation, /Follow the `recover` instructions in that manifest\.json/);
      assert.doesNotMatch(res.output.remediation, /Cut or Hold/);
      assert.equal(res.output.wouldBump, undefined, 'not a release decision');
      assert.deepEqual(staged, {});
      assert.equal(reads, 0, 'refused before version.json or CHANGELOG.md was read');
      for (const name of Object.keys(FRAGMENTS)) assert.ok(fs.existsSync(path.join(project.path, 'changelog.d', name)));
    });

    it('a run directory with no manifest is not a record, and the cut proceeds', async () => {
      const project = makeProject({ fragments: FRAGMENTS });
      fs.mkdirSync(path.join(project.path, vb.RELEASE_RECOVERY_REL, 'run-partial', 'files'), { recursive: true });
      fs.writeFileSync(path.join(project.path, vb.RELEASE_RECOVERY_REL, '.gitignore'), '*\n');
      const { res } = await runBump(project);
      assert.equal(res.status, 'done');
      assert.deepEqual(vb._releaseRecoveryArtifacts(project.path), []);
    });

    it('an unreadable recovery directory is itself a refusal, and a file in its place is nothing pending', async () => {
      const project = makeProject({ fragments: FRAGMENTS });
      vb._internal.readdirSync = (p) => {
        if (p === path.join(project.path, vb.RELEASE_RECOVERY_REL)) { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; }
        return fs.readdirSync(p);
      };
      const found = vb._releaseRecoveryArtifacts(project.path);
      assert.equal(found.length, 1);
      assert.match(found[0].unreadable, /permission denied/, 'reported as unreadable, not as absent');
      const { res, staged } = await runBump(project);
      assert.equal(res.status, 'needs-operator');
      assert.match(res.output.reason, /unreadable: permission denied/);
      assert.deepEqual(staged, {});

      // A plain file where the directory should be holds no record beneath it.
      vb._internal.readdirSync = savedInternal.readdirSync;
      const other = makeProject({ fragments: FRAGMENTS });
      fs.mkdirSync(path.join(other.path, '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(other.path, vb.RELEASE_RECOVERY_REL), 'a file where the directory should be\n');
      assert.deepEqual(vb._releaseRecoveryArtifacts(other.path), []);
    });

    it('the recovery directory is spelled once: the commit step writes where this step looks', () => {
      assert.equal(vb.RELEASE_RECOVERY_REL, path.join('.tangleclaw', 'release-recovery'));
      const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wrap-steps', 'commit.js'), 'utf8');
      assert.match(source, /const \{ RELEASE_RECOVERY_REL \} = require\('\.\/version-bump'\);/,
        'commit.js takes the constant from version-bump rather than spelling the path again');
      assert.doesNotMatch(source, /'release-recovery'/, 'no second spelling in commit.js');
    });
  });
});

'use strict';

/*
 * #2042 — how git merges `.prawduct/change-log.md`.
 *
 * The file was marked `merge=union`. Git's union driver never reports a
 * conflict: where two sides edit the same region it keeps both sides' lines,
 * hunk after hunk. A two-sided edit to one entry then survives as two copies
 * of that entry, one of them a heading with no body, and the merge exits 0 —
 * the corruption #2042 records (a stray heading, a mis-attributed entry) and
 * that only a later review noticed.
 *
 * These tests drive real `git merge` in throwaway repositories. Each one
 * copies the repository's own committed `.gitattributes` (or, for the control,
 * an explicit union line), so what is tested is the shipped config. Git runs
 * with no system or global config, so nothing on the machine running the
 * suite — a `core.attributesFile`, a merge setting — can change the result.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const { initRepo } = require('./_temp-repo');

const REPO_ROOT = path.join(__dirname, '..');
const LOG = '.prawduct/change-log.md';

let sandbox;
let emptyGlobalConfig;

/**
 * The environment every git child runs under: the host's environment minus
 * any `GIT_*` variable (a hook's `GIT_DIR` would redirect the child), plus no
 * system config, an empty global config and a fixed identity.
 * @returns {object} Environment for the git child
 */
function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t'
  };
}

/**
 * Run git and return its exit status and output; never throws on a non-zero
 * exit, because a refused merge is the outcome several tests expect.
 * @param {string} cwd
 * @param {...string} args
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function git(cwd, ...args) {
  const r = childProcess.spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Run git and throw unless it exits 0.
 * @param {string} cwd
 * @param {...string} args
 * @returns {string} stdout
 */
function gitOk(cwd, ...args) {
  const r = git(cwd, ...args);
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * The repository's own change-log header: everything above the first entry
 * heading, so a fixture carries the same top comment a person sees when the
 * file conflicts.
 * @returns {string}
 */
function realHeader() {
  const text = fs.readFileSync(path.join(REPO_ROOT, LOG), 'utf8');
  const at = text.search(/^## /m);
  assert.ok(at > 0, 'the repository change log has a header above its first entry');
  return text.slice(0, at);
}

/**
 * One change-log entry in the file's shape: heading, tag line, body.
 * @param {string} date - YYYY-MM-DD
 * @param {number} issue
 * @param {string} title
 * @param {string} [tagExtra=''] - Appended inside the tag line, e.g. ` | status=shipped`
 * @param {string} [body]
 * @returns {string}
 */
function entry(date, issue, title, tagExtra = '', body = `Body for #${issue}.`) {
  return `## ${date} — #${issue}: ${title}\n\n<!-- prawduct: type=bugfix | scope=s${issue}${tagExtra} -->\n\n${body}\n\n`;
}

/**
 * Read a change log's entries and report every way its structure is wrong:
 * leftover conflict markers, an issue under two headings, an entry without
 * exactly one tag line, an entry with no body. An empty list is a sound log.
 * @param {string} text
 * @returns {{entries: Array<{date: string, issue: string}>, problems: string[]}}
 */
function checkStructure(text) {
  const problems = [];
  if (/^(<{7}|={7}|>{7})( |$)/m.test(text)) problems.push('conflict markers present');
  const entries = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^## (\d{4}-\d{2}-\d{2}) — (#\d+):/);
    if (h) {
      cur = { date: h[1], issue: h[2], tags: 0, body: 0 };
      entries.push(cur);
    } else if (cur && line.startsWith('<!-- prawduct:')) {
      cur.tags++;
    } else if (cur && line.trim() !== '') {
      cur.body++;
    }
  }
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.issue)) problems.push(`${e.issue} appears under more than one heading`);
    seen.add(e.issue);
    if (e.tags !== 1) problems.push(`${e.issue} has ${e.tags} tag lines`);
    if (e.body === 0) problems.push(`${e.issue} has no body`);
  }
  return { entries: entries.map(({ date, issue }) => ({ date, issue })), problems };
}

/**
 * Make a repository whose base commit holds `.gitattributes` and a change log,
 * then two branches each changing the log; check out `ours`.
 * @param {string} name - Directory name under the sandbox
 * @param {string} attributes - `.gitattributes` content for the base commit
 * @param {string} base - The base change log
 * @param {(s: string) => string} ours - Edit on the branch that is checked out
 * @param {(s: string) => string} theirs - Edit on the branch that is merged in
 * @returns {string} The repository directory
 */
function makeRepo(name, attributes, base, ours, theirs) {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(path.join(dir, '.prawduct'), { recursive: true });
  initRepo(dir, ['-b', 'main'], { env: gitEnv() });
  fs.writeFileSync(path.join(dir, '.gitattributes'), attributes);
  fs.writeFileSync(path.join(dir, LOG), base);
  gitOk(dir, 'add', '-A');
  gitOk(dir, 'commit', '-q', '-m', 'base');
  for (const [branch, edit] of [['theirs', theirs], ['ours', ours]]) {
    gitOk(dir, 'switch', '-q', '-c', branch, 'main');
    fs.writeFileSync(path.join(dir, LOG), edit(base));
    gitOk(dir, 'commit', '-q', '-a', '-m', branch);
  }
  return dir;
}

/**
 * Merge `theirs` into the checked-out `ours`.
 * @param {string} dir
 * @returns {{status: number, conflicted: string[], log: string}}
 */
function mergeTheirs(dir) {
  const r = git(dir, 'merge', '--no-edit', 'theirs');
  const conflicted = gitOk(dir, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  return { status: r.status, conflicted, log: fs.readFileSync(path.join(dir, LOG), 'utf8') };
}

/**
 * Replace `old` with `replacement` exactly once, failing loudly if the fixture
 * text has drifted so the edit would silently do nothing.
 * @param {string} s
 * @param {string} old
 * @param {string} replacement
 * @returns {string}
 */
function replaceOnce(s, old, replacement) {
  assert.equal(s.split(old).length, 2, `fixture text to replace occurs exactly once: ${old}`);
  return s.replace(old, replacement);
}

const SHIPPED_ATTRIBUTES = () => fs.readFileSync(path.join(REPO_ROOT, '.gitattributes'), 'utf8');
const UNION_ATTRIBUTES = `${LOG} merge=union\n`;

const TOP = entry('2026-10-01', 1001, 'first');
const OLD = entry('2026-09-30', 1000, 'zero');

/** Base log: the real header, then two entries. */
const baseLog = () => realHeader() + TOP + OLD;

/**
 * The #1053/#2029 shape. One side prepends an entry above the top entry and
 * stamps that entry's tag line; the other side retitles the same top entry and
 * changes its tag line.
 */
const sameRegion = {
  ours: (s) => replaceOnce(s, TOP, entry('2026-10-01', 1001, 'first, corrected', '-fix')),
  theirs: (s) => replaceOnce(s, TOP, entry('2026-10-02', 1002, 'second') + entry('2026-10-01', 1001, 'first', ' | status=shipped'))
};

/** Two branches each prepend a different, independent entry. */
const twoPrepends = {
  ours: (s) => replaceOnce(s, TOP, entry('2026-10-02', 1002, 'two') + TOP),
  theirs: (s) => replaceOnce(s, TOP, entry('2026-10-03', 1003, 'three') + TOP)
};

before(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-change-log-merge-'));
  emptyGlobalConfig = path.join(sandbox, 'empty-gitconfig');
  fs.writeFileSync(emptyGlobalConfig, '');
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('#2042: merging .prawduct/change-log.md', () => {
  it('control: under merge=union the same-region edit merges with exit 0 into a corrupt log', () => {
    const dir = makeRepo('control', UNION_ATTRIBUTES, baseLog(), sameRegion.ours, sameRegion.theirs);
    const r = mergeTheirs(dir);
    assert.equal(r.status, 0, 'union reports no conflict');
    assert.deepEqual(r.conflicted, []);
    const { problems } = checkStructure(r.log);
    assert.ok(problems.includes('#1001 appears under more than one heading'), `union duplicated the entry: ${problems}`);
    assert.ok(problems.includes('#1001 has no body'), `union left a heading with no body: ${problems}`);
  });

  it('the shipped attribute stops that merge on a visible conflict in the log', () => {
    const dir = makeRepo('same-region', SHIPPED_ATTRIBUTES(), baseLog(), sameRegion.ours, sameRegion.theirs);
    const r = mergeTheirs(dir);
    assert.notEqual(r.status, 0, 'the merge must not succeed silently');
    assert.deepEqual(r.conflicted, [LOG]);
    assert.match(r.log, /^<{7} /m);
    assert.match(r.log, /^>{7} /m);
  });

  it('independent prepends conflict beside the resolution guidance, and the guidance resolves them', () => {
    const dir = makeRepo('two-prepends', SHIPPED_ATTRIBUTES(), baseLog(), twoPrepends.ours, twoPrepends.theirs);
    const r = mergeTheirs(dir);
    assert.notEqual(r.status, 0, 'two prepends must not merge silently');
    assert.deepEqual(r.conflicted, [LOG]);

    const header = r.log.slice(0, r.log.search(/^<{7} /m));
    assert.match(header, /conflict at the top of this file is expected/i);
    assert.match(header, /keep both entries, newest first/i);
    assert.match(header, /origin\/main/);

    // Resolve as the guidance says: both sides' entries, newest first.
    const m = r.log.match(/^<{7} [^\n]*\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7} [^\n]*\n/m);
    assert.ok(m, 'one conflict region at the top');
    const blocks = [m[1], m[2]].map((b) => b.replace(/\n*$/, '\n'));
    blocks.sort((a, b) => b.slice(3, 13).localeCompare(a.slice(3, 13)));
    const resolved = r.log.replace(m[0], blocks.join('\n'));

    const { entries, problems } = checkStructure(resolved);
    assert.deepEqual(problems, []);
    assert.deepEqual(entries.map((e) => e.issue), ['#1003', '#1002', '#1001', '#1000']);
  });

  it('edits far apart still merge cleanly, to the same result every time', () => {
    const ours = (s) => replaceOnce(s, TOP, entry('2026-10-02', 1002, 'two') + TOP);
    const theirs = (s) => replaceOnce(s, 'Body for #1000.', 'Body for #1000, amended.');
    const expected = realHeader() + entry('2026-10-02', 1002, 'two') + TOP + OLD.replace('Body for #1000.', 'Body for #1000, amended.');
    for (const name of ['far-apart-1', 'far-apart-2']) {
      const dir = makeRepo(name, SHIPPED_ATTRIBUTES(), baseLog(), ours, theirs);
      const r = mergeTheirs(dir);
      assert.equal(r.status, 0);
      assert.deepEqual(r.conflicted, []);
      assert.equal(r.log, expected);
      assert.deepEqual(checkStructure(r.log).problems, []);
    }
  });

  it('the repository marks the change log merge=text', () => {
    const out = gitOk(REPO_ROOT, 'check-attr', 'merge', '--', LOG);
    assert.equal(out.trim(), `${LOG}: merge: text`);
  });
});

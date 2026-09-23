'use strict';

/*
 * Supply-chain floor for `.github/workflows/` (#1436).
 *
 * A `uses:` ref naming a tag or branch runs whatever that name points at when
 * the job starts, so an upstream that moves it executes new code in our CI with
 * no diff in this repository. That is how the `tj-actions/changed-files`
 * compromise ran (CVE-2025-30066), and `release.yml` holds a write token.
 * These tests make every dependency a workflow pulls in an immutable reference,
 * so any change to one arrives as a reviewable diff (and, from Dependabot, as a
 * bump audited under docs/dependency-bump-audit.md).
 *
 * They run inside the required `test` check on purpose: a separate job would
 * carry a check name branch protection does not require, and `--auto` would
 * merge straight past it.
 *
 * What this proves, and what it does not: the SHAPE of every reference (a full
 * commit SHA, a digest, or a local path) and that annotations agree with each
 * other. It cannot prove that a `# vX.Y.Z` comment names the release that SHA
 * really is; that needs the network. The initial mapping was checked with
 * `git ls-remote` against each action's repository, and every later change
 * arrives as a bump PR that docs/dependency-bump-audit.md audits.
 *
 * No YAML parser: TangleClaw has no npm dependencies, and the lines judged
 * here have one shape each.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', '.github', 'workflows');
const RELEASE_WORKFLOW = 'release.yml';

// `uses:` with its ref and an optional trailing comment, as a step or a job
// (reusable workflow) writes it. The key and the value may each be quoted.
const USES_LINE_RE = /^[ \t]*(?:-[ \t]+)?(['"]?)uses\1:[ \t]*(['"]?)([^'"\s#]+)\2[ \t]*(#.*)?$/;
// Any line that names a `uses` key at all, in block or flow style. A match
// that USES_LINE_RE cannot parse is reported, never skipped.
const USES_KEY_RE = /(^|[\s{,-])['"]?uses['"]?[ \t]*:/;
const SHA_PIN_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+@[0-9a-f]{40}$/;
const DOCKER_DIGEST_RE = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
const VERSION_COMMENT_RE = /^#[ \t]*v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?[ \t]*$/;

/**
 * Judge one `uses:` reference. Local actions (`./path`) live in this
 * repository and change only by a reviewed diff, so they need no pin.
 * @param {string} ref - the value after `uses:`
 * @param {string|undefined} comment - the trailing `# ...` text, if any
 * @returns {string|null} why the reference is not immutable, or null when it is
 */
function judgeUsesRef(ref, comment) {
  if (ref.startsWith('./')) return null;
  if (ref.startsWith('docker://')) {
    return DOCKER_DIGEST_RE.test(ref) ? null : 'docker image not pinned by sha256 digest';
  }
  if (!SHA_PIN_RE.test(ref)) return 'not pinned to a full 40-character commit SHA';
  if (!comment || !VERSION_COMMENT_RE.test(comment.trim())) {
    return 'SHA pin has no `# vX.Y.Z` comment naming the release it is';
  }
  return null;
}

/**
 * Collect every `uses:` reference in a workflow's text, with its line number.
 * A line that mentions `uses:` but does not parse is reported as unparsed, so
 * an unexpected shape fails closed instead of being skipped.
 * @param {string} src - workflow YAML text
 * @returns {{line: number, ref: string|null, comment: string|undefined, raw: string}[]}
 */
function collectUses(src) {
  const out = [];
  src.split('\n').forEach((raw, i) => {
    if (/^[ \t]*#/.test(raw) || !USES_KEY_RE.test(raw)) return;
    const m = USES_LINE_RE.exec(raw);
    out.push({ line: i + 1, ref: m ? m[3] : null, comment: m ? m[4] : undefined, raw });
  });
  return out;
}

/**
 * Find annotations that disagree with each other across workflows. Two
 * directions, because a hand edit can go either way: one pin (action identity
 * and path plus SHA) carrying two different `# vX.Y.Z` comments, or one action
 * carrying the same comment on two different SHAs. Either way a reviewer
 * reading one of the lines is misled about what runs.
 * @param {{name: string, src: string}[]} files - workflows to compare
 * @returns {string[]} one description per conflict
 */
function findAnnotationConflicts(files) {
  const versionByPin = new Map();
  const pinByVersion = new Map();
  const conflicts = [];
  for (const { name, src } of files) {
    for (const u of collectUses(src)) {
      if (!u.ref || !SHA_PIN_RE.test(u.ref) || !u.comment) continue;
      const where = `${name}:${u.line}`;
      const version = u.comment.replace(/^#\s*/, '').trim();
      const action = u.ref.slice(0, u.ref.lastIndexOf('@'));
      const priorVersion = versionByPin.get(u.ref);
      if (priorVersion && priorVersion.version !== version) {
        conflicts.push(`${u.ref}: ${priorVersion.where} says ${priorVersion.version}, ${where} says ${version}`);
      } else if (!priorVersion) {
        versionByPin.set(u.ref, { version, where });
      }
      const versionKey = `${action} ${version}`;
      const priorPin = pinByVersion.get(versionKey);
      if (priorPin && priorPin.ref !== u.ref) {
        conflicts.push(`${action} ${version}: ${priorPin.where} pins ${priorPin.ref}, ${where} pins ${u.ref}`);
      } else if (!priorPin) {
        pinByVersion.set(versionKey, { ref: u.ref, where });
      }
    }
  }
  return conflicts;
}

/**
 * List the workflow files and read each one.
 * @returns {{name: string, src: string}[]}
 */
function workflows() {
  return fs.readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((name) => ({ name, src: fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8') }));
}

describe('workflow action pins: the rule itself', () => {
  it('accepts a full SHA with a version comment, and local actions', () => {
    assert.equal(judgeUsesRef('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', '# v7.0.1'), null);
    assert.equal(judgeUsesRef('owner/repo/sub/path@3d3c42e5aac5ba805825da76410c181273ba90b1', '# v1.2.3-rc.1'), null);
    assert.equal(judgeUsesRef('./.github/actions/local', undefined), null);
    assert.equal(judgeUsesRef(`docker://alpine@sha256:${'a'.repeat(64)}`, undefined), null);
  });

  it('refuses tags, branches, short or uppercase SHAs, and uncommented pins', () => {
    for (const ref of [
      'actions/checkout@v7',
      'actions/checkout@v7.0.1',
      'actions/checkout@main',
      'actions/checkout@3d3c42e',
      'actions/checkout@3D3C42E5AAC5BA805825DA76410C181273BA90B1'
    ]) {
      assert.notEqual(judgeUsesRef(ref, '# v7.0.1'), null, `${ref} must be refused`);
    }
    assert.notEqual(judgeUsesRef('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', undefined), null);
    assert.notEqual(judgeUsesRef('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', '# latest'), null);
  });

  it('finds annotation conflicts in both directions, and none when pins agree', () => {
    const a = '3d3c42e5aac5ba805825da76410c181273ba90b1';
    const b = '820762786026740c76f36085b0efc47a31fe5020';
    const wf = (ref, comment) => ({ name: 'x.yml', src: `    steps:\n      - uses: actions/checkout@${ref} # ${comment}\n` });
    assert.deepEqual(findAnnotationConflicts([wf(a, 'v7.0.1'), wf(a, 'v7.0.1')]), []);
    assert.equal(findAnnotationConflicts([wf(a, 'v7.0.1'), wf(a, 'v7.0.2')]).length, 1,
      'one SHA with two version comments');
    assert.equal(findAnnotationConflicts([wf(a, 'v7.0.1'), wf(b, 'v7.0.1')]).length, 1,
      'one version comment on two SHAs');
    assert.deepEqual(findAnnotationConflicts([wf(a, 'v7.0.1'), wf(b, 'v7.0.2')]), [],
      'two different releases of one action may coexist');
    const other = { name: 'y.yml', src: `    steps:\n      - uses: actions/setup-node@${b} # v7.0.1\n` };
    assert.deepEqual(findAnnotationConflicts([wf(a, 'v7.0.1'), other]), [],
      'two different actions may share a version number');
  });

  it('refuses a docker image named by tag', () => {
    assert.notEqual(judgeUsesRef('docker://alpine:3.20', undefined), null);
  });

  it('reports a uses: line it cannot parse instead of skipping it', () => {
    for (const src of [
      '    steps:\n      - uses: actions/checkout@v7 extra words\n',
      '    steps:\n      - { uses: actions/checkout@v7 }\n'
    ]) {
      const found = collectUses(src);
      assert.equal(found.length, 1, src);
      assert.equal(found[0].ref, null, src);
    }
  });

  it('reads every block form: step and job level, quoted key or value', () => {
    const sha = '3d3c42e5aac5ba805825da76410c181273ba90b1';
    const src = [
      'jobs:',
      '  call:',
      `    uses: owner/repo/.github/workflows/ci.yml@${sha} # v1.0.0`,
      '  build:',
      '    steps:',
      `      - uses: 'actions/checkout@${sha}' # v7.0.1`,
      `      - "uses": "actions/setup-node@v7"`,
      '        with:',
      '          uses-this: not-a-uses-key'
    ].join('\n');
    const found = collectUses(src);
    assert.deepEqual(found.map((u) => u.ref), [
      `owner/repo/.github/workflows/ci.yml@${sha}`,
      `actions/checkout@${sha}`,
      'actions/setup-node@v7'
    ]);
    assert.equal(judgeUsesRef(found[0].ref, found[0].comment), null);
    assert.notEqual(judgeUsesRef(found[2].ref, found[2].comment), null);
  });
});

describe('workflow action pins: this repository', () => {
  const files = workflows();

  it('has workflows to judge', () => {
    assert.ok(files.length > 0, 'no workflows found — the directory moved?');
    assert.ok(files.some((f) => f.name === RELEASE_WORKFLOW), `${RELEASE_WORKFLOW} missing`);
  });

  it('pins every uses: reference to an immutable ref', () => {
    const problems = [];
    let count = 0;
    for (const { name, src } of files) {
      for (const u of collectUses(src)) {
        count++;
        const why = u.ref === null ? 'unparsed uses: line' : judgeUsesRef(u.ref, u.comment);
        if (why) problems.push(`${name}:${u.line}: ${why}\n    ${u.raw.trim()}`);
      }
    }
    assert.ok(count > 0, 'found no uses: lines at all — the parser is broken');
    assert.deepEqual(problems, [], `unpinned workflow dependencies:\n${problems.join('\n')}`);
  });

  it('names one version per pinned action and SHA across all workflows', () => {
    assert.deepEqual(findAnnotationConflicts(files), []);
  });

  it('declares a top-level permissions: block in every workflow', () => {
    // Without one, a workflow inherits the repository's default token scope,
    // and a settings change can widen it with no diff here.
    const missing = files.filter(({ src }) => !/^permissions:/m.test(src)).map((f) => f.name);
    assert.deepEqual(missing, []);
  });

  it('pins the Node runtime the privileged release job downloads to an exact version', () => {
    // setup-node resolves a partial version like `22` to the newest match when
    // the job runs, so the binary executing inside the contents: write job
    // would be chosen at run time. Unprivileged workflows may track patches.
    const src = files.find((f) => f.name === RELEASE_WORKFLOW).src;
    const versions = [...src.matchAll(/^[ \t]*node-version:[ \t]*['"]?([^'"\s#]+)/gm)].map((m) => m[1]);
    assert.ok(versions.length > 0, `${RELEASE_WORKFLOW} sets no node-version`);
    for (const v of versions) {
      assert.match(v, /^\d+\.\d+\.\d+$/, `${RELEASE_WORKFLOW} node-version ${v} is not an exact X.Y.Z`);
    }
  });
});

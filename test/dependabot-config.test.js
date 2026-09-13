'use strict';

/*
 * Source pins for `.github/dependabot.yml` and the dependency-bump audit
 * policy it points at (#1361).
 *
 * Dependabot PRs are untrusted and never merged (ADR 0014,
 * docs/dependency-bump-audit.md). The config is text GitHub reads, and the
 * policy is only as good as the absence of a shortcut around it, so these
 * tests pin three things:
 *
 * - the config covers the ecosystems the repo actually has;
 * - no workflow opens a path by which a bump PR merges, or gets the base
 *   repository's privileges, without a maintainer;
 * - the policy document is reachable from the places a reader starts.
 *
 * No YAML parser: TangleClaw has no npm dependencies, and the config is small
 * enough to read as text.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, '.github', 'dependabot.yml');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');
const POLICY_DOC = path.join(ROOT, 'docs', 'dependency-bump-audit.md');
const ADR_0014 = path.join(ROOT, 'docs', 'adr', '0014-dual-key-review-for-untrusted-prs.md');
const README = path.join(ROOT, 'README.md');

/**
 * Strip YAML comments (whole-line and trailing) so assertions judge
 * configuration, not the prose explaining it. Adequate for these files,
 * which do not put `#` inside quoted values on the lines being judged.
 * @param {string} src - YAML source text
 * @returns {string} source with comments removed
 */
function stripYamlComments(src) {
  return src
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');
}

/**
 * Split a dependabot.yml `updates:` list into one text block per entry,
 * keyed by its package-ecosystem.
 * @param {string} src - comment-stripped dependabot.yml text
 * @returns {Map<string, string>} ecosystem name to that entry's text
 */
function updateEntries(src) {
  const entries = new Map();
  const parts = src.split(/^\s*-\s+package-ecosystem:\s*/m).slice(1);
  for (const part of parts) {
    const name = part.split('\n')[0].trim().replace(/^["']|["']$/g, '');
    entries.set(name, part);
  }
  return entries;
}

/**
 * Read every workflow file in `.github/workflows/`.
 * @returns {Array<{name: string, src: string}>} file name and raw text
 */
function workflows() {
  return fs.readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => ({ name: f, src: fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8') }));
}

describe('Dependabot config (.github/dependabot.yml)', () => {
  it('exists and declares config version 2', () => {
    assert.ok(fs.existsSync(CONFIG), 'dependabot.yml missing');
    assert.match(stripYamlComments(fs.readFileSync(CONFIG, 'utf8')), /^version:\s*2\s*$/m);
  });

  it('watches github-actions whenever a workflow uses a third-party action', () => {
    const usesAction = workflows().some(({ src }) =>
      /^\s*-?\s*uses:\s*[\w.-]+\/[\w.-]+(?:\/[^@\s]*)?@/m.test(stripYamlComments(src)));
    const entries = updateEntries(stripYamlComments(fs.readFileSync(CONFIG, 'utf8')));
    if (usesAction) {
      assert.ok(entries.has('github-actions'),
        'workflows reference actions by ref, but Dependabot is not watching the github-actions ecosystem');
    }
  });

  it('scans the workflows from the repository root', () => {
    const entry = updateEntries(stripYamlComments(fs.readFileSync(CONFIG, 'utf8'))).get('github-actions');
    assert.ok(entry, 'github-actions entry missing');
    // For github-actions, "/" is the value that makes Dependabot read
    // .github/workflows/; any other directory watches nothing here.
    assert.match(entry, /^\s*directory:\s*["']?\/["']?\s*$/m);
  });

  it('keeps every ecosystem conservative: weekly or slower, small open-PR limit', () => {
    const entries = updateEntries(stripYamlComments(fs.readFileSync(CONFIG, 'utf8')));
    assert.ok(entries.size > 0, 'no update entries');
    for (const [name, entry] of entries) {
      // Every PR is a manual audit plus a hand reconstruction, so the cadence
      // and backlog are sized to that cost.
      assert.match(entry, /^\s*interval:\s*["']?(weekly|monthly)["']?\s*$/m,
        `${name}: schedule must be weekly or monthly`);
      const limit = entry.match(/^\s*open-pull-requests-limit:\s*(\d+)\s*$/m);
      assert.ok(limit, `${name}: open-pull-requests-limit must be set explicitly`);
      const n = Number(limit[1]);
      assert.ok(n >= 1 && n <= 5, `${name}: open-pull-requests-limit ${n} is outside 1..5`);
    }
  });

  it('has an npm entry exactly when the repository has an npm manifest', () => {
    // The zero-npm-dependency stance is why npm is absent today. An npm entry
    // with no manifest fails every scheduled run; a manifest with no entry is
    // an unwatched dependency tree. Either divergence fails here.
    const hasManifest = fs.existsSync(path.join(ROOT, 'package.json'));
    const hasEntry = updateEntries(stripYamlComments(fs.readFileSync(CONFIG, 'utf8'))).has('npm');
    assert.equal(hasEntry, hasManifest,
      hasManifest
        ? 'package.json exists but dependabot.yml has no npm entry'
        : 'dependabot.yml configures npm but the repository has no package.json');
  });

  it('points readers of the config at the audit policy', () => {
    assert.ok(fs.readFileSync(CONFIG, 'utf8').includes('docs/dependency-bump-audit.md'));
  });
});

describe('No merge or privilege path for dependency-bump PRs (.github/workflows/)', () => {
  it('no workflow references Dependabot outside a comment', () => {
    // Every Dependabot auto-approve / auto-merge recipe keys on the bot's
    // identity (`github.actor == 'dependabot[bot]'`) or on
    // dependabot/fetch-metadata. Neither has a legitimate use here.
    for (const { name, src } of workflows()) {
      assert.doesNotMatch(stripYamlComments(src), /dependabot/i,
        `${name} references Dependabot: bump PRs are never approved or merged by automation`);
    }
  });

  it('no workflow runs on a trigger that grants base-repository privileges', () => {
    // CI running a bump PR's new action version is accepted only because
    // pull_request runs are read-only and secret-less. These three
    // triggers are not.
    for (const { name, src } of workflows()) {
      const code = stripYamlComments(src);
      assert.doesNotMatch(code, /\bpull_request_target\b/, `${name} uses pull_request_target`);
      assert.doesNotMatch(code, /\bworkflow_run\b/, `${name} uses workflow_run`);
      assert.doesNotMatch(code, /\bissue_comment\b/, `${name} uses issue_comment`);
    }
  });
});

describe('Dependency-bump audit policy (docs/dependency-bump-audit.md)', () => {
  it('exists and states that bump PRs are never merged or auto-merged', () => {
    assert.ok(fs.existsSync(POLICY_DOC), 'policy doc missing');
    const doc = fs.readFileSync(POLICY_DOC, 'utf8');
    assert.match(doc, /never merged/);
    assert.match(doc, /no auto-merge/);
  });

  it('is linked from ADR 0014 and from the README', () => {
    assert.ok(fs.readFileSync(ADR_0014, 'utf8').includes('(../dependency-bump-audit.md)'),
      'ADR 0014 does not link the dependency-bump audit policy');
    assert.ok(fs.readFileSync(README, 'utf8').includes('(docs/dependency-bump-audit.md)'),
      'README does not link the dependency-bump audit policy');
  });

  it('rests the ADR 0014 exemption on the checker command, in both the ADR and the audit doc', () => {
    // The operator ruled the uses:-only condition is checked by a command, never
    // by eye. The command named in the prose must be one that exists.
    const cmd = 'node scripts/check-bump-diff.js';
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'check-bump-diff.js')), 'checker script missing');
    assert.ok(fs.readFileSync(ADR_0014, 'utf8').includes(cmd), 'ADR 0014 exemption does not name the checker');
    assert.ok(fs.readFileSync(POLICY_DOC, 'utf8').includes(cmd), 'audit doc macro filter does not name the checker');
  });

  it('links only to repository files that exist', () => {
    const doc = fs.readFileSync(POLICY_DOC, 'utf8');
    const targets = [...doc.matchAll(/\]\(((?!https?:)[^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
    assert.ok(targets.length > 0, 'expected relative links in the policy doc');
    for (const target of targets) {
      assert.ok(fs.existsSync(path.join(path.dirname(POLICY_DOC), target)),
        `broken link in dependency-bump-audit.md: ${target}`);
    }
  });
});

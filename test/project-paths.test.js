'use strict';

// `resolveWithinProject` is the single containment predicate three call sites
// share — the API validator (lib/projects.js), the version reader
// (lib/project-version.js), and the wrap step's write site
// (lib/wrap-steps/version-bump.js). It exists because those sites had begun to
// re-derive the rule independently, and a validator that accepts what the write
// site later refuses produces a setting that saves cleanly and silently does
// nothing.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveWithinProject, normalizeConfiguredPath, resolveConfiguredFile } = require('../lib/project-paths');

const ROOT = '/tmp/proj';

describe('resolveWithinProject', () => {
  describe('accepts paths that land inside the project', () => {
    for (const [label, input, expected] of [
      ['a plain filename', 'VERSION.json', '/tmp/proj/VERSION.json'],
      ['a nested path', 'meta/app-version.json', '/tmp/proj/meta/app-version.json'],
      ['a ./ prefix', './VERSION.json', '/tmp/proj/VERSION.json'],
      // Resolves safely inside despite containing `..` — a lexical scan would
      // wrongly reject this, which is why the predicate is resolution-based.
      ['an interior .. that stays inside', 'meta/../VERSION.json', '/tmp/proj/VERSION.json'],
      ['surrounding whitespace', '  VERSION.json  ', '/tmp/proj/VERSION.json']
    ]) {
      it(label, () => {
        const got = resolveWithinProject(ROOT, input);
        assert.equal(got.ok, true, got.reason);
        assert.equal(got.path, path.resolve(expected));
      });
    }
  });

  describe('refuses anything that escapes or is not a file inside', () => {
    for (const [label, input, reasonMatch] of [
      ['an absolute path', '/etc/passwd.json', /absolute/],
      ['a parent escape', '../outside.json', /outside the project root/],
      ['a deep parent escape', '../../../etc/passwd.json', /outside the project root/],
      ['an escape disguised by an interior segment', 'a/../../b.json', /outside the project root/],
      // Resolves to the root itself — a directory, which nothing can write as
      // a file. A lexical `..` scan would wrongly ACCEPT this.
      ['the project root itself', '.', /project root itself/],
      ['an empty string', '', /empty/],
      ['whitespace only', '   ', /empty/]
    ]) {
      it(label, () => {
        const got = resolveWithinProject(ROOT, input);
        assert.equal(got.ok, false, `expected refusal for ${JSON.stringify(input)}`);
        assert.match(got.reason, reasonMatch);
      });
    }
  });

  describe('refuses non-string input rather than coercing it', () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      it(`refuses ${JSON.stringify(bad) ?? String(bad)}`, () => {
        const got = resolveWithinProject(ROOT, bad);
        assert.equal(got.ok, false);
        assert.match(got.reason, /empty/);
      });
    }
  });

  it('never returns a path outside the root, for any accepted input', () => {
    // Property-style backstop: whatever the predicate accepts must be contained.
    const inputs = [
      'a.json', 'a/b/c.json', './a.json', 'a/../b.json', 'a/./b.json',
      'a//b.json', 'deeply/nested/../../still-inside.json'
    ];
    for (const input of inputs) {
      const got = resolveWithinProject(ROOT, input);
      if (!got.ok) continue;
      const rel = path.relative(path.resolve(ROOT), got.path);
      assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel) && rel !== '',
        `accepted ${JSON.stringify(input)} but it resolved to ${got.path}`);
    }
  });
});

describe('normalizeConfiguredPath', () => {
  it('trims a real value', () => {
    assert.equal(normalizeConfiguredPath('  VERSION.json  '), 'VERSION.json');
  });

  it('treats blank and non-string as "not configured", not as a value', () => {
    // Every read site used to inline this test, and they had begun to disagree
    // about whether "  " means configured-but-empty or not-configured.
    for (const blank of ['', '   ', '\t\n', null, undefined, 0, false, {}, []]) {
      assert.equal(normalizeConfiguredPath(blank), null,
        `expected null for ${JSON.stringify(blank)}`);
    }
  });
});

describe('resolveConfiguredFile', () => {
  // The three-way return is load-bearing: it is what separates "the wrap
  // refuses to bump" from "detection degrades to its probe". Both callers
  // branch on `configured` and `ok` independently, so both must be assertable
  // here rather than only through their consumers.
  it('reports not-configured when the key is absent or blank', () => {
    for (const cfg of [null, {}, { versionFilePath: null }, { versionFilePath: '  ' }]) {
      const got = resolveConfiguredFile(ROOT, cfg, 'versionFilePath');
      assert.equal(got.configured, false, `expected not-configured for ${JSON.stringify(cfg)}`);
      assert.equal(got.ok, undefined, 'not-configured carries no ok verdict to branch on');
    }
  });

  it('reports configured + ok with the resolved absolute path', () => {
    const got = resolveConfiguredFile(ROOT, { versionFilePath: ' meta/VERSION.json ' }, 'versionFilePath');
    assert.equal(got.configured, true);
    assert.equal(got.ok, true);
    assert.equal(got.raw, 'meta/VERSION.json', 'raw is the trimmed value, for messages');
    assert.equal(got.path, path.resolve('/tmp/proj/meta/VERSION.json'));
  });

  it('reports configured + not-ok with a composable reason, never a path', () => {
    const got = resolveConfiguredFile(ROOT, { versionFilePath: '../escape.json' }, 'versionFilePath');
    assert.equal(got.configured, true);
    assert.equal(got.ok, false);
    assert.equal(got.raw, '../escape.json', 'names what the operator actually wrote');
    assert.match(got.reason, /resolves outside the project root/);
    assert.equal(got.path, undefined, 'a refused value must not hand back a usable path');
  });

  it('reads whichever key it is given', () => {
    const got = resolveConfiguredFile(ROOT, { someOtherPath: 'a.json' }, 'someOtherPath');
    assert.equal(got.configured, true);
    assert.equal(got.ok, true);
  });
});

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

const { resolveWithinProject } = require('../lib/project-paths');

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

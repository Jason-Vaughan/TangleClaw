'use strict';

// `resolveWithinProject` is the single containment predicate three call sites
// share — the API validator (lib/projects.js), the version reader
// (lib/project-version.js), and the wrap step's write site
// (lib/wrap-steps/version-bump.js). It exists because those sites had begun to
// re-derive the rule independently, and a validator that accepts what the write
// site later refuses produces a setting that saves cleanly and silently does
// nothing.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { resolveWithinProject, isInsideProject, normalizeConfiguredPath, resolveConfiguredFile } = require('../lib/project-paths');

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

describe('resolveWithinProject follows symlinks', () => {
  // Lexical resolution alone is not containment: a symlinked directory inside
  // the project points anywhere, and the commit step writes through it. This is
  // the difference between the docstring's claim and what the code enforces.
  let base;
  let root;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-symlink-'));
    root = path.join(base, 'proj');
    fs.mkdirSync(path.join(root, 'real'), { recursive: true });
    fs.mkdirSync(path.join(base, 'outside'), { recursive: true });
    fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'linkdir'));
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('refuses a path through a symlink that escapes the project', () => {
    const got = resolveWithinProject(root, 'linkdir/VERSION.json');
    assert.equal(got.ok, false);
    assert.match(got.reason, /symlinks are followed/);
  });

  it('refuses a not-yet-created file under an escaping symlink', () => {
    const got = resolveWithinProject(root, 'linkdir/nested/new.json');
    assert.equal(got.ok, false);
  });

  it('still accepts a real path inside the project', () => {
    assert.equal(resolveWithinProject(root, 'real/VERSION.json').ok, true);
  });

  it('still accepts a file that does not exist yet', () => {
    // An operator may name the version file before creating it, so a missing
    // target must not read as an escape.
    assert.equal(resolveWithinProject(root, 'not-created-yet.json').ok, true);
    assert.equal(resolveWithinProject(root, 'deep/not/made/yet.json').ok, true);
  });
});

// #1052 — the two containment predicates in this repo disagreed about the root
// case, and the second one (in the wrap pipeline) was hand-rolled precisely
// because it meant something different. They now share one rule and express the
// difference as an option, so the difference has to be asserted in BOTH
// directions: a default that quietly started allowing the root would make the
// version-bump validator accept a directory it can never write.
describe('containment policy is explicit in both directions', () => {
  let base, root;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-contain-'));
    root = path.join(base, 'proj');
    fs.mkdirSync(path.join(root, 'real'), { recursive: true });
    fs.mkdirSync(path.join(base, 'outside'), { recursive: true });
    fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'linkdir'));
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  describe('allowRoot', () => {
    it('off by default: the root is not a file inside itself', () => {
      assert.equal(resolveWithinProject(root, '.').ok, false);
      assert.equal(isInsideProject(root, root), false);
    });

    it('on: the root is inside, for callers validating a directory', () => {
      assert.equal(resolveWithinProject(root, '.', { allowRoot: true }).ok, true);
      assert.equal(isInsideProject(root, root, { allowRoot: true }), true);
    });

    it('never widens the escape case — allowRoot is about the root, not about outside', () => {
      assert.equal(resolveWithinProject(root, '../escape.json', { allowRoot: true }).ok, false);
      assert.equal(isInsideProject(root, path.join(base, 'outside', 'x'), { allowRoot: true }), false);
    });

    it('a symlink resolving ONTO the root is refused by default and allowed with allowRoot', () => {
      // The root is reachable as a symlink target, not only as `.`, so the
      // policy has to hold after resolution too — a check that applied it only
      // to the lexical pass would disagree with itself.
      fs.symlinkSync(root, path.join(root, 'real', 'self'));
      assert.equal(isInsideProject(root, path.join(root, 'real', 'self')), false);
      assert.equal(isInsideProject(root, path.join(root, 'real', 'self'), { allowRoot: true }), true);
    });
  });

  describe('followSymlinks', () => {
    it('on by default: an escaping symlink is refused', () => {
      assert.equal(isInsideProject(root, path.join(root, 'linkdir', 'VERSION.json')), false);
      assert.equal(resolveWithinProject(root, 'linkdir/VERSION.json').ok, false);
    });

    it('resolves the FINAL component, not just its directory', () => {
      // A file that is itself a symlink out of the project is the write the
      // predicate exists to stop; resolving only the dirname left it uncovered.
      fs.symlinkSync(path.join(base, 'outside', 'target.json'), path.join(root, 'real', 'linkfile.json'));
      assert.equal(isInsideProject(root, path.join(root, 'real', 'linkfile.json')), false);
      assert.equal(resolveWithinProject(root, 'real/linkfile.json').ok, false);
    });

    it('gives up past the hop bound and reports the lexical answer', () => {
      // Makes the bound observable without timing anything: a chain longer than
      // the budget resolves outside the project, so a build WITHOUT the bound
      // answers `false` here while the bounded one gives up and answers `true`.
      // The give-up is fail-open by design — see MAX_DANGLING_LINK_HOPS.
      const chain = path.join(root, 'real');
      for (let i = 0; i < 40; i += 1) {
        const next = i === 39 ? path.join(base, 'outside', 'end.json') : path.join(chain, `hop${i + 1}`);
        fs.symlinkSync(next, path.join(chain, `hop${i}`));
      }
      assert.equal(isInsideProject(root, path.join(chain, 'hop0')), true);
    });

    it('resolves a symlink chain, and a cycle terminates instead of hanging', () => {
      // A cycle makes every `realpathSync` throw, so without a hop bound the
      // hand-rolled dangling-link walk would follow it forever.
      fs.symlinkSync(path.join(root, 'real', 'b'), path.join(root, 'real', 'a'));
      fs.symlinkSync(path.join(root, 'real', 'a'), path.join(root, 'real', 'b'));
      assert.equal(isInsideProject(root, path.join(root, 'real', 'a')), true);
    });

    it('off: the check stays lexical, which is what a plan pointer needs', () => {
      // Governance state is symlinked back to a primary checkout when work
      // happens in a git worktree, so `.prawduct/artifacts/build-plan.md` inside
      // a worktree is a symlink pointing out of it. Following it would refuse
      // every worktree session's plan pointer as an escape.
      assert.equal(isInsideProject(root, path.join(root, 'linkdir', 'VERSION.json'), { followSymlinks: false }), true);
      assert.equal(resolveWithinProject(root, 'linkdir/VERSION.json', { followSymlinks: false }).ok, true);
    });

    it('off does not disable the lexical escape check', () => {
      assert.equal(isInsideProject(root, path.join(base, 'outside', 'x'), { followSymlinks: false }), false);
      assert.equal(resolveWithinProject(root, '../escape.json', { followSymlinks: false }).ok, false);
    });
  });

  describe('the two predicates cannot disagree', () => {
    for (const [label, rel, options] of [
      ['a plain file', 'VERSION.json', {}],
      ['the root', '.', {}],
      ['the root, allowed', '.', { allowRoot: true }],
      ['an escape', '../out.json', {}],
      ['an escaping symlink', 'linkdir/VERSION.json', {}],
      ['an escaping symlink, lexical only', 'linkdir/VERSION.json', { followSymlinks: false }]
    ]) {
      it(`agrees on ${label}`, () => {
        const viaResolve = resolveWithinProject(root, rel, options).ok;
        const viaIsInside = isInsideProject(root, path.resolve(root, rel), options);
        assert.equal(viaResolve, viaIsInside,
          `resolveWithinProject said ${viaResolve} and isInsideProject said ${viaIsInside}`);
      });
    }
  });

  describe('isInsideProject never fails open on bad input', () => {
    for (const bad of [null, undefined, 42, '', '   ']) {
      it(`refuses ${JSON.stringify(bad)}`, () => {
        assert.equal(isInsideProject(root, bad), false);
        assert.equal(isInsideProject(bad, path.join(root, 'a.json')), false);
      });
    }
  });
});

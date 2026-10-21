'use strict';

/*
 * The fragment contract (#1220): `changelog.d/<issue>.<slug>.<type>.md`.
 *
 * Fixtures live in a temp directory per test. The one place this file reaches
 * past the module under test is `lib/wrap-steps/version-bump.js`, required
 * HERE and never by the module: the module's block-finding regexes are pinned
 * equal to version-bump's by reading its source, and the bump-level fixtures
 * are spliced by the module and judged by version-bump's own
 * `_decideBumpLevel`, so there is one derivation, not two to compare.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fragments = require('../lib/changelog-fragments');
const versionBump = require('../lib/wrap-steps/version-bump');

const {
  FRAGMENT_DIR, TYPES, NAME_RE, parseFragmentName, readFragments, compileFragments, spliceIntoUnreleased
} = fragments;

let tmpRoot;
let seq = 0;

before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-changelog-fragments-')); });
after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

/**
 * Make a fresh project root with a `changelog.d/` holding the given files.
 *
 * @param {Record<string, string>|null} files - basename → body; null for no directory at all
 * @returns {string} the root
 */
function makeRoot(files) {
  const root = path.join(tmpRoot, `root-${++seq}`);
  fs.mkdirSync(root, { recursive: true });
  if (files !== null) {
    const dir = path.join(root, FRAGMENT_DIR);
    fs.mkdirSync(dir);
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  }
  return root;
}

/** @returns {string[]} the refusal codes of a read, sorted */
function codesOf(res) {
  return res.refused.map((r) => r.code).sort();
}

/** @returns {string} the basenames of a read's accepted fragments, in order */
function namesOf(res) {
  return res.fragments.map((f) => path.basename(f.path));
}

const SIX = {
  '1220.compiler.added.md': '- Compile fragments (#1220).\n',
  '1220.coverage.changed.md': '- Coverage accepts a fragment (#1220).\n',
  '900.old-flag.removed.md': '- Drop the old flag (#900).\n',
  '901.api.deprecated.md': '- Deprecate the v1 route (#901).\n',
  '77.race.fixed.md': '- Fix the wrap race (#77).\n',
  '78.token.security.md': '- Rotate the token on read (#78).\n'
};

describe('changelog-fragments: filename contract', () => {
  it('exports the directory, the seven types in subsection order and the closed name grammar', () => {
    assert.equal(FRAGMENT_DIR, 'changelog.d');
    assert.deepEqual([...TYPES], ['added', 'changed', 'removed', 'deprecated', 'fixed', 'security', 'internal']);
    assert.ok(NAME_RE instanceof RegExp);
    assert.ok(NAME_RE.test('1220.changelog-fragments.added.md'));
    assert.ok(!NAME_RE.test('0.x.added.md'), 'issue 0 is not positive');
  });

  it('parses a well-formed name into issue, slug and type', () => {
    assert.deepEqual(parseFragmentName('1220.changelog-fragments.added.md'),
      { ok: true, issue: 1220, slug: 'changelog-fragments', type: 'added' });
    assert.deepEqual(parseFragmentName('7.a.internal.md'), { ok: true, issue: 7, slug: 'a', type: 'internal' });
  });

  it('refuses MALFORMED_NAME for the wrong shape or a path separator', () => {
    for (const name of ['README.md', 'added.md', '1220.slug.added', '1220.slug.added.txt', '1220.slug.added.md.bak',
      '1220.a.b.added.md', '', '../x.added.md', '1220/x.added.md', '1220\\x.added.md', '.DS_Store']) {
      const r = parseFragmentName(name);
      assert.equal(r.ok, false, name);
      assert.equal(r.code, 'MALFORMED_NAME', name);
      assert.equal(typeof r.reason, 'string');
    }
  });

  it('refuses BAD_ISSUE for a non-positive or non-numeric issue', () => {
    for (const name of ['0.x.added.md', '00.x.added.md', '007.x.added.md', 'abc.x.added.md', '-1.x.added.md', '1e3.x.added.md',
      '99999999999999999999.x.added.md']) {
      const r = parseFragmentName(name);
      assert.equal(r.code, 'BAD_ISSUE', name);
    }
  });

  it('refuses BAD_SLUG outside [a-z0-9-]{1,48}', () => {
    for (const name of ['1.Slug.added.md', '1.a_b.added.md', '1.a b.added.md', `1.${'a'.repeat(49)}.added.md`, '1..added.md']) {
      const r = parseFragmentName(name);
      assert.equal(r.code, 'BAD_SLUG', name);
    }
    assert.equal(parseFragmentName(`1.${'a'.repeat(48)}.added.md`).ok, true);
  });

  it('refuses UNKNOWN_TYPE for a type outside the seven', () => {
    for (const name of ['1.x.feature.md', '1.x.Added.md', '1.x.ADDED.md', '1.x.breaking.md', '1.x..md']) {
      const r = parseFragmentName(name);
      assert.equal(r.code, 'UNKNOWN_TYPE', name);
    }
  });

  it('agrees with NAME_RE on every name it accepts or refuses', () => {
    const names = ['1220.slug.added.md', '0.slug.added.md', '007.slug.added.md', '1.a_b.added.md', '1.x.feature.md', 'x.md',
      ...TYPES.map((t) => `42.slug-${t}.${t}.md`)];
    for (const name of names) {
      assert.equal(parseFragmentName(name).ok, NAME_RE.test(name), name);
    }
  });
});

describe('changelog-fragments: readFragments', () => {
  it('reads every type, sorted by issue then slug, whatever the directory order', () => {
    const root = makeRoot(SIX);
    const res = readFragments(root);
    assert.equal(res.ok, true);
    assert.equal(res.dirMissing, false);
    assert.deepEqual(res.refused, []);
    assert.deepEqual(namesOf(res), ['77.race.fixed.md', '78.token.security.md', '900.old-flag.removed.md',
      '901.api.deprecated.md', '1220.compiler.added.md', '1220.coverage.changed.md']);
    assert.equal(res.fragments[0].body, '- Fix the wrap race (#77).\n');
    assert.equal(res.fragments[0].issue, 77);
    assert.equal(res.fragments[0].type, 'fixed');
  });

  it('sorts numerically by issue (10 after 9) and bytewise by slug', () => {
    const root = makeRoot({
      '10.a.added.md': '- ten a\n', '9.z.added.md': '- nine z\n', '10.b.fixed.md': '- ten b\n', '9.a.added.md': '- nine a\n'
    });
    assert.deepEqual(namesOf(readFragments(root)), ['9.a.added.md', '9.z.added.md', '10.a.added.md', '10.b.fixed.md']);
  });

  it('yields identical output under reversed and shuffled enumeration', () => {
    const root = makeRoot(SIX);
    const natural = readFragments(root);
    const reversed = readFragments(root, { fs: { readdirSync: (d) => fs.readdirSync(d).reverse() } });
    const shuffled = readFragments(root, {
      fs: {
        readdirSync: (d) => {
          const names = fs.readdirSync(d);
          // Deterministic shuffle: rotate by 2 then swap ends.
          const rotated = names.slice(2).concat(names.slice(0, 2));
          [rotated[0], rotated[rotated.length - 1]] = [rotated[rotated.length - 1], rotated[0]];
          return rotated;
        }
      }
    });
    assert.deepEqual(reversed, natural);
    assert.deepEqual(shuffled, natural);
    assert.deepEqual(compileFragments(shuffled.fragments), compileFragments(natural.fragments));
  });

  it('treats a missing changelog.d as nothing pending, never an error', () => {
    const root = makeRoot(null);
    assert.deepEqual(readFragments(root), { ok: true, fragments: [], refused: [], dirMissing: true });
  });

  it('accepts an empty changelog.d', () => {
    const root = makeRoot({});
    assert.deepEqual(readFragments(root), { ok: true, fragments: [], refused: [], dirMissing: false });
  });

  it('fails closed when a directory holds only refused entries', () => {
    const root = makeRoot({ 'README.md': '# fragments\n' });
    const res = readFragments(root);
    assert.equal(res.ok, false);
    assert.deepEqual(res.fragments, []);
    assert.deepEqual(codesOf(res), ['MALFORMED_NAME']);
  });

  it('fails closed on one bad entry among good ones, keeping the good ones listed', () => {
    const root = makeRoot({ ...SIX, '5.x.feature.md': '- nope\n' });
    const res = readFragments(root);
    assert.equal(res.ok, false);
    assert.equal(res.fragments.length, 6);
    assert.deepEqual(res.refused.map((r) => [path.basename(r.path), r.code]), [['5.x.feature.md', 'UNKNOWN_TYPE']]);
  });

  it('names each filename refusal by code', () => {
    const root = makeRoot({
      'notes.txt': 'x', '0.x.added.md': '- a\n', '1.Bad_Slug.added.md': '- a\n', '2.x.feature.md': '- a\n'
    });
    assert.deepEqual(codesOf(readFragments(root)), ['BAD_ISSUE', 'BAD_SLUG', 'MALFORMED_NAME', 'UNKNOWN_TYPE']);
  });

  it('refuses a directory entry as NOT_A_FILE', () => {
    const root = makeRoot({});
    fs.mkdirSync(path.join(root, FRAGMENT_DIR, '3.dir.added.md'));
    const res = readFragments(root);
    assert.equal(res.ok, false);
    assert.deepEqual(codesOf(res), ['NOT_A_FILE']);
  });

  it('refuses a symlink entry as SYMLINK, even one pointing at a valid fragment', () => {
    const root = makeRoot({ '4.real.added.md': '- real\n' });
    fs.symlinkSync(path.join(root, FRAGMENT_DIR, '4.real.added.md'), path.join(root, FRAGMENT_DIR, '5.link.added.md'));
    const res = readFragments(root);
    assert.equal(res.ok, false);
    assert.deepEqual(res.refused.map((r) => [path.basename(r.path), r.code]), [['5.link.added.md', 'SYMLINK']]);
    assert.deepEqual(namesOf(res), ['4.real.added.md']);
  });

  it('refuses a changelog.d that is itself a symlink', () => {
    const root = path.join(tmpRoot, `root-${++seq}`);
    const elsewhere = path.join(tmpRoot, `elsewhere-${seq}`);
    fs.mkdirSync(root);
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, '6.x.added.md'), '- x\n');
    fs.symlinkSync(elsewhere, path.join(root, FRAGMENT_DIR));
    const res = readFragments(root);
    assert.equal(res.ok, false);
    assert.deepEqual(codesOf(res), ['SYMLINK']);
    assert.deepEqual(res.fragments, []);
  });

  it('refuses an entry whose real path resolves outside changelog.d as PATH_ESCAPE', () => {
    const root = makeRoot({ '7.x.added.md': '- x\n' });
    const res = readFragments(root, {
      fs: {
        realpathSync: (p) => (path.basename(p) === '7.x.added.md' ? path.join(os.tmpdir(), '7.x.added.md') : fs.realpathSync(p))
      }
    });
    assert.equal(res.ok, false);
    assert.deepEqual(codesOf(res), ['PATH_ESCAPE']);
  });

  it('refuses a body with a heading line, a fence opener or no leading list item as BAD_BODY', () => {
    const root = makeRoot({
      '1.heading.added.md': '- ok\n## not ok\n',
      '2.fence.added.md': '- ok\n```\ncode\n```\n',
      '3.prose.added.md': 'Just prose.\n',
      '4.indented-fence.added.md': '- ok\n   ~~~\n',
      '5.bare-dash.added.md': '- \n'
    });
    const res = readFragments(root);
    assert.equal(res.ok, false);
    assert.deepEqual(codesOf(res), ['BAD_BODY', 'BAD_BODY', 'BAD_BODY', 'BAD_BODY', 'BAD_BODY']);
    for (const r of res.refused) assert.match(r.reason, /line \d+/);
  });

  it('accepts a multi-line entry with a sub-bullet and leading blank lines', () => {
    const root = makeRoot({ '8.multi.changed.md': '\n- First line of the entry,\n  wrapped onto a second.\n  - a sub-bullet\n' });
    const res = readFragments(root);
    assert.equal(res.ok, true);
    assert.equal(res.fragments[0].body, '\n- First line of the entry,\n  wrapped onto a second.\n  - a sub-bullet\n');
  });

  it('refuses an empty or whitespace-only body as EMPTY_BODY', () => {
    const root = makeRoot({ '1.empty.added.md': '', '2.blank.added.md': '  \n\n' });
    assert.deepEqual(codesOf(readFragments(root)), ['EMPTY_BODY', 'EMPTY_BODY']);
  });

  it('never reads .prawduct/change-log.md: a file handed in as root is refused', () => {
    const root = makeRoot({});
    const prawduct = path.join(root, '.prawduct');
    fs.mkdirSync(prawduct);
    const changeLog = path.join(prawduct, 'change-log.md');
    fs.writeFileSync(changeLog, '# Change Log\n\n## 2026-10-21 — entry\n\n- not a fragment\n');
    const reads = [];
    const res = readFragments(changeLog, {
      fs: { readFileSync: (p, enc) => { reads.push(p); return fs.readFileSync(p, enc); } }
    });
    assert.equal(res.ok, false);
    assert.deepEqual(codesOf(res), ['NOT_A_DIRECTORY']);
    assert.equal(res.refused[0].path, path.join(changeLog, FRAGMENT_DIR));
    assert.deepEqual(reads, [], 'no file was opened');
  });

  it('refuses a non-string root without touching the filesystem', () => {
    const res = readFragments(undefined);
    assert.equal(res.ok, false);
    assert.deepEqual(codesOf(res), ['NOT_A_DIRECTORY']);
  });
});

describe('changelog-fragments: compileFragments', () => {
  it('groups every type under its heading in subsection order, omitting empty types', () => {
    const root = makeRoot(SIX);
    const compiled = compileFragments(readFragments(root).fragments);
    assert.deepEqual(compiled.sections.map((s) => s.heading), ['Added', 'Changed', 'Removed', 'Deprecated', 'Fixed', 'Security']);
    assert.deepEqual(compiled.sections[0].entries, ['- Compile fragments (#1220).\n']);
    assert.deepEqual(compiled.sections[4].entries, ['- Fix the wrap race (#77).\n']);
  });

  it('compiles internal under Internal', () => {
    const compiled = compileFragments([{ issue: 1, slug: 'a', type: 'internal', body: '- refactor\n' }]);
    assert.deepEqual(compiled.sections, [{ heading: 'Internal', entries: ['- refactor\n'] }]);
  });

  it('normalizes each entry: CRLF to LF, leading blank lines and trailing whitespace dropped, one trailing newline', () => {
    const compiled = compileFragments([{ issue: 1, slug: 'a', type: 'fixed', body: '\r\n- one\r\n  two  \r\n\r\n' }]);
    assert.deepEqual(compiled.sections[0].entries, ['- one\n  two\n']);
  });

  it('orders entries within a section by issue then slug, whatever order it was handed', () => {
    const compiled = compileFragments([
      { issue: 20, slug: 'b', type: 'added', body: '- 20b\n' },
      { issue: 3, slug: 'z', type: 'added', body: '- 3z\n' },
      { issue: 20, slug: 'a', type: 'added', body: '- 20a\n' }
    ]);
    assert.deepEqual(compiled.sections[0].entries, ['- 3z\n', '- 20a\n', '- 20b\n']);
  });

  it('reports the byte size of the block the sections would form', () => {
    const compiled = compileFragments([
      { issue: 1, slug: 'a', type: 'added', body: '- é\n' },
      { issue: 2, slug: 'b', type: 'fixed', body: '- f\n' }
    ]);
    assert.equal(compiled.bytes, Buffer.byteLength('### Added\n- é\n\n### Fixed\n- f\n', 'utf8'));
    assert.deepEqual(compileFragments([]), { sections: [], bytes: 0 });
  });
});

describe('changelog-fragments: spliceIntoUnreleased', () => {
  const RELEASED = '## [5.34.0] - 2026-10-19\n\n### Added\n- Released thing.\n\n## [5.33.1] - 2026-10-01\n\n### Fixed\n- Old fix.\n';
  const HEAD = '# Changelog\n\nAll notable changes.\n\n';

  /** @returns {{sections:Array<{heading:string, entries:string[]}>}} */
  function compiledOf(fragmentList) {
    return compileFragments(fragmentList);
  }

  it('adds subsections to an empty [Unreleased] and leaves everything else byte-identical', () => {
    const text = `${HEAD}## [Unreleased]\n\n${RELEASED}`;
    const compiled = compiledOf([
      { issue: 1, slug: 'a', type: 'fixed', body: '- fix one\n' },
      { issue: 2, slug: 'b', type: 'added', body: '- add two\n' }
    ]);
    const res = spliceIntoUnreleased(text, compiled);
    assert.equal(res.ok, true);
    assert.equal(res.added, 2);
    assert.equal(res.text, `${HEAD}## [Unreleased]\n\n### Added\n- add two\n\n### Fixed\n- fix one\n\n${RELEASED}`);
    assert.ok(res.text.endsWith(RELEASED));
    assert.ok(res.text.startsWith(HEAD));
  });

  it('appends to an existing subsection after its last entry', () => {
    const text = `## [Unreleased]\n\n### Added\n- existing add\n\n### Fixed\n- existing fix\n\n${RELEASED}`;
    const res = spliceIntoUnreleased(text, compiledOf([{ issue: 9, slug: 'a', type: 'added', body: '- new add\n' }]));
    assert.equal(res.text, `## [Unreleased]\n\n### Added\n- existing add\n- new add\n\n### Fixed\n- existing fix\n\n${RELEASED}`);
  });

  it('inserts a new subsection before, between and after existing ones at its Keep a Changelog position', () => {
    const text = `## [Unreleased]\n\n### Changed\n- c\n\n### Security\n- s\n\n${RELEASED}`;
    const res = spliceIntoUnreleased(text, compiledOf([
      { issue: 1, slug: 'a', type: 'added', body: '- a\n' },
      { issue: 1, slug: 'f', type: 'fixed', body: '- f\n' },
      { issue: 1, slug: 'i', type: 'internal', body: '- i\n' }
    ]));
    assert.equal(res.added, 3);
    assert.equal(res.text,
      `## [Unreleased]\n\n### Added\n- a\n\n### Changed\n- c\n\n### Fixed\n- f\n\n### Security\n- s\n\n### Internal\n- i\n\n${RELEASED}`);
  });

  it('matches an existing subsection heading case-insensitively, as version-bump parses it', () => {
    const text = `## [Unreleased]\n\n### FIXED\n- f1\n\n${RELEASED}`;
    const res = spliceIntoUnreleased(text, compiledOf([{ issue: 1, slug: 'a', type: 'fixed', body: '- f2\n' }]));
    assert.equal(res.text, `## [Unreleased]\n\n### FIXED\n- f1\n- f2\n\n${RELEASED}`);
  });

  it('keeps a fenced block inside [Unreleased] intact and never writes into a heading quoted in it', () => {
    const text = `## [Unreleased]\n\n### Changed\n- shows a sample:\n  \`\`\`\n  ### Added\n  - not a subsection\n  \`\`\`\n\n${RELEASED}`;
    const res = spliceIntoUnreleased(text, compiledOf([{ issue: 1, slug: 'a', type: 'added', body: '- real add\n' }]));
    assert.equal(res.text,
      `## [Unreleased]\n\n### Added\n- real add\n\n### Changed\n- shows a sample:\n  \`\`\`\n  ### Added\n  - not a subsection\n  \`\`\`\n\n${RELEASED}`);
  });

  it('handles a [Unreleased] block with prose and no subsections, and one at the end of the file', () => {
    const prose = spliceIntoUnreleased('## [Unreleased]\n\nNothing yet.\n\n## [1.0.0] - 2026-01-01\n',
      compiledOf([{ issue: 1, slug: 'a', type: 'added', body: '- a\n' }]));
    assert.equal(prose.text, '## [Unreleased]\n\nNothing yet.\n\n### Added\n- a\n\n## [1.0.0] - 2026-01-01\n');
    const tail = spliceIntoUnreleased('# Log\n\n## [Unreleased]\n', compiledOf([{ issue: 1, slug: 'a', type: 'added', body: '- a\n' }]));
    assert.equal(tail.text, '# Log\n\n## [Unreleased]\n\n### Added\n- a\n');
    const tight = spliceIntoUnreleased('## [Unreleased]\n## [1.0.0] - 2026-01-01\n', compiledOf([{ issue: 1, slug: 'a', type: 'added', body: '- a\n' }]));
    assert.equal(tight.text, '## [Unreleased]\n\n### Added\n- a\n\n## [1.0.0] - 2026-01-01\n');
  });

  it('writes a multi-line entry as its lines', () => {
    const res = spliceIntoUnreleased(`## [Unreleased]\n\n${RELEASED}`,
      compiledOf([{ issue: 1, slug: 'a', type: 'added', body: '- first\n  second\n  - sub\n' }]));
    assert.equal(res.text, `## [Unreleased]\n\n### Added\n- first\n  second\n  - sub\n\n${RELEASED}`);
  });

  it('is not idempotent: splicing the same fragments twice appends them twice, so the caller must delete consumed fragments', () => {
    const compiled = compiledOf([{ issue: 1, slug: 'a', type: 'added', body: '- a\n' }]);
    const once = spliceIntoUnreleased(`## [Unreleased]\n\n${RELEASED}`, compiled);
    const twice = spliceIntoUnreleased(once.text, compiled);
    assert.equal(twice.text, `## [Unreleased]\n\n### Added\n- a\n- a\n\n${RELEASED}`);
  });

  it('returns the text unchanged with ok false when there is no [Unreleased] heading', () => {
    const text = `# Log\n\n${RELEASED}`;
    const res = spliceIntoUnreleased(text, compiledOf([{ issue: 1, slug: 'a', type: 'added', body: '- a\n' }]));
    assert.deepEqual(res, { ok: false, text, added: 0, reason: 'no `## [Unreleased]` heading' });
  });

  it('returns the text unchanged with nothing to add', () => {
    const text = `## [Unreleased]\n\n### Added\n- keep\n\n${RELEASED}`;
    assert.deepEqual(spliceIntoUnreleased(text, compileFragments([])), { ok: true, text, added: 0 });
  });

  it('agrees with version-bump._parseUnreleased on where the block starts and ends', () => {
    const samples = [
      `${HEAD}## [Unreleased]\n\n### Added\n- a\n\n${RELEASED}`,
      '## [Unreleased]\n',
      '## [Unreleased]   \n\n- bare\n\n## Notes\n\ntext\n',
      '# Log\n\n## [Unreleased]\n\n### Fixed\n- f\n\n```\n## quoted inside a fence ends the block for both\n```\n',
      '# Log\n\nno unreleased here\n\n## [1.0.0] - 2026-01-01\n'
    ];
    for (const sample of samples) {
      const lines = sample.split('\n');
      const mine = fragments._internal.findUnreleased(lines);
      const theirs = versionBump._parseUnreleased(sample);
      assert.equal(mine.startIdx, theirs.startIdx, sample);
      if (theirs.ok) assert.equal(mine.endIdx, theirs.endIdx, sample);
    }
  });

  it('pins its block regexes to the literals in version-bump.js (the module requires neither way)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'wrap-steps', 'version-bump.js'), 'utf8');
    const literal = (name) => {
      const m = new RegExp(`^const ${name} = (/.*/[a-z]*);`, 'm').exec(source);
      assert.ok(m, `${name} declared in version-bump.js`);
      return m[1];
    };
    assert.equal(fragments._internal.UNRELEASED_LINE_RE.toString(), literal('UNRELEASED_LINE_RE'));
    assert.equal(fragments._internal.NEXT_HEADING_RE.toString(), literal('NEXT_HEADING_RE'));
    assert.equal(fragments._internal.SUBSECTION_RE.toString(), literal('SUBSECTION_RE'));

    const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'changelog-fragments.js'), 'utf8');
    const requires = [...moduleSource.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort();
    assert.deepEqual(requires, ['./logger', 'node:fs', 'node:path']);
  });
});

describe('changelog-fragments: bump levels as version-bump derives them from spliced text', () => {
  const BASE = '# Log\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Added\n- old\n';

  /** @returns {'patch'|'minor'|'major'} what version-bump decides for these fragments once spliced */
  function levelOf(fragmentList) {
    const spliced = spliceIntoUnreleased(BASE, compileFragments(fragmentList));
    assert.equal(spliced.ok, true);
    return versionBump._decideBumpLevel(versionBump._parseUnreleased(spliced.text), {});
  }

  it('BREAKING: anywhere in a fragment body is major, even under a patch-only subsection', () => {
    assert.equal(levelOf([{ issue: 1, slug: 'a', type: 'fixed', body: '- BREAKING: the flag is gone.\n' }]), 'major');
  });

  it('BREAKING( is major', () => {
    assert.equal(levelOf([{ issue: 1, slug: 'a', type: 'internal', body: '- BREAKING(api): removed.\n' }]), 'major');
  });

  it('a NOT BREAKING — prose fixture does not trigger major', () => {
    assert.equal(levelOf([{ issue: 1, slug: 'a', type: 'fixed', body: '- NOT BREAKING — the old path still works.\n' }]), 'patch');
    assert.equal(levelOf([{ issue: 1, slug: 'a', type: 'added', body: '- NOT BREAKING — new path beside the old.\n' }]), 'minor');
  });

  it('a minor-only set (Added, Changed, Removed, Deprecated) is minor', () => {
    assert.equal(levelOf([
      { issue: 1, slug: 'a', type: 'added', body: '- a\n' },
      { issue: 2, slug: 'c', type: 'changed', body: '- c\n' },
      { issue: 3, slug: 'r', type: 'removed', body: '- r\n' },
      { issue: 4, slug: 'd', type: 'deprecated', body: '- d\n' }
    ]), 'minor');
    for (const type of ['added', 'changed', 'removed', 'deprecated']) {
      assert.equal(levelOf([{ issue: 1, slug: 'x', type, body: '- x\n' }]), 'minor', type);
    }
  });

  it('a patch-only set (Fixed, Security, Internal) is patch', () => {
    assert.equal(levelOf([
      { issue: 1, slug: 'f', type: 'fixed', body: '- f\n' },
      { issue: 2, slug: 's', type: 'security', body: '- s\n' },
      { issue: 3, slug: 'i', type: 'internal', body: '- i\n' }
    ]), 'patch');
    for (const type of ['fixed', 'security', 'internal']) {
      assert.equal(levelOf([{ issue: 1, slug: 'x', type, body: '- x\n' }]), 'patch', type);
    }
  });

  it('a patch fragment beside an existing minor entry stays minor, as the same entries written by hand would', () => {
    const byHand = '# Log\n\n## [Unreleased]\n\n### Added\n- hand-written\n\n### Fixed\n- f\n\n## [1.0.0] - 2026-01-01\n';
    const spliced = spliceIntoUnreleased('# Log\n\n## [Unreleased]\n\n### Added\n- hand-written\n\n## [1.0.0] - 2026-01-01\n',
      compileFragments([{ issue: 1, slug: 'f', type: 'fixed', body: '- f\n' }]));
    assert.equal(spliced.text, byHand);
    const decide = (t) => versionBump._decideBumpLevel(versionBump._parseUnreleased(t), {});
    assert.equal(decide(spliced.text), decide(byHand));
    assert.equal(decide(spliced.text), 'minor');
  });
});

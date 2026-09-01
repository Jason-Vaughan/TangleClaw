'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const engines = require('../lib/engines');

const BEGIN = '<!-- BEGIN:tangleclaw -->';
const END = '<!-- END:tangleclaw -->';
const SHARED_CARRIERS = ['AGENTS.md', 'GEMINI.md', 'CONVENTIONS.md'];

/**
 * The shape this mechanism exists for, taken from a real project rather than
 * invented: CasaJirafa-Website's `AGENTS.md` on 2026-08-31 carried a block that
 * `next dev` writes and re-adds on every run, followed by the operator's own
 * deployment rules. A whole-file write destroyed both — which is the defect
 * under test, so the fixture has to carry both or it measures nothing.
 */
const FOREIGN_FILE = [
  '<!-- BEGIN:nextjs-agent-rules -->',
  '',
  '# This is NOT the Next.js you know',
  '',
  'This block is written and re-added by `next dev`.',
  '',
  '<!-- END:nextjs-agent-rules -->',
  '',
  '# Deployment & Feature Flag Contract',
  '**CRITICAL RULE:** The `main` branch (Production) is strictly **LOCKED**.'
].join('\n');

describe('managed-block merge — preserves what TangleClaw does not own', () => {
  test('appends a block, leaving foreign content byte-identical', () => {
    const { merged, error } = engines._mergeManagedBlock(FOREIGN_FILE, '## TangleClaw\nport 3102', 'markdown');
    assert.equal(error, null);
    // Mutation this catches: dropping the `before` slice, or writing the block
    // as a whole-file replacement. Either loses one of the two foreign owners.
    assert.ok(merged.includes('BEGIN:nextjs-agent-rules'), 'next dev block survived');
    assert.ok(merged.includes('**CRITICAL RULE:** The `main` branch (Production) is strictly **LOCKED**.'), 'operator rules survived');
    assert.ok(merged.startsWith(FOREIGN_FILE.replace(/\s+$/, '')), 'foreign content is unchanged and still leads the file');
    assert.ok(merged.includes(BEGIN) && merged.includes(END), 'our block is delimited');
    assert.ok(merged.includes('port 3102'), 'our content landed');
  });

  test('replaces in place on a second write — no duplicate block, foreign content still intact', () => {
    const first = engines._mergeManagedBlock(FOREIGN_FILE, 'generation one', 'markdown').merged;
    const second = engines._mergeManagedBlock(first, 'generation two', 'markdown').merged;

    // Mutation this catches: appending unconditionally instead of splicing.
    // That is the failure that would accumulate a block per launch forever.
    assert.equal(second.split(BEGIN).length - 1, 1, 'exactly one begin marker after a re-write');
    assert.equal(second.split(END).length - 1, 1, 'exactly one end marker after a re-write');
    assert.ok(!second.includes('generation one'), 'stale generated content is gone');
    assert.ok(second.includes('generation two'), 'fresh generated content is present');
    assert.ok(second.includes('BEGIN:nextjs-agent-rules'), 'next dev block still survives the second pass');
    assert.ok(second.includes('**CRITICAL RULE:**'), 'operator rules still survive the second pass');
  });

  test('preserves content that follows our block, not just content before it', () => {
    const withTrailer = `${BEGIN}\nold\n${END}\n\n## Operator notes added after\nkeep me`;
    const { merged, error } = engines._mergeManagedBlock(withTrailer, 'new', 'markdown');
    assert.equal(error, null);
    // Mutation this catches: slicing to end-of-file instead of to the end
    // marker — a one-character bug that silently eats every later section.
    assert.ok(merged.includes('## Operator notes added after'), 'trailing foreign section survived');
    assert.ok(merged.includes('keep me'));
    assert.ok(merged.includes('new') && !merged.includes('old'));
  });

  test('an empty file gets the block alone', () => {
    const { merged, error } = engines._mergeManagedBlock('', 'body', 'markdown');
    assert.equal(error, null);
    assert.equal(merged, `${BEGIN}\nbody\n${END}\n`);
  });

  test('yaml gets hash-comment markers, not HTML ones', () => {
    const { merged, error } = engines._mergeManagedBlock('existing: true', 'generated: yes', 'yaml');
    assert.equal(error, null);
    // Mutation this catches: hardcoding the markdown comment form. HTML
    // comments inside YAML are a parse error, so the host file would break.
    assert.ok(merged.includes('# BEGIN:tangleclaw'));
    assert.ok(!merged.includes('<!--'));
    assert.ok(merged.includes('existing: true'), 'foreign yaml survived');
  });
});

describe('managed-block merge — refuses rather than guessing', () => {
  test('a begin marker with no end is refused and nothing is merged', () => {
    const broken = `head\n${BEGIN}\norphaned`;
    const { merged, error } = engines._mergeManagedBlock(broken, 'body', 'markdown');
    // Mutation this catches: treating "no valid pair" as "no block" and
    // appending, which would leave two begins and strand the operator's text
    // inside a region we then claim to own.
    assert.equal(merged, null, 'no merged output is produced');
    assert.match(error, /malformed/);
  });

  test('an end marker before its begin is refused', () => {
    const inverted = `${END}\nbody\n${BEGIN}`;
    const { merged, error } = engines._mergeManagedBlock(inverted, 'body', 'markdown');
    assert.equal(merged, null);
    assert.match(error, /precedes/);
  });

  test('duplicated markers are refused rather than partially spliced', () => {
    const doubled = `${BEGIN}\na\n${END}\n${BEGIN}\nb\n${END}`;
    const { merged, error } = engines._mergeManagedBlock(doubled, 'body', 'markdown');
    assert.equal(merged, null);
    assert.match(error, /2 begin/);
  });

  test('a marker literal in the generated body is refused at the door', () => {
    // The body is not ours alone: the generator embeds global-rules.md and whole
    // shared-document bodies verbatim, so an operator's document can contain a
    // marker. Splicing it writes a 2-begin file, which the malformed check then
    // refuses FOREVER — one bad shared doc permanently bricking the config.
    const { merged, error } = engines._mergeManagedBlock(FOREIGN_FILE, `## Rules\nnever write ${END} in a shared doc`, 'markdown');
    assert.equal(merged, null, 'nothing is spliced');
    assert.match(error, /marker literal/);
  });

  test('a poisoned body cannot brick a file that is still writable afterwards', () => {
    assert.equal(engines._mergeManagedBlock(FOREIGN_FILE, `body with ${BEGIN} inside`, 'markdown').merged, null);
    const recovered = engines._mergeManagedBlock(FOREIGN_FILE, 'clean body', 'markdown');
    assert.equal(recovered.error, null, 'a later clean write still succeeds');
    assert.ok(recovered.merged.includes('clean body'));
  });

  test('a top-level heading in the body is demoted so it cannot become a second H1', () => {
    // global-rules.md opens with `# Global Rules` and is pushed verbatim, so
    // demoting only the generator's own header still left an H1 inside the
    // operator's document. Mutation: dropping the body-wide demotion.
    const { merged, error } = engines._mergeManagedBlock('', '# Global Rules\ntext\n# Another', 'markdown');
    assert.equal(error, null);
    assert.ok(!/^# (?!#)/m.test(merged.split(BEGIN)[1] || ''), 'no bare H1 survives inside the block');
    assert.ok(merged.includes('## Global Rules'));
    assert.ok(merged.includes('## Another'), 'every H1 is demoted, not just the first');
  });

  test('yaml bodies are not heading-demoted — # is a comment there, not a heading', () => {
    const { merged, error } = engines._mergeManagedBlock('', '# a yaml comment\nkey: 1', 'yaml');
    assert.equal(error, null);
    assert.ok(merged.includes('# a yaml comment'), 'yaml comments are left alone');
    assert.ok(!merged.includes('## a yaml comment'));
  });

  test('an unknown syntax is refused, never given a guessed comment form', () => {
    const { merged, error } = engines._mergeManagedBlock('x', 'body', 'ini');
    assert.equal(merged, null);
    assert.match(error, /no managed-block comment form/);
  });
});

describe('writeEngineConfig honors mergeStrategy', () => {
  /**
   * Build a throwaway project directory.
   * @param {string} [seed] - Initial config-file contents, if any
   * @returns {{dir: string, file: string}}
   */
  function makeProject(seed) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-managed-block-'));
    const file = path.join(dir, 'AGENTS.md');
    if (seed !== undefined) fs.writeFileSync(file, seed);
    return { dir, file };
  }

  const profile = {
    configFormat: { filename: 'AGENTS.md', syntax: 'markdown', generator: 'antigravity-md', mergeStrategy: 'managed-block' },
    capabilities: { supportsConfigFile: true }
  };

  test('writing into a project that already has a foreign AGENTS.md keeps it', (t) => {
    const { dir, file } = makeProject(FOREIGN_FILE);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const result = engines.writeEngineConfig('antigravity', dir, {}, profile);
    // Never skip on `result.skipped`. A skip here would mean the fixture never
    // reached the subject, and a test that goes green by not running is the
    // failure mode this file exists to prevent — assert the precondition.
    assert.equal(result.skipped, false, `fixture did not reach the write path: ${result.skipReason}`);
    assert.equal(result.error, null, 'write succeeded');
    assert.equal(result.written, true);

    const after = fs.readFileSync(file, 'utf8');
    // This is the regression the chunk exists for: before the managed block,
    // this call replaced the whole file and both foreign owners were lost.
    assert.ok(after.includes('BEGIN:nextjs-agent-rules'), 'next dev block preserved through a real write');
    assert.ok(after.includes('**CRITICAL RULE:**'), 'operator rules preserved through a real write');
    assert.ok(after.includes(BEGIN), 'our block was added');
  });

  test('a malformed marker pair leaves the file untouched and reports an error', (t) => {
    const seed = `${BEGIN}\nno end marker here`;
    const { dir, file } = makeProject(seed);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const result = engines.writeEngineConfig('antigravity', dir, {}, profile);
    assert.equal(result.skipped, false, `fixture did not reach the write path: ${result.skipReason}`);
    assert.equal(result.written, false, 'nothing was written');
    assert.match(result.error, /managed-block merge refused/);
    assert.equal(fs.readFileSync(file, 'utf8'), seed, 'the operator file is byte-identical after a refusal');
  });
});

describe('writeEngineConfig refuses an unknown mergeStrategy', () => {
  test('a typo does not silently fall through to the destructive default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-badstrategy-'));
    const file = path.join(dir, 'ENGINE.md');
    fs.writeFileSync(file, FOREIGN_FILE);
    try {
      // A PRIVATE carrier, deliberately: on a shared-convention filename the
      // stricter guard fires first, which would make this test pass for the
      // wrong reason and stop measuring the unknown-value branch at all.
      const result = engines.writeEngineConfig('antigravity', dir, {}, {
        configFormat: { filename: 'ENGINE.md', syntax: 'markdown', generator: 'antigravity-md', mergeStrategy: 'managed_block' },
        capabilities: { supportsConfigFile: true }
      });
      // Mutation: removing the validation makes 'managed_block' resolve to
      // whole-file and overwrite the operator's file.
      assert.equal(result.written, false);
      assert.match(result.error, /unknown configFormat\.mergeStrategy/);
      assert.equal(fs.readFileSync(file, 'utf8'), FOREIGN_FILE, 'the file is untouched');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('drift is scoped to the region TangleClaw owns', () => {
  const profile = {
    configFormat: { filename: 'AGENTS.md', syntax: 'markdown', generator: 'antigravity-md', mergeStrategy: 'managed-block' },
    capabilities: { supportsConfigFile: true }
  };

  /** @returns {{dir: string, file: string}} */
  function seed(content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-drift-'));
    const file = path.join(dir, 'AGENTS.md');
    if (content !== undefined) fs.writeFileSync(file, content);
    return { dir, file };
  }

  test('a first write into a foreign file is not drift', (t) => {
    const { dir } = seed(FOREIGN_FILE);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const r = engines.writeEngineConfig('antigravity', dir, {}, profile);
    assert.equal(r.skipped, false);
    assert.equal(r.drifted, false, 'there was no prior block to have drifted from');
  });

  test('an identical rewrite is not drift', (t) => {
    const { dir } = seed(FOREIGN_FILE);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    engines.writeEngineConfig('antigravity', dir, {}, profile);
    const second = engines.writeEngineConfig('antigravity', dir, {}, profile);
    assert.equal(second.drifted, false, 'regenerating identical content is not a hand-edit');
  });

  test('a hand-edit BETWEEN the markers is drift', (t) => {
    const { dir, file } = seed(FOREIGN_FILE);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    engines.writeEngineConfig('antigravity', dir, {}, profile);
    const edited = fs.readFileSync(file, 'utf8').replace(BEGIN, `${BEGIN}\nHAND EDIT INSIDE`);
    fs.writeFileSync(file, edited);
    const r = engines.writeEngineConfig('antigravity', dir, {}, profile);
    assert.equal(r.drifted, true, 'edits inside the markers are overwritten and must be reported');
  });

  test('an edit OUTSIDE the markers is NOT drift', (t) => {
    const { dir, file } = seed(FOREIGN_FILE);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    engines.writeEngineConfig('antigravity', dir, {}, profile);
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n\n## Operator added this later\nkeep\n`);
    const r = engines.writeEngineConfig('antigravity', dir, {}, profile);
    // This is the property the region-scoping exists to express. A revert to a
    // whole-file comparison (`existing.trim() !== merged.trim()`) stays green on
    // every other case here and fails only on this one.
    assert.equal(r.drifted, false, 'the operator using their own file is not drift');
    assert.ok(fs.readFileSync(file, 'utf8').includes('## Operator added this later'), 'and their content survives');
  });
});

describe('a shared-convention carrier is refused without managed-block', () => {
  test('an ABSENT mergeStrategy is refused, not defaulted to whole-file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-absent-'));
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, FOREIGN_FILE);
    try {
      // The destructive case a test over `data/engines/*.json` cannot catch:
      // an operator profile in ~/.tangleclaw/engines/ that simply omits the
      // field. Absent is not unknown, so the unknown-value guard misses it.
      const r = engines.writeEngineConfig('antigravity', dir, {}, {
        configFormat: { filename: 'AGENTS.md', syntax: 'markdown', generator: 'antigravity-md' },
        capabilities: { supportsConfigFile: true }
      });
      assert.equal(r.written, false);
      assert.match(r.error, /shared-convention agent file/);
      assert.equal(fs.readFileSync(file, 'utf8'), FOREIGN_FILE, 'the operator file is untouched');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the runtime list and the profile guard agree on what counts as shared', () => {
    // One source of truth: the test used to carry its own copy of this list.
    assert.deepEqual(SHARED_CARRIERS, engines.SHARED_CONVENTION_CARRIERS);
  });
});

describe('heading demotion leaves fenced code alone', () => {
  test('a shell comment inside a fence is not turned into a heading', () => {
    // porthub-guide.md and shared-docs-guide.md are spliced verbatim and carry
    // `# …` shell comments inside fences; a blanket regex rewrote them to `## …`
    // in every generated file.
    const body = ['# Real Heading', '', '```bash', '# Check what is taken', 'curl x', '```', '', '# Another Heading'].join('\n');
    const out = engines._demoteTopLevelHeadings(body);
    assert.ok(out.includes('## Real Heading'), 'prose headings are demoted');
    assert.ok(out.includes('## Another Heading'), 'after a fence closes, demotion resumes');
    assert.ok(out.includes('\n# Check what is taken'), 'the shell comment inside the fence is untouched');
  });
});

describe('engine profiles declare a usable carrier', () => {
  const dir = path.join(__dirname, '..', 'data', 'engines');
  const profiles = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, profile: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));

  test('the roster is non-empty, so the assertions below are not vacuous', () => {
    assert.ok(profiles.length > 0, 'engine profiles were found to check');
  });

  // Runs over EVERY profile, not the one that broke. The defect this chunk
  // fixes reached production because `.antigravity.md` was checked by nothing,
  // and a guard naming only antigravity would leave the next engine equally
  // unchecked.
  for (const { file, profile } of profiles) {
    const cf = profile.configFormat;
    if (!cf || !cf.filename) continue;

    test(`${file}: a managed-block carrier has a syntax we can comment in`, () => {
      if ((cf.mergeStrategy || 'whole-file') !== 'managed-block') return;
      const { merged, error } = engines._mergeManagedBlock('seed', 'body', cf.syntax);
      assert.equal(error, null, `syntax '${cf.syntax}' has no comment form, so the block cannot be written`);
      assert.ok(merged.includes('seed'), 'the merge preserves foreign content for this syntax');
    });

    // A carrier filename that belongs to a shared convention is one other tools
    // and operators also write. Owning the whole file is then a destructive act,
    // so the strategy is not a preference — it is forced by the filename.
    //
    // This assertion reads the SHIPPED profile. The writeEngineConfig tests
    // above pass their own profile literal, so they stay green even if the real
    // antigravity profile is reverted to a whole-file write — which is exactly
    // what a mutation run showed. Without this test the fix is unpinned.
    test(`${file}: a shared-convention carrier is never written whole-file`, () => {
      if (!SHARED_CARRIERS.includes(cf.filename)) return;
      assert.equal(
        cf.mergeStrategy,
        'managed-block',
        `${cf.filename} is a multi-vendor agent file; a whole-file write destroys whatever else owns it`
      );
    });

    test(`${file}: the carrier is a file the engine actually reads`, () => {
      if (profile.id !== 'antigravity') return;
      // Pins the fix itself. Antigravity's own rules.md documents discovery of
      // GEMINI.md / AGENTS.md only; `.antigravity.md` was read by nothing, which
      // is how 8 projects ran with no operational guide and nothing noticed.
      assert.ok(
        ['AGENTS.md', 'GEMINI.md'].includes(cf.filename),
        `antigravity discovers GEMINI.md / AGENTS.md only — '${cf.filename}' would never be read`
      );
      assert.ok(cf.discovery && cf.discovery.source, 'the carrier claim names the upstream doc it was verified against');
    });

    // Required, not optional, wherever getting the filename wrong is
    // DESTRUCTIVE. Shipping this as `if (!cf.discovery) return` let 3 of 4
    // carriers pass unevidenced — an opt-in guard that guards nothing. Engines
    // whose carrier is private to them are tracked separately rather than given
    // invented evidence: a fabricated source is worse than a recorded gap.
    test(`${file}: a destructive-if-wrong carrier carries evidence`, () => {
      const destructiveIfWrong = SHARED_CARRIERS.includes(cf.filename) || cf.mergeStrategy === 'managed-block';
      if (!destructiveIfWrong) return;
      assert.ok(cf.discovery, `${cf.filename} is written into a file others own — the claim that the engine reads it must name where that was verified`);
    });

    test(`${file}: declared carrier evidence is well-formed`, () => {
      if (!cf.discovery) return;
      assert.match(cf.discovery.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, 'verifiedOn is an ISO date');
      assert.ok(!Number.isNaN(Date.parse(cf.discovery.verifiedOn)), 'verifiedOn parses as a real date');
      assert.ok(typeof cf.discovery.source === 'string' && cf.discovery.source.length > 0, 'a source is named');
    });
  }
});

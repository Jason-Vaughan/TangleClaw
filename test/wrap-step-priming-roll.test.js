'use strict';

// Tests for the `priming-roll` wrap step (`next-session-prime`, #139 Chunk 6).
// Covers: pure helpers (`_parseChunks`, `_selectPointer`, `_replaceManagedBlock`,
// `_renderPointerBody`) and the handler (`run`) — plan resolution/disambiguation
// (#226/#302), the chunk-less skip contract (#515), managed-block rolling, and
// staged-write single-transaction discipline.
// Extracted from wrap-pipeline.test.js per TST-4X8N (focused per-submodule suites).

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

describe('wrap-step priming-roll — pure helpers (#139 Chunk 6)', () => {
  const primingRoll = require('../lib/wrap-steps/priming-roll');

  describe('_parseChunks', () => {
    it('extracts id + title from `### Chunk N: Title` headings', () => {
      const md = [
        '# Plan',
        '',
        '### Chunk 1: Discovery',
        'Body line.',
        '',
        '### Chunk 2: Implementation',
        'More body.'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks.length, 2);
      assert.equal(chunks[0].id, '1');
      assert.equal(chunks[0].title, 'Discovery');
      assert.equal(chunks[0].done, false);
      assert.equal(chunks[1].id, '2');
      assert.equal(chunks[1].title, 'Implementation');
    });

    it('marks chunks done when ✅ appears anywhere on the heading line', () => {
      const md = [
        '### Chunk 1: Discovery ✅',
        '### Chunk 2: ✅ Schema migration',
        '### Chunk 3: Build skeleton'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks[0].done, true);
      assert.equal(chunks[0].title, 'Discovery',
        '✅ in title must be stripped from the rendered title');
      assert.equal(chunks[1].done, true);
      assert.equal(chunks[1].title, 'Schema migration');
      assert.equal(chunks[2].done, false);
    });

    it('does NOT mark a chunk done just because ✅ appears in its body', () => {
      const md = [
        '### Chunk 1: Discovery',
        '✅ this is in body but should not promote the chunk',
        '### Chunk 2: Build'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks[0].done, false, 'body-level ✅ must not mark heading done');
      assert.equal(chunks[1].done, false);
    });

    it('parses dotted / lettered sub-chunk ids (e.g. 10c.2)', () => {
      const md = [
        '### Chunk 10: Frontend',
        '### Chunk 10c.2: Sub-step',
        '### Chunk 12.3a.4: Deep nesting'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.deepStrictEqual(chunks.map((c) => c.id), ['10', '10c.2', '12.3a.4']);
    });

    it('captures **Blocked on:** annotations from chunk body', () => {
      const md = [
        '### Chunk 5: Async work',
        'Some prose.',
        '',
        '**Blocked on:** chunk-4 still in review',
        '',
        'More prose.',
        '### Chunk 6: Cleanup'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks[0].blockedOn, 'chunk-4 still in review');
      assert.equal(chunks[1].blockedOn, null);
    });

    it('captures only the first **Blocked on:** per chunk (additional are ignored)', () => {
      const md = [
        '### Chunk 5: Multi-block',
        '**Blocked on:** first reason',
        '**Blocked on:** second reason (must be ignored)'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks[0].blockedOn, 'first reason');
    });

    it('matches **Blocked on:** case-insensitively', () => {
      const md = [
        '### Chunk 5: Lowercase author',
        '**blocked on:** lowercased reason'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks[0].blockedOn, 'lowercased reason');
    });

    it('returns [] on empty / null input', () => {
      assert.deepStrictEqual(primingRoll._parseChunks(''), []);
      assert.deepStrictEqual(primingRoll._parseChunks(null), []);
    });

    it('tolerates `### Chunk N (suffix): Title` headings', () => {
      const md = '### Chunk 12 (optional): Cross-engine parity';
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].id, '12');
      // Title strips the leading separators / colon; the `(optional)`
      // qualifier is part of the title the user can read.
      assert.match(chunks[0].title, /\(optional\): Cross-engine parity/);
    });

    it('parses CRLF-encoded plans byte-equivalent to LF', () => {
      const md = ['### Chunk 1: A ✅', '### Chunk 2: B'].join('\r\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks.length, 2, 'CRLF split must yield both chunks');
      assert.equal(chunks[0].done, true);
      assert.equal(chunks[0].title, 'A',
        'title must not retain a trailing \\r byte');
      assert.equal(chunks[1].id, '2');
    });

    it('skips a `### Chunk` line whose id slot is non-conforming (and only that line)', () => {
      // A typo like `### Chunk Foo: oops` does not match the strict id
      // regex and is silently dropped from the chunk list — but real
      // ids in the same plan must still parse normally.
      const md = [
        '### Chunk Foo: typo with non-numeric id',
        '### Chunk 1: real chunk'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks.length, 1, 'only the well-formed chunk parses');
      assert.equal(chunks[0].id, '1');
    });
  });

  describe('_citedIssues (#1516)', () => {
    it('reads issue field lines, a ## Issues section and closing keywords — not prose', () => {
      const md = [
        '# Plan',
        '**Issues:** [#1139](https://github.com/o/r/issues/1139), #1140',
        '- Tracking issue: **#710**.',
        'Background: #999 shipped last month, and #998 is related.',
        '## Issues',
        '| 01 | #1508, #1509 |',
        '## Plan',
        'Mentions #997 here.',
        '- [ ] PR with `Fixes #1015` and closes #1016',
        '**Issue:** #1140 again'
      ].join('\n');
      assert.deepStrictEqual(primingRoll._citedIssues(md), [1139, 1140, 710, 1508, 1509, 1015, 1016]);
    });

    it('returns [] for a plan with no issue field', () => {
      assert.deepStrictEqual(primingRoll._citedIssues('### Chunk 1: A\nSee #12.\n'), []);
      assert.deepStrictEqual(primingRoll._citedIssues(''), []);
    });
  });

  describe('_selectPointer', () => {
    it('returns the first un-done as current and the next as on-deck', () => {
      const chunks = [
        { id: '1', title: 'A', done: true, blockedOn: null, lineNo: 1 },
        { id: '2', title: 'B', done: true, blockedOn: null, lineNo: 2 },
        { id: '3', title: 'C', done: false, blockedOn: null, lineNo: 3 },
        { id: '4', title: 'D', done: false, blockedOn: null, lineNo: 4 }
      ];
      const p = primingRoll._selectPointer(chunks);
      assert.equal(p.current.id, '3');
      assert.equal(p.next.id, '4');
      assert.equal(p.allDone, false);
    });

    it('sets next=null when the current chunk is the tail', () => {
      const chunks = [
        { id: '1', done: true, title: '', blockedOn: null, lineNo: 1 },
        { id: '2', done: false, title: '', blockedOn: null, lineNo: 2 }
      ];
      const p = primingRoll._selectPointer(chunks);
      assert.equal(p.current.id, '2');
      assert.equal(p.next, null);
    });

    it('reports allDone when every chunk is marked done', () => {
      const chunks = [
        { id: '1', done: true, title: '', blockedOn: null, lineNo: 1 },
        { id: '2', done: true, title: '', blockedOn: null, lineNo: 2 }
      ];
      const p = primingRoll._selectPointer(chunks);
      assert.equal(p.allDone, true);
      assert.equal(p.current, null);
      assert.equal(p.next, null);
    });

    it('returns null current/next on empty input', () => {
      const p = primingRoll._selectPointer([]);
      assert.equal(p.current, null);
      assert.equal(p.next, null);
      assert.equal(p.allDone, false);
    });
  });

  describe('_replaceManagedBlock', () => {
    const begin = primingRoll.BEGIN_MARKER;
    const end = primingRoll.END_MARKER;

    /**
     * Splice and assert the call was allowed, so a refusal can never read as a
     * passing assertion about content.
     * @param {string} prior - Existing priming-file body
     * @param {string} body - Rendered body for the managed block
     * @returns {string} The merged file content
     */
    function splice(prior, body) {
      const { merged, error } = primingRoll._replaceManagedBlock(prior, body);
      assert.equal(error, null, `splice refused: ${error}`);
      return merged;
    }

    it('replaces an existing managed block in place, preserving surrounding text', () => {
      const prior = `Header content\n${begin}\nold body\n${end}\nFooter content`;
      const out = splice(prior, '\nnew body\n');
      assert.match(out, /^Header content\n/);
      assert.match(out, /Footer content$/);
      assert.match(out, /new body/);
      assert.ok(!out.includes('old body'), 'old managed body must be wiped');
    });

    it('appends a fresh managed block when none exists, with a blank line separator', () => {
      const prior = 'Some user prose.\n';
      const out = splice(prior, '\nfresh body\n');
      assert.match(out, /^Some user prose\.\n/);
      assert.ok(out.includes(begin) && out.includes(end));
      assert.match(out, /fresh body/);
    });

    it('appends without leading separator when prior is empty', () => {
      const out = splice('', '\nbody\n');
      assert.ok(out.startsWith(begin), 'empty prior → block at top with no leading whitespace');
    });

    it('repairs out-of-order markers into one block, keeping the text between them', () => {
      // This case used to append a second pair, on the reasoning that slice
      // math over misordered markers would corrupt the file. The goal it was
      // protecting — any user prose between the misordered markers MUST
      // survive — is asserted here and still holds; what changed is that the
      // append was not idempotent, so the next wrap appended AGAIN, one stale
      // block per wrap forever (#1132). The counts below are 1, not 2,
      // deliberately: the repair leaves nothing for a later wrap to duplicate.
      const prior = `${end}\nuser-prose-between\n${begin}\n`;
      const out = splice(prior, '\nbody\n');
      assert.equal(out.split(begin).length - 1, 1);
      assert.equal(out.split(end).length - 1, 1);
      assert.match(out, /user-prose-between/,
        'content between misordered markers is the user\'s and must survive the repair');
      assert.match(out, /body/);
    });

    it('a repaired priming file is byte-identical on the next wrap', () => {
      // The acceptance criterion #1132 was filed for: repeated wraps against a
      // malformed priming file produce a file of constant size. Mutation this
      // catches: a repair that leaves the file still malformed, which would
      // restore the unbounded append one wrap later.
      const prior = `${end}\nuser-prose-between\n${begin}\n`;
      const once = splice(prior, '\nbody\n');
      const twice = splice(once, '\nbody\n');
      assert.equal(twice, once);
      const thrice = splice(twice, '\nbody\n');
      assert.equal(thrice, once, 'stability holds past the first re-run, not just at it');
    });

    it('reports a repair, and reports an ordinary roll as not one', () => {
      // The repair moves bytes outside the block, so `run` has something to
      // warn about and put on the step row. Mutation this catches: hardcoding
      // `repaired` at either value.
      assert.equal(primingRoll._replaceManagedBlock(`${end}\nx\n${begin}`, '\nb\n').repaired, true);
      assert.equal(primingRoll._replaceManagedBlock(`${begin}\nold\n${end}`, '\nb\n').repaired, false);
      assert.equal(primingRoll._replaceManagedBlock('prose\n', '\nb\n').repaired, false);
    });

    it('refuses a duplicated pair rather than editing the first and stranding the rest', () => {
      // Previously this edited the first pair and left the orphan as inert
      // content, pinned so a future find-all-markers pass would be intentional.
      // This is that intent, and it lands on the safe side: an operator who
      // pasted the markers into their own notes owns both pairs, and nothing in
      // the text says which one is ours. Refusing leaves the file untouched.
      const prior =
        `${begin}\nfirst\n${end}\n` +
        `middle\n` +
        `${begin}\nsecond\n${end}\n`;
      const { merged, error } = primingRoll._replaceManagedBlock(prior, '\nrolled\n');
      assert.equal(merged, null, 'the priming file is left exactly as it was');
      assert.match(error, /2 begin, 2 end/);
    });

    it('refuses a body carrying a marker literal rather than writing a boundary the operator never authored', () => {
      // The body embeds chunk titles read out of the operator's plan, so a
      // heading containing a marker would land in the priming file as a real
      // region boundary — and the next wrap would read their prose as ours and
      // delete it. Repair cannot undo that, because the file would LOOK well
      // formed.
      const { merged, error } = primingRoll._replaceManagedBlock(
        'user prose\n', `\n**Active:** Chunk 1 — ${end} in a heading\n`
      );
      assert.equal(merged, null, 'nothing is spliced');
      assert.match(error, /marker literal/);
      assert.match(error, /plan/, 'the refusal names where the literal came from');
    });
  });

  describe('_renderPointerBody', () => {
    it('renders Active + On-deck when both exist', () => {
      const body = primingRoll._renderPointerBody({
        current: { id: '5', title: 'Build it', blockedOn: null },
        next: { id: '6', title: 'Ship it', blockedOn: null },
        allDone: false
      }, '.claude/plans/plan.md');
      assert.match(body, /\*\*Active:\*\* Chunk 5 — Build it/);
      assert.match(body, /\*\*On deck:\*\* Chunk 6 — Ship it/);
      assert.match(body, /Plan: `\.claude\/plans\/plan\.md`/);
    });

    it('surfaces blockedOn on the active chunk', () => {
      const body = primingRoll._renderPointerBody({
        current: { id: '5', title: 'X', blockedOn: 'thing Y' },
        next: null,
        allDone: false
      }, 'plan.md');
      assert.match(body, /\*\*Blocked on:\*\* thing Y/);
      assert.match(body, /Last chunk in this plan/);
    });

    it('renders allDone explicitly', () => {
      const body = primingRoll._renderPointerBody({
        current: null, next: null, allDone: true
      }, 'plan.md');
      assert.match(body, /All chunks in .* are marked done/);
    });

    // NOTE: the "no headings" fallback branch of `_renderPointerBody` was
    // removed (#515) — `run()` now skips before rendering when a plan has
    // zero chunks, so `_selectPointer` can never hand this helper an
    // all-false pointer. Its former direct test went with the branch.
  });
});

describe('wrap-step priming-roll — handler (#139 Chunk 6)', () => {
  const primingRoll = require('../lib/wrap-steps/priming-roll');
  let tmpDir;
  let projectPath;
  let originals;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-wrap-step-priming-'));
    originals = { ...primingRoll._internal };
  });

  after(() => {
    // `_internal` is a module singleton shared with every other suite in
    // this file. The last test here leaves a throwing `readFileSync` stub
    // installed, so without this restore the NEXT suite's `before` captures
    // the poisoned fn as its "originals" and every one of its tests reads
    // through the stub.
    Object.assign(primingRoll._internal, originals);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Fresh sandbox per test so plans/priming don't leak.
    Object.assign(primingRoll._internal, originals);
    projectPath = fs.mkdtempSync(path.join(tmpDir, 'sandbox-'));
  });

  /** Build a minimal context for the priming-roll handler. */
  function buildContext(step, projectOverride) {
    return {
      project: projectOverride || { name: 'sandbox', path: projectPath, id: 1 },
      session: null,
      step,
      previousResults: [],
      staged: {},
      options: {}
    };
  }

  /** Write a plan markdown file into <project>/.tangleclaw/plans/<name>. */
  function writePlan(name, body) {
    const dir = path.join(projectPath, '.tangleclaw', 'plans');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    return p;
  }

  it('blocks when context.project.path is missing', async () => {
    const result = await primingRoll.run(buildContext(
      { id: 'next-session-prime' },
      { name: 'no-path', id: 1 }
    ));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /requires context\.project\.path/);
  });

  it('blocks with a remediation when the plan heading carries a priming-roll marker (#1132)', async () => {
    // The half the operator actually sees. The rendered body embeds the chunk
    // TITLE read out of their plan, so a heading carrying the END literal
    // reaches the splice as a marker in the body — a real producer, not a stub.
    // Splicing it would write a boundary they never authored, after which the
    // next wrap reads their prose as our region and deletes it.
    writePlan('p.md', `## Status\n\n### Chunk 1: Ship ${primingRoll.END_MARKER} it\n\nbody\n`);
    const primingDir = path.join(projectPath, '.claude', 'priming');
    fs.mkdirSync(primingDir, { recursive: true });
    const primingFile = path.join(primingDir, 'build-session.md');
    fs.writeFileSync(primingFile, 'operator prose\n');

    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /refused to write/);
    assert.match(result.blockers[0], /build-session\.md/, 'the blocker names the file');
    assert.match(result.blockers[0], /marker literal/);
    assert.match(result.output.remediation, /chunk heading/i, 'and says what to do about it');
    assert.equal(fs.readFileSync(primingFile, 'utf8'), 'operator prose\n',
      'a refusal stages nothing, so the priming file is untouched');
  });

  it('blocks rather than editing a priming file whose marker counts are ambiguous (#1132)', async () => {
    writePlan('p.md', '## Status\n\n### Chunk 1: Ship it\n\nbody\n');
    const primingDir = path.join(projectPath, '.claude', 'priming');
    fs.mkdirSync(primingDir, { recursive: true });
    const primingFile = path.join(primingDir, 'build-session.md');
    // Their own notes quote the markers, and the real block sits below.
    const seeded =
      `Notes: the roll lives between ${primingRoll.BEGIN_MARKER} and ${primingRoll.END_MARKER}.\n\n`
      + `${primingRoll.BEGIN_MARKER}\nold\n${primingRoll.END_MARKER}\n`;
    fs.writeFileSync(primingFile, seeded);

    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /2 begin, 2 end/);
    assert.equal(fs.readFileSync(primingFile, 'utf8'), seeded, 'their notes are left exactly as written');
  });

  it('reports a repaired priming file on the step row, not just in the log (#1132)', async () => {
    writePlan('p.md', '## Status\n\n### Chunk 1: Ship it\n\nbody\n');
    const primingDir = path.join(projectPath, '.claude', 'priming');
    fs.mkdirSync(primingDir, { recursive: true });
    fs.writeFileSync(
      path.join(primingDir, 'build-session.md'),
      `${primingRoll.END_MARKER}\nstranded\n${primingRoll.BEGIN_MARKER}\n`
    );

    const context = buildContext({ id: 'next-session-prime' });
    const result = await primingRoll.run(context);
    assert.equal(result.status, 'done');
    // Mutation this catches: dropping `repaired` from the output, which would
    // leave a rewrite of the operator's file visible only by diffing it.
    assert.equal(result.output.repaired, true);
    assert.match(context.staged['next-session-prime'].newContent, /stranded/);

    // And an ordinary roll does not claim one.
    fs.writeFileSync(
      path.join(primingDir, 'build-session.md'),
      `${primingRoll.BEGIN_MARKER}\nold\n${primingRoll.END_MARKER}\n`
    );
    const plain = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(plain.output.repaired, false);
  });

  it('skips (not blocks) when no plans directory exists and no step.planPath (#676)', async () => {
    // A project that simply doesn't keep TC build plans is at least as benign
    // as one with an empty plans dir (which already skips, #302). Blocking it
    // rendered a red BLOCKED under a green "Wrap committed" banner on every
    // plan-less project's wrap. Must skip cleanly.
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, true, 'a plan-less project must not block the wrap');
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /No plans directory/);
    assert.match(result.output.reason, /nothing to roll/i);
    assert.deepEqual(result.blockers, []);
  });

  it('still BLOCKS when an explicit step.planPath cannot be resolved (#676 boundary)', async () => {
    // The skip above is only for the no-pointer-configured case. An operator
    // who explicitly pointed at a plan that does not exist gets a real error —
    // a configured-but-broken pointer is a mistake worth surfacing.
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime', planPath: 'plans/does-not-exist.md' }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /planPath does not exist/i);
  });

  it('skips (not blocks) when .tangleclaw/plans is empty (#302)', async () => {
    // An empty active plans dir means "no plan to roll" — same as the
    // all-complete case below. Must skip cleanly, not block the wrap.
    fs.mkdirSync(path.join(projectPath, '.tangleclaw', 'plans'), { recursive: true });
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, true, 'an empty active plans dir must not block the wrap');
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /No \.md plans found/i);
    assert.deepEqual(result.blockers, []);
  });

  it('skips when all plans are archived under .tangleclaw/plans/archive/ (#302 repro)', async () => {
    // The exact reported scenario: every shipped plan has been moved to
    // the archive subdir (per CLAUDE.md's archive rule), leaving the
    // active dir holding only `archive/`. The non-recursive `.md` filter
    // must ignore the subdir's plans, so the step skips rather than
    // mistaking 20 archived plans for active ones.
    const archiveDir = path.join(projectPath, '.tangleclaw', 'plans', 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, 'shipped-a.md'), '### Chunk 1: A ✅\n');
    fs.writeFileSync(path.join(archiveDir, 'shipped-b.md'), '### Chunk 1: B\n'); // undone, but archived
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, true, 'archived plans must not count as active');
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /nothing to roll/i);
  });

  it('blocks when multiple plans are in progress and none can be auto-picked (#226)', async () => {
    // Both plans have an undone chunk → both in-progress → can't disambiguate.
    writePlan('one.md', '### Chunk 1: A\n');
    writePlan('two.md', '### Chunk 1: A\n');
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /Multiple in-progress plans/);
    assert.match(result.blockers[0], /one\.md/);
    assert.match(result.blockers[0], /two\.md/);
    // Blocked output carries operator remediation for the drawer (#223/#226).
    assert.equal(typeof result.output.remediation, 'string');
    assert.match(result.output.remediation, /planPath/);
    assert.match(result.output.remediation, /activePlan/);
    // #428: the candidate filenames are also exposed as structured data for
    // the drawer's inline plan-picker — not just embedded in the blocker string.
    assert.deepStrictEqual(result.output.candidates.slice().sort(), ['one.md', 'two.md']);
  });

  it('does NOT emit output.candidates outside the multi-in-progress case (#428)', async () => {
    // The candidates array is specific to the multi-in-progress block. The
    // no-plans-dir case now skips (#676) and, like any non-multi outcome,
    // carries no candidates array.
    const skip = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(skip.status, 'skipped'); // no plans dir → skip (#676)
    assert.equal(skip.output.candidates, undefined,
      'a non-multi-plan outcome must not carry a candidates array');
  });

  it('auto-picks the single in-progress plan when others are complete (#226)', async () => {
    writePlan('shipped.md', '### Chunk 1: A ✅\n### Chunk 2: B ✅\n');
    writePlan('active.md', '### Chunk 1: A ✅\n### Chunk 2: B\n');
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.match(result.output.planPath, /active\.md$/, 'must resolve to the in-progress plan');
  });

  it('skips (not blocks) when every plan is complete (#226)', async () => {
    writePlan('done-a.md', '### Chunk 1: A ✅\n');
    writePlan('done-b.md', '### Chunk 1: B ✅\n### Chunk 2: C ✅\n');
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, true, 'a finished project must not block its own wrap');
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /No in-progress plan/i);
  });

  it('honors activePlan in .tangleclaw/project.json as the escape hatch (#226)', async () => {
    // Two in-progress plans would otherwise block — activePlan disambiguates.
    writePlan('pick-me.md', '### Chunk 1: A\n');
    writePlan('not-me.md', '### Chunk 1: A\n');
    const tcDir = path.join(projectPath, '.tangleclaw');
    fs.mkdirSync(tcDir, { recursive: true });
    fs.writeFileSync(path.join(tcDir, 'project.json'), JSON.stringify({ activePlan: 'pick-me.md' }));
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.match(result.output.planPath, /pick-me\.md$/);
  });

  it('clears a missing activePlan and falls through to resolution instead of blocking on it (#1757)', async () => {
    // A dangling activePlan no longer blocks by itself — it is cleared as a
    // stale one-shot pin and resolution proceeds as if it had never been
    // set. The genuine ambiguity below it (two in-progress plans) still
    // blocks, but on ITS OWN terms, not the stale pointer's.
    writePlan('one.md', '### Chunk 1: A\n');
    writePlan('two.md', '### Chunk 1: A\n');
    const tcDir = path.join(projectPath, '.tangleclaw');
    fs.mkdirSync(tcDir, { recursive: true });
    const cfg = path.join(tcDir, 'project.json');
    fs.writeFileSync(cfg, JSON.stringify({ activePlan: 'ghost.md', other: 'kept' }));
    const ctx = buildContext({ id: 'next-session-prime' });
    const result = await primingRoll.run(ctx);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /Multiple in-progress plans/);
    assert.equal(result.output.staleActivePlan, 'ghost.md');
    // The clear is STAGED (single-transaction discipline, ADR 0002), not
    // written directly — the handler touches the filesystem only to read.
    assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), { activePlan: 'ghost.md', other: 'kept' },
      'the real file is untouched until the commit step flushes staged writes');
    const staged = ctx.staged['next-session-prime:active-plan-clear'];
    assert.equal(staged.primingPath, cfg);
    assert.deepEqual(JSON.parse(staged.newContent), { other: 'kept' },
      'the staged write clears the pin; every other key is preserved');
  });

  describe('plans whose cited issues are all closed (#1516)', () => {
    /**
     * Install a fake issue lookup; records every call.
     * @param {object|Function} answer - The lookup result, or a function of the numbers
     * @returns {Array<{cwd: string, numbers: number[]}>} calls
     */
    function fakeLookup(answer) {
      const calls = [];
      primingRoll._internal.lookupIssueStates = async (cwd, numbers) => {
        calls.push({ cwd, numbers: [...numbers].sort((a, b) => a - b) });
        return typeof answer === 'function' ? answer(numbers) : answer;
      };
      return calls;
    }

    it('two candidates, one citing only closed issues: the live one is picked and the other reported as an archive candidate', async () => {
      writePlan('train-9.md', '**Issues:** #1416 (addendum), #1417 (store).\n\n### Chunk 1: A\n');
      writePlan('sprint.md', '## Issues\n\n| Chunk | Issues |\n|---|---|\n| 01 | #1508, #1416 |\n\n## Plan\n\n### Chunk 1: A\n');
      const calls = fakeLookup({ available: true, states: { 1416: 'closed', 1417: 'closed', 1508: 'open' } });
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.deepEqual(calls, [{ cwd: projectPath, numbers: [1416, 1417, 1508] }], 'one lookup for every cited issue');
      assert.equal(result.ok, true);
      assert.equal(result.status, 'done', 'exactly one live candidate is used without asking');
      assert.match(result.output.planPath, /sprint\.md$/);
      assert.deepEqual(result.output.archiveCandidates, [{ file: 'train-9.md', issues: [1416, 1417] }]);
      assert.equal(result.output.warning, true, 'the row is flagged for the operator to look at');
      assert.match(result.output.note, /Archive candidate: train-9\.md \(#1416, #1417 closed\)/);
      assert.ok(fs.existsSync(path.join(projectPath, '.tangleclaw', 'plans', 'train-9.md')), 'a warning only — nothing is moved');
    });

    it('two live candidates: the picker still shows, with no archive candidate', async () => {
      writePlan('one.md', '**Issue:** #1\n### Chunk 1: A\n');
      writePlan('two.md', '**Issues:** #2, #3\n### Chunk 1: A\n');
      fakeLookup({ available: true, states: { 1: 'open', 2: 'closed', 3: 'open' } });
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.equal(result.status, 'blocked');
      assert.deepEqual(result.output.candidates.slice().sort(), ['one.md', 'two.md']);
      assert.equal(result.output.archiveCandidates, undefined);
      assert.equal(result.output.warning, undefined);
      assert.equal(result.blockers.length, 1);
    });

    it('three candidates, one shipped: the picker offers only the two still live', async () => {
      writePlan('a.md', '**Issue:** #1\n### Chunk 1: A\n');
      writePlan('b.md', '**Issue:** #2\n### Chunk 1: A\n');
      writePlan('shipped.md', 'Fixes #3\n### Chunk 1: A\n');
      fakeLookup({ available: true, states: { 1: 'open', 2: 'open', 3: 'closed' } });
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.equal(result.status, 'blocked');
      assert.deepEqual(result.output.candidates.slice().sort(), ['a.md', 'b.md']);
      assert.ok(!result.blockers[0].includes('shipped.md'));
      assert.deepEqual(result.output.archiveCandidates.map((a) => a.file), ['shipped.md']);
      assert.match(result.output.note, /shipped\.md/);
    });

    it('every candidate shipped: skips, naming them as archive candidates', async () => {
      writePlan('old-a.md', '**Issue:** #1\n### Chunk 1: A\n');
      writePlan('old-b.md', '**Issue:** #2\n### Chunk 1: A\n');
      fakeLookup({ available: true, states: { 1: 'closed', 2: 'closed' } });
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.equal(result.ok, true);
      assert.equal(result.status, 'skipped');
      assert.match(result.output.reason, /nothing to roll/);
      assert.match(result.output.reason, /old-a\.md.*old-b\.md/);
      assert.equal(result.output.archiveCandidates.length, 2);
    });

    it('ONE in-progress plan, shipped: dropped and skipped — the filter is not only for a picker', async () => {
      // The fix first hung off the multi-candidate branch, so the one-live-plan
      // route rolled a shipped plan with no note: #1516's own bug, surviving on
      // the path the fix had not reached.
      writePlan('shipped.md', '**Issues:** #1, #2\n### Chunk 1: A\n');
      writePlan('finished.md', '### Chunk 1: Done ✅\n');
      fakeLookup({ available: true, states: { 1: 'closed', 2: 'closed' } });
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.equal(result.ok, true);
      assert.equal(result.status, 'skipped');
      assert.deepEqual(result.output.archiveCandidates.map((a) => a.file), ['shipped.md']);
      assert.match(result.output.reason, /every in-progress plan cites only closed issues/);
      assert.ok(fs.existsSync(path.join(projectPath, '.tangleclaw', 'plans', 'shipped.md')), 'a warning only — nothing is moved');
    });

    it('ONE in-progress plan with an open issue is rolled exactly as before', async () => {
      writePlan('live.md', '**Issues:** #1, #2\n### Chunk 1: A\n');
      writePlan('finished.md', '### Chunk 1: Done ✅\n');
      fakeLookup({ available: true, states: { 1: 'closed', 2: 'open' } });
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.equal(result.status, 'done');
      assert.match(result.output.planPath, /live\.md$/);
      assert.equal(result.output.archiveCandidates, undefined);
    });

    it('an operator pointer is rolled as named, never dropped underneath them', async () => {
      writePlan('pinned.md', '**Issues:** #1\n### Chunk 1: A\n');
      const calls = fakeLookup(() => { throw new Error('must not be called'); });
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime', planPath: '.tangleclaw/plans/pinned.md' }));
      assert.equal(result.status, 'done');
      assert.match(result.output.planPath, /pinned\.md$/);
      assert.equal(calls.length, 0, 'a named plan is not second-guessed against GitHub');
    });

    it('gh unavailable: the picker shows every candidate, with the stated reason', async () => {
      writePlan('one.md', '**Issue:** #1\n### Chunk 1: A\n');
      writePlan('two.md', '**Issue:** #2\n### Chunk 1: A\n');
      fakeLookup({ available: false, reason: 'gh is not installed' });
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.equal(result.status, 'blocked');
      assert.deepEqual(result.output.candidates.slice().sort(), ['one.md', 'two.md']);
      assert.match(result.blockers[0], /Multiple in-progress plans/);
      assert.match(result.blockers[1], /gh is not installed/);
      assert.deepEqual(result.output.issueCheck, { state: 'unavailable', reason: 'gh is not installed' });
    });

    it('a plan citing no issues is not "all closed" and stays a candidate; gh is not asked when nothing cites an issue', async () => {
      writePlan('uncited.md', '### Chunk 1: A\nSee #1 in passing prose.\n');
      writePlan('shipped.md', '**Issue:** #2\n### Chunk 1: A\n');
      fakeLookup({ available: true, states: { 2: 'closed' } });
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.equal(result.status, 'done');
      assert.match(result.output.planPath, /uncited\.md$/, 'prose references do not make a plan shipped');

      fs.rmSync(path.join(projectPath, '.tangleclaw', 'plans', 'shipped.md'));
      writePlan('also-uncited.md', '### Chunk 1: A\n');
      const calls = fakeLookup(() => { throw new Error('must not be called'); });
      const blocked = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.equal(blocked.status, 'blocked');
      assert.equal(calls.length, 0, 'no cited issue, no lookup');
      assert.deepEqual(blocked.output.issueCheck, { state: 'not-needed', reason: null });
    });

    it('an issue GitHub does not know keeps its plan a candidate', async () => {
      writePlan('one.md', '**Issues:** #1, #2\n### Chunk 1: A\n');
      writePlan('two.md', '**Issue:** #3\n### Chunk 1: A\n');
      fakeLookup({ available: true, states: { 1: 'closed', 2: 'unknown', 3: 'open' } });
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.equal(result.status, 'blocked');
      assert.equal(result.output.candidates.length, 2);
    });

    it('an activePlan naming a since-archived plan falls through to resolution, says so, and STAGES the stale pin\'s clear (#1757)', async () => {
      writePlan('live.md', '### Chunk 1: A\n');
      writePlan('shipped-done.md', '### Chunk 1: A ✅\n');
      const archive = path.join(projectPath, '.tangleclaw', 'plans', 'archive');
      fs.mkdirSync(archive, { recursive: true });
      fs.writeFileSync(path.join(archive, 'picked-before.md'), '### Chunk 1: A\n');
      const cfg = path.join(projectPath, '.tangleclaw', 'project.json');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, JSON.stringify({ activePlan: 'picked-before.md', other: 'kept' }));
      fakeLookup(() => { throw new Error('no issues cited'); });
      const ctx = buildContext({ id: 'next-session-prime' });
      const result = await primingRoll.run(ctx);
      assert.equal(result.status, 'done');
      assert.match(result.output.planPath, /live\.md$/);
      assert.equal(result.output.staleActivePlan, 'picked-before.md');
      assert.equal(result.output.warning, true);
      assert.match(result.output.note, /activePlan "picked-before\.md".*archived/);
      // #1757 (Required Fix Update) — single-transaction discipline (ADR
      // 0002): the clear is STAGED for the commit step, never written
      // directly. The real file on disk is untouched by this call.
      assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), { activePlan: 'picked-before.md', other: 'kept' });
      const staged = ctx.staged['next-session-prime:active-plan-clear'];
      assert.equal(staged.primingPath, cfg);
      assert.deepEqual(JSON.parse(staged.newContent), { other: 'kept' });
    });

    it('an activePlan whose explicit path (not a bare filename) resolves into archive/ is treated as stale too (#1757)', async () => {
      writePlan('live.md', '### Chunk 1: A\n');
      const archive = path.join(projectPath, '.claude', 'plans', 'archive');
      fs.mkdirSync(archive, { recursive: true });
      fs.writeFileSync(path.join(archive, 'old.md'), '### Chunk 1: A\n');
      const cfg = path.join(projectPath, '.tangleclaw', 'project.json');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, JSON.stringify({ activePlan: '.claude/plans/archive/old.md' }));
      const ctx = buildContext({ id: 'next-session-prime' });
      const result = await primingRoll.run(ctx);
      assert.equal(result.status, 'done');
      assert.match(result.output.planPath, /live\.md$/);
      assert.equal(result.output.staleActivePlan, '.claude/plans/archive/old.md');
      assert.deepEqual(JSON.parse(ctx.staged['next-session-prime:active-plan-clear'].newContent), {});
    });

    it('a one-shot activePlan pin is staged for clearing once the plan it names is fully done', async () => {
      writePlan('finished.md', '### Chunk 1: A ✅\n');
      const cfg = path.join(projectPath, '.tangleclaw', 'project.json');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, JSON.stringify({ activePlan: 'finished.md', other: 'kept' }));
      const ctx = buildContext({ id: 'next-session-prime' });
      const result = await primingRoll.run(ctx);
      assert.equal(result.status, 'done');
      assert.equal(result.output.activePlanCleared, true);
      assert.deepEqual(JSON.parse(ctx.staged['next-session-prime:active-plan-clear'].newContent), { other: 'kept' });
    });

    it('activePlanCleared is false when the pinned plan still has an undone chunk, and nothing is staged', async () => {
      writePlan('live.md', '### Chunk 1: A\n');
      const cfg = path.join(projectPath, '.tangleclaw', 'project.json');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, JSON.stringify({ activePlan: 'live.md' }));
      const ctx = buildContext({ id: 'next-session-prime' });
      const result = await primingRoll.run(ctx);
      assert.equal(result.status, 'done');
      assert.equal(result.output.activePlanCleared, false);
      assert.equal(ctx.staged['next-session-prime:active-plan-clear'], undefined);
      assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), { activePlan: 'live.md' });
    });
  });

  describe('precedence 4 (lone plan) gets the same shipped-plan filter as precedence 5 (#1522)', () => {
    /**
     * Install a fake issue lookup; records every call.
     * @param {object|Function} answer - The lookup result, or a function of the numbers
     * @returns {Array<{cwd: string, numbers: number[]}>} calls
     */
    function fakeLookup(answer) {
      const calls = [];
      primingRoll._internal.lookupIssueStates = async (cwd, numbers) => {
        calls.push({ cwd, numbers: [...numbers].sort((a, b) => a - b) });
        return typeof answer === 'function' ? answer(numbers) : answer;
      };
      return calls;
    }

    it('the lone plan in the dir, all cited issues closed: dropped and skipped as an archive candidate', async () => {
      writePlan('shipped.md', '**Issues:** #1, #2\n### Chunk 1: A\n');
      const calls = fakeLookup({ available: true, states: { 1: 'closed', 2: 'closed' } });
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.deepEqual(calls, [{ cwd: projectPath, numbers: [1, 2] }]);
      assert.equal(result.ok, true);
      assert.equal(result.status, 'skipped');
      assert.deepEqual(result.output.archiveCandidates.map((a) => a.file), ['shipped.md']);
      assert.match(result.output.reason, /every in-progress plan cites only closed issues/);
      assert.ok(fs.existsSync(path.join(projectPath, '.tangleclaw', 'plans', 'shipped.md')), 'a warning only — nothing is moved');
    });

    it('the lone plan with an open cited issue is rolled exactly as before', async () => {
      writePlan('live.md', '**Issues:** #1, #2\n### Chunk 1: A\n');
      fakeLookup({ available: true, states: { 1: 'closed', 2: 'open' } });
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.equal(result.status, 'done');
      assert.match(result.output.planPath, /live\.md$/);
      assert.equal(result.output.archiveCandidates, undefined);
    });

    it('the lone plan citing no issues is rolled with no lookup', async () => {
      writePlan('uncited.md', '### Chunk 1: A\n');
      const calls = fakeLookup(() => { throw new Error('must not be called'); });
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.equal(result.status, 'done');
      assert.match(result.output.planPath, /uncited\.md$/);
      assert.equal(calls.length, 0, 'no cited issue, no lookup');
    });

    it('an explicit step.planPath naming the lone plan is never second-guessed against GitHub', async () => {
      writePlan('pinned.md', '**Issues:** #1\n### Chunk 1: A\n');
      const calls = fakeLookup(() => { throw new Error('must not be called'); });
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime', planPath: '.tangleclaw/plans/pinned.md' }));
      assert.equal(result.status, 'done');
      assert.equal(calls.length, 0);
    });
  });

  it('honors step.planPath when set (project-relative)', async () => {
    fs.mkdirSync(path.join(projectPath, 'custom'), { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, 'custom', 'roadmap.md'),
      '### Chunk 1: Discovery ✅\n### Chunk 2: Build\n'
    );
    const result = await primingRoll.run(buildContext({
      id: 'next-session-prime',
      planPath: 'custom/roadmap.md'
    }));
    assert.equal(result.ok, true);
    assert.equal(result.output.pointer.current.id, '2');
  });

  it('blocks when step.planPath points to a non-existent file', async () => {
    const result = await primingRoll.run(buildContext({
      id: 'next-session-prime',
      planPath: 'does/not/exist.md'
    }));
    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /Configured planPath does not exist/);
  });

  it('blocks when step.planPath resolves inside a plans archive/ directory (#1757)', async () => {
    const archive = path.join(projectPath, '.claude', 'plans', 'archive');
    fs.mkdirSync(archive, { recursive: true });
    fs.writeFileSync(path.join(archive, 'retired.md'), '### Chunk 1: A\n');
    const result = await primingRoll.run(buildContext({
      id: 'next-session-prime',
      planPath: '.claude/plans/archive/retired.md'
    }));
    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /resolves inside an archive\/ directory/);
  });

  it('blocks when project-relative step.planPath escapes the project root', async () => {
    // Defense-in-depth (Critic MINOR): template JSON is server-trusted
    // today, but Chunk 11's default-flip + any future user-editable
    // methodology authoring would expose this. Refuse `../`-style
    // traversal in project-relative paths.
    const result = await primingRoll.run(buildContext({
      id: 'next-session-prime',
      planPath: '../escaped.md'
    }));
    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /resolves outside the project root/);
  });

  it('accepts an absolute step.planPath even outside the project root', async () => {
    // Absolute paths are accepted as-is — the assumption is an author
    // writing an absolute path knows what they're pointing at (e.g. a
    // shared corporate plan archive). The containment check applies
    // only to project-relative paths.
    const sharedPlan = path.join(tmpDir, 'shared-plan.md');
    fs.writeFileSync(sharedPlan, '### Chunk 7: external\n');
    const result = await primingRoll.run(buildContext({
      id: 'next-session-prime',
      planPath: sharedPlan
    }));
    assert.equal(result.ok, true);
    assert.equal(result.output.pointer.current.id, '7');
  });

  it('skips (not blocks) when the single plan has no ### Chunk headings (#515)', async () => {
    // Behavior change (#515): a resolved plan with zero `### Chunk N:`
    // headings is a spec/design doc (or a not-yet-chunked plan) — there is
    // nothing to roll, so the step SKIPS with a reason rather than blocking
    // the whole wrap. Re-specified from the old block assertion because the
    // *contract* changed, not to make code pass: blocking here was
    // asymmetric with the multi-plan path (a chunk-less plan among several
    // is already skipped via `_isPlanInProgress`). Repro of the live
    // 2026-07-09 wrap failure on `continuity-contract.md`.
    writePlan('plan.md', '# Just a header, no chunks here.\n');
    const ctx = buildContext({ id: 'next-session-prime' });
    const result = await primingRoll.run(ctx);
    assert.equal(result.ok, true, 'a chunk-less single plan must not block the wrap');
    assert.equal(result.status, 'skipped');
    assert.deepEqual(result.blockers, []);
    // The skip stays honest — the drawer surfaces why + the recovery hint.
    assert.match(result.output.reason, /declares no chunks/i);
    assert.match(result.output.reason, /### Chunk N:/,
      'reason still names the heading form as one way to chunk the plan');
    assert.match(result.output.reason, /nothing to roll/i);
    // Recovery hint now names BOTH chunk forms — the heading-only wording
    // misdirected an author whose plan tracks chunks in a `## Status` roster.
    assert.match(result.output.reason, /## Status/,
      'reason must also point at the roster form');
    assert.match(result.output.reason, /active build plan/i);
    // No pointer is staged — the "field" is null, nothing for commit to flush.
    assert.equal(ctx.staged['next-session-prime'], undefined,
      'a skip must not stage a priming-roll write');
  });

  it('skip-on-no-chunks is symmetric between the single-plan and multi-plan paths (#515)', async () => {
    // The core of #515: the SAME chunk-less plan must resolve to `skipped`
    // whether it is the only `.md` in the dir or sits among others. Guards
    // against the single-plan branch regressing back to a block while the
    // multi-plan branch skips.
    const chunkless = '# Design notes\n\nProse, no chunks.\n';

    // (a) alone in the dir → single-plan resolve path
    writePlan('solo-spec.md', chunkless);
    const solo = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(solo.status, 'skipped', 'lone chunk-less plan skips');

    // (b) among a completed (chunked, all-done) plan → multi-plan resolve path,
    //     which drops the chunk-less candidate as not-in-progress and finds no
    //     in-progress plan → also skips. Same end state, different branch.
    writePlan('shipped.md', '### Chunk 1: A ✅\n');
    const multi = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(multi.status, 'skipped', 'chunk-less plan among others also skips');
    assert.equal(solo.ok, multi.ok, 'both paths agree on ok=true');
  });

  it('skips (not blocks) when an explicit step.planPath has no ### Chunk headings (#515)', async () => {
    // An explicitly-configured pointer at a chunk-less file is a deliberate
    // visible skip-with-reason, not a hard wrap failure — the operator still
    // sees it in the drawer, but a doc with nothing to roll never halts.
    fs.mkdirSync(path.join(projectPath, 'custom'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'custom', 'spec.md'), '# Spec, no chunks.\n');
    const result = await primingRoll.run(buildContext({
      id: 'next-session-prime',
      planPath: 'custom/spec.md'
    }));
    assert.equal(result.ok, true);
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /custom\/spec\.md/);
    assert.match(result.output.reason, /nothing to roll/i);
  });

  it('rolls a fresh priming file (creates managed block) when none exists', async () => {
    writePlan('plan.md', [
      '### Chunk 1: Discovery ✅',
      '### Chunk 2: Implement',
      '### Chunk 3: Ship'
    ].join('\n'));

    const ctx = buildContext({ id: 'next-session-prime' });
    const result = await primingRoll.run(ctx);

    assert.equal(result.ok, true);
    assert.equal(result.status, 'done');
    assert.equal(result.output.changed, true,
      'priming file did not exist → changed=true');
    assert.equal(result.output.pointer.current.id, '2');
    assert.equal(result.output.pointer.next.id, '3');

    // Single-transaction: real fs must NOT have a priming file yet.
    assert.equal(
      fs.existsSync(path.join(projectPath, '.tangleclaw/priming/build-session.md')),
      false,
      'handler must NOT write to disk — that is the Chunk 9 commit step'
    );

    // Staged shape pinned for commit-step consumption. No existing priming
    // file and no legacy plans dir (#1050 retired resolution from it), so the
    // new priming file goes to the TC-owned default path.
    const stagedEntry = ctx.staged['next-session-prime'];
    assert.ok(stagedEntry, 'must stage under step.id');
    assert.equal(
      stagedEntry.primingPath,
      path.join(projectPath, '.tangleclaw/priming/build-session.md')
    );
    assert.match(stagedEntry.newContent, /TANGLECLAW:PRIMING-ROLL:BEGIN/);
    assert.match(stagedEntry.newContent, /TANGLECLAW:PRIMING-ROLL:END/);
    assert.match(stagedEntry.newContent, /Chunk 2 — Implement/);
  });

  it('replaces an existing managed block while preserving user-authored surround', async () => {
    writePlan('plan.md', [
      '### Chunk 1: A ✅',
      '### Chunk 2: B ✅',
      '### Chunk 3: C'
    ].join('\n'));

    // Pre-seed a priming file with user content + an outdated managed block.
    const primingDir = path.join(projectPath, '.claude/priming');
    fs.mkdirSync(primingDir, { recursive: true });
    const primingPath = path.join(primingDir, 'build-session.md');
    const userTop = '# Build-session priming\n\nUser-authored intro the handler must not touch.\n\n';
    const userBottom = '\n\n## Update history\n- 2026-05-01: initial\n';
    const stalePrior = `${userTop}${primingRoll.BEGIN_MARKER}\nold pointer\n${primingRoll.END_MARKER}${userBottom}`;
    fs.writeFileSync(primingPath, stalePrior);

    const ctx = buildContext({ id: 'next-session-prime' });
    const result = await primingRoll.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.output.changed, true);

    const newContent = ctx.staged['next-session-prime'].newContent;
    assert.match(newContent, /User-authored intro the handler must not touch/,
      'user prose above the managed block must survive byte-for-byte');
    assert.match(newContent, /Update history/,
      'user prose below the managed block must survive byte-for-byte');
    assert.match(newContent, /Chunk 3 — C/, 'new pointer must reflect current chunk');
    assert.ok(!newContent.includes('old pointer'),
      'stale managed-block content must be replaced');
  });

  it('reports changed=false when the rolled content matches existing file exactly', async () => {
    writePlan('plan.md', '### Chunk 1: Solo\n');
    const ctx1 = buildContext({ id: 'next-session-prime' });
    const first = await primingRoll.run(ctx1);
    assert.equal(first.output.changed, true);

    // Simulate the commit step having flushed the staged content to disk.
    const primingPath = ctx1.staged['next-session-prime'].primingPath;
    fs.mkdirSync(path.dirname(primingPath), { recursive: true });
    fs.writeFileSync(primingPath, ctx1.staged['next-session-prime'].newContent);

    // Re-run — same plan, same staged output ⇒ changed=false.
    const ctx2 = buildContext({ id: 'next-session-prime' });
    const second = await primingRoll.run(ctx2);
    assert.equal(second.ok, true);
    assert.equal(second.output.changed, false,
      'idempotent re-roll on unchanged plan must report changed=false');
  });

  it('reports allDone when every chunk is marked done', async () => {
    writePlan('plan.md', [
      '### Chunk 1: A ✅',
      '### Chunk 2: B ✅'
    ].join('\n'));
    const ctx = buildContext({ id: 'next-session-prime' });
    const result = await primingRoll.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.output.pointer.allDone, true);
    assert.equal(result.output.pointer.current, null);
    assert.match(ctx.staged['next-session-prime'].newContent, /marked done/);
  });

  it('carries **Blocked on:** annotations from the active chunk into the rolled pointer', async () => {
    writePlan('plan.md', [
      '### Chunk 1: A ✅',
      '### Chunk 2: B',
      '',
      '**Blocked on:** waiting on dep-X PR review',
      '',
      '### Chunk 3: C'
    ].join('\n'));
    const ctx = buildContext({ id: 'next-session-prime' });
    const result = await primingRoll.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.output.pointer.current.blockedOn, 'waiting on dep-X PR review');
    assert.match(
      ctx.staged['next-session-prime'].newContent,
      /\*\*Blocked on:\*\* waiting on dep-X PR review/
    );
  });

  it('honors step.primingPath when set (project-relative)', async () => {
    writePlan('plan.md', '### Chunk 1: A\n');
    const ctx = buildContext({
      id: 'next-session-prime',
      primingPath: 'docs/custom-priming.md'
    });
    const result = await primingRoll.run(ctx);
    assert.equal(result.ok, true);
    assert.equal(
      result.output.primingPath,
      path.join(projectPath, 'docs/custom-priming.md')
    );
  });

  it('blocks when the plan file read throws', async () => {
    writePlan('plan.md', '### Chunk 1: A\n');
    primingRoll._internal.readFileSync = () => { throw new Error('EACCES'); };
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /Failed to read plan/);
  });

  it('blocks when the priming file read throws (but plan read succeeded)', async () => {
    writePlan('plan.md', '### Chunk 1: A\n');
    const primingDir = path.join(projectPath, '.claude/priming');
    fs.mkdirSync(primingDir, { recursive: true });
    const primingFile = path.join(primingDir, 'build-session.md');
    fs.writeFileSync(primingFile, 'existing\n');

    // Every read succeeds except the priming file's — keyed on path, not call
    // order, so a resolution pass reading the plan more than once (#1522's
    // cited-issues check) does not shift which call this mock means to fail.
    const realRead = originals.readFileSync;
    primingRoll._internal.readFileSync = (p, enc) => {
      if (p === primingFile) throw new Error('disk gone');
      return realRead(p, enc);
    };
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /Failed to read priming file/);
  });
});

describe('wrap-step priming-roll — governed plan pointer (#620)', () => {
  const primingRoll = require('../lib/wrap-steps/priming-roll');
  let tmpDir;
  let projectPath;
  let originals;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-priming-governed-'));
    originals = { ...primingRoll._internal };
  });

  after(() => {
    // Restore the shared `_internal` singleton — see the handler suite's
    // `after` for why leaving a stub installed corrupts later suites.
    Object.assign(primingRoll._internal, originals);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    Object.assign(primingRoll._internal, originals);
    projectPath = fs.mkdtempSync(path.join(tmpDir, 'sandbox-'));
  });

  function buildContext(step) {
    return {
      project: { name: 'sandbox', path: projectPath, id: 1 },
      session: null,
      step,
      previousResults: [],
      staged: {},
      options: {}
    };
  }

  /** Write `.prawduct/project-state.yaml` with the given raw body. */
  function writeState(body) {
    const dir = path.join(projectPath, '.prawduct');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project-state.yaml'), body);
  }

  /** Write a plan under `.prawduct/artifacts/<name>`. */
  function writeGovernedPlan(name, body) {
    const dir = path.join(projectPath, '.prawduct', 'artifacts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }

  /** Write a plan under `.tangleclaw/plans/<name>`. */
  function writePlainPlan(name, body) {
    const dir = path.join(projectPath, '.tangleclaw', 'plans');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }

  describe('_readGovernedPlan', () => {
    it('reads a column-0 active_build_plan value', () => {
      writeState('classification:\n  domain: [x]\n\nactive_build_plan: artifacts/plan.md\n');
      assert.equal(primingRoll._readGovernedPlan(projectPath), 'artifacts/plan.md');
    });

    it('returns null when project-state.yaml is absent', () => {
      assert.equal(primingRoll._readGovernedPlan(projectPath), null);
    });

    it('returns null when the key is absent', () => {
      writeState('classification:\n  domain: [x]\n');
      assert.equal(primingRoll._readGovernedPlan(projectPath), null);
    });

    it('ignores an INDENTED active_build_plan (column-0 contract)', () => {
      // The framework's own reader honours only column 0; matching an
      // indented pointer here would take effect in TC while the framework
      // ignored it — a silent divergence.
      writeState('state:\n  active_build_plan: artifacts/nested.md\n');
      assert.equal(primingRoll._readGovernedPlan(projectPath), null);
    });

    it('treats null / empty / ~ as not declared', () => {
      for (const raw of ['active_build_plan:\n', 'active_build_plan: null\n', 'active_build_plan: ~\n']) {
        writeState(raw);
        assert.equal(primingRoll._readGovernedPlan(projectPath), null, `raw: ${JSON.stringify(raw)}`);
      }
    });

    it('strips surrounding quotes and a trailing inline comment', () => {
      writeState('active_build_plan: "artifacts/quoted.md"  # the active one\n');
      assert.equal(primingRoll._readGovernedPlan(projectPath), 'artifacts/quoted.md');
    });

    it('returns null when the state file is unreadable', () => {
      writeState('active_build_plan: artifacts/plan.md\n');
      primingRoll._internal.readFileSync = () => { throw new Error('disk gone'); };
      assert.equal(primingRoll._readGovernedPlan(projectPath), null);
    });
  });

  describe('resolution precedence', () => {
    it('rolls to the governed plan instead of the lone .tangleclaw/plans file (#620 repro)', async () => {
      // The exact reported failure: an unrelated plan sits in .tangleclaw/plans/
      // and used to win by the "only .md in the dir" rule, priming the next
      // session onto stale work.
      writePlainPlan('unrelated.md', '### Chunk 01 — One-way auto-inject\n');
      writeGovernedPlan('active.md', '### Chunk 08: Clean-room ✅\n### Chunk 09: Phase B discovery\n');
      writeState('active_build_plan: artifacts/active.md\n');

      const ctx = buildContext({ id: 'next-session-prime' });
      const result = await primingRoll.run(ctx);

      assert.equal(result.ok, true);
      assert.equal(result.status, 'done');
      assert.match(result.output.planPath, /\.prawduct[/\\]artifacts[/\\]active\.md$/,
        'must resolve the governed plan, not the .tangleclaw/plans file');
      assert.equal(result.output.pointer.current.id, '09');
      assert.equal(result.output.pointer.current.title, 'Phase B discovery');
      assert.match(ctx.staged['next-session-prime'].newContent, /Chunk 09 — Phase B discovery/);
    });

    it('lets step.planPath outrank the governed pointer', async () => {
      writeGovernedPlan('governed.md', '### Chunk 1: Governed\n');
      writeState('active_build_plan: artifacts/governed.md\n');
      writePlainPlan('explicit.md', '### Chunk 1: Explicit\n');

      const result = await primingRoll.run(buildContext({
        id: 'next-session-prime',
        planPath: '.tangleclaw/plans/explicit.md'
      }));
      assert.equal(result.ok, true);
      assert.equal(result.output.pointer.current.title, 'Explicit');
    });

    it("lets the operator's activePlan escape hatch outrank the governed pointer", async () => {
      // The multi-plan picker (#428) persists the operator's choice to
      // activePlan; an auto-derived pointer must not override a human pick.
      writeGovernedPlan('governed.md', '### Chunk 1: Governed\n');
      writeState('active_build_plan: artifacts/governed.md\n');
      writePlainPlan('picked.md', '### Chunk 1: Picked\n');
      const cfgDir = path.join(projectPath, '.tangleclaw');
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, 'project.json'), JSON.stringify({ activePlan: 'picked.md' }));

      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.equal(result.ok, true);
      assert.equal(result.output.pointer.current.title, 'Picked');
    });

    it('skips (never falls through) when the governed pointer dangles', async () => {
      // Falling back to the plans-dir heuristic here is what produced the
      // confidently-wrong pointer in the first place.
      writePlainPlan('unrelated.md', '### Chunk 1: Unrelated\n');
      writeState('active_build_plan: artifacts/gone.md\n');

      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.equal(result.ok, true, 'a dangling pointer must not block the wrap');
      assert.equal(result.status, 'skipped');
      assert.match(result.output.reason, /does not exist/);
      assert.doesNotMatch(result.output.reason, /unrelated\.md/);
    });

    it('blocks when the governed pointer escapes the project root', async () => {
      writeState('active_build_plan: ../../../etc/passwd.md\n');
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.equal(result.ok, false);
      assert.equal(result.status, 'blocked');
      assert.match(result.blockers[0], /resolves outside the project root/);
    });

    it('falls through to .tangleclaw/plans when no pointer is declared', async () => {
      // Ungoverned projects keep today's behavior byte-for-byte.
      writeState('classification:\n  domain: [x]\n');
      writePlainPlan('only.md', '### Chunk 1: Plain\n');
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.equal(result.ok, true);
      assert.equal(result.output.pointer.current.title, 'Plain');
    });
  });

  describe('chunk title separator (#620)', () => {
    it('strips an em-dash separator so the title renders once', () => {
      const chunks = primingRoll._parseChunks('### Chunk 01 — One-way auto-inject (+ settings scaffold)\n');
      assert.equal(chunks[0].id, '01');
      assert.equal(chunks[0].title, 'One-way auto-inject (+ settings scaffold)');
    });

    it('strips en-dash and hyphen separators too', () => {
      assert.equal(primingRoll._parseChunks('### Chunk 2 – Title\n')[0].title, 'Title');
      assert.equal(primingRoll._parseChunks('### Chunk 3 - Title\n')[0].title, 'Title');
    });

    it('preserves a colon separator and an internal dash', () => {
      assert.equal(primingRoll._parseChunks('### Chunk 4: Auto-inject — the loop\n')[0].title,
        'Auto-inject — the loop');
    });

    it('renders a pointer body without a doubled separator', () => {
      const chunks = primingRoll._parseChunks('### Chunk 01 — One-way auto-inject\n');
      const body = primingRoll._renderPointerBody(primingRoll._selectPointer(chunks), 'p.md');
      assert.match(body, /\*\*Active:\*\* Chunk 01 — One-way auto-inject/);
      assert.doesNotMatch(body, /— —/);
    });
  });
});

describe('wrap-step priming-roll — ## Status roster as done-source (#620)', () => {
  const primingRoll = require('../lib/wrap-steps/priming-roll');

  // Governed plans declare the `## Status` roster their cross-session tracker
  // and leave the `### Chunk NN:` spec anchors un-ticked, so heading-only
  // done-detection reports a finished plan as sitting on chunk 01.
  const GOVERNED_PLAN = [
    '# Build Plan — Phase A',
    '',
    '## Status',
    '',
    '- [x] Chunk 01: recordVersion require-cycle fix',
    '- [x] Chunk 02: Stranded-config guard',
    '- [ ] Chunk 03: Phase B discovery',
    '',
    '## Chunks',
    '',
    '### Chunk 01: recordVersion require-cycle fix (#584) — SHIPPED',
    'Body.',
    '',
    '### Chunk 02: Stranded-config guard (#592) — root-cause + guard',
    'Body.',
    '',
    '### Chunk 03: Phase B discovery',
    'Body.'
  ].join('\n');

  it('marks chunks done from ticked roster boxes even with no ✅ on headings', () => {
    const chunks = primingRoll._parseChunks(GOVERNED_PLAN);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].done, true, 'roster [x] must mark chunk 01 done');
    assert.equal(chunks[1].done, true);
    assert.equal(chunks[2].done, false);
  });

  it('points at the first roster-unticked chunk, not chunk 01 (#620 repro)', () => {
    const pointer = primingRoll._selectPointer(primingRoll._parseChunks(GOVERNED_PLAN));
    assert.equal(pointer.current.id, '03');
    assert.equal(pointer.allDone, false);
  });

  it('reports allDone when every roster box is ticked', () => {
    const md = GOVERNED_PLAN.replace('- [ ] Chunk 03', '- [x] Chunk 03');
    const pointer = primingRoll._selectPointer(primingRoll._parseChunks(md));
    assert.equal(pointer.allDone, true);
    assert.equal(pointer.current, null);
  });

  it('keeps the heading title, not the roster title, when both exist', () => {
    const chunks = primingRoll._parseChunks(GOVERNED_PLAN);
    assert.equal(chunks[0].title, 'recordVersion require-cycle fix (#584) — SHIPPED');
  });

  it('unions the two sources — a ✅ heading stays done with no roster entry', () => {
    // Plans predating the roster convention must not regress.
    const md = [
      '## Status',
      '- [ ] Chunk 02: Later',
      '',
      '## Chunks',
      '### Chunk 01: Early ✅',
      '### Chunk 02: Later'
    ].join('\n');
    const chunks = primingRoll._parseChunks(md);
    assert.equal(chunks[0].done, true, '✅ must still count when the roster omits the chunk');
    assert.equal(chunks[1].done, false);
  });

  it('ignores checkboxes outside the ## Status section', () => {
    const md = [
      '## Notes',
      '- [x] Chunk 01: this is prose, not the tracker',
      '',
      '## Chunks',
      '### Chunk 01: Real chunk'
    ].join('\n');
    assert.equal(primingRoll._parseChunks(md)[0].done, false,
      'only the ## Status roster is the tracker');
  });

  it('stops reading the roster at the next ## heading', () => {
    const md = [
      '## Status',
      '- [x] Chunk 01: Done',
      '',
      '## Appendix',
      '- [x] Chunk 02: not part of the roster',
      '',
      '## Chunks',
      '### Chunk 01: One',
      '### Chunk 02: Two'
    ].join('\n');
    const chunks = primingRoll._parseChunks(md);
    assert.equal(chunks[0].done, true);
    assert.equal(chunks[1].done, false, 'post-Status checkbox must not leak into the roster');
  });

  it('builds the chunk list from a roster-only plan (no ### sections)', () => {
    // The compact format this plan shipped with before spec anchors were added.
    const md = [
      '## Status',
      '- [x] Chunk 01: Shipped work',
      '- [ ] Chunk 02: Next up',
      '',
      '## Why',
      'Prose.'
    ].join('\n');
    const chunks = primingRoll._parseChunks(md);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].title, 'Shipped work');
    const pointer = primingRoll._selectPointer(chunks);
    assert.equal(pointer.current.id, '02');
    assert.equal(pointer.current.title, 'Next up');
  });

  it('parses an em-dash roster item and treats [X] as ticked', () => {
    const md = ['## Status', '- [X] Chunk 01 — Upper-case tick'].join('\n');
    const chunks = primingRoll._parseChunks(md);
    assert.equal(chunks[0].done, true);
    assert.equal(chunks[0].title, 'Upper-case tick');
  });

  it('_parseRoster scopes to ## Status and reports tick state', () => {
    const roster = primingRoll._parseRoster(GOVERNED_PLAN.split('\n'));
    assert.equal(roster.size, 3);
    // Keyed by NORMALIZED id (`01` → `1`) so a padding mismatch between the
    // roster and the headings still joins; the entry keeps the id as written.
    assert.equal(roster.get('1').done, true);
    assert.equal(roster.get('3').done, false);
    assert.equal(roster.get('3').title, 'Phase B discovery');
    assert.equal(roster.get('3').id, '03', 'raw id preserved for display');
  });
});

describe('wrap-step priming-roll — Critic-caught edges (#620)', () => {
  const primingRoll = require('../lib/wrap-steps/priming-roll');
  let tmpDir;
  let projectPath;
  let originals;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-priming-edges-'));
    originals = { ...primingRoll._internal };
  });

  after(() => {
    Object.assign(primingRoll._internal, originals);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    Object.assign(primingRoll._internal, originals);
    projectPath = fs.mkdtempSync(path.join(tmpDir, 'sandbox-'));
  });

  describe('_chunkIdKey — zero-padding mismatch', () => {
    it('normalizes leading zeros per dotted segment', () => {
      assert.equal(primingRoll._chunkIdKey('01'), '1');
      assert.equal(primingRoll._chunkIdKey('1'), '1');
      assert.equal(primingRoll._chunkIdKey('010c.02'), '10c.2');
      assert.equal(primingRoll._chunkIdKey('12.3a.4'), '12.3a.4');
    });

    it('does not collapse a legitimate zero id', () => {
      assert.equal(primingRoll._chunkIdKey('0'), '0');
    });

    it('joins an unpadded roster to padded headings (and vice versa)', () => {
      // A plan writing `- [x] Chunk 1` against `### Chunk 01:` used to miss
      // the lookup, drop the tick, and park the pointer on chunk 01 — the
      // exact silent failure this module exists to prevent.
      const md = [
        '## Status',
        '- [x] Chunk 1: Done',
        '- [ ] Chunk 2: Next',
        '',
        '## Chunks',
        '### Chunk 01: Done',
        '### Chunk 02: Next'
      ].join('\n');
      const chunks = primingRoll._parseChunks(md);
      assert.equal(chunks[0].done, true, 'unpadded roster must tick the padded heading');
      assert.equal(primingRoll._selectPointer(chunks).current.id, '02');
    });

    it('joins a padded roster to unpadded headings', () => {
      const md = [
        '## Status',
        '- [x] Chunk 01: Done',
        '',
        '## Chunks',
        '### Chunk 1: Done'
      ].join('\n');
      assert.equal(primingRoll._parseChunks(md)[0].done, true);
    });

    it('keeps the id as written on a roster-only plan', () => {
      const md = ['## Status', '- [ ] Chunk 07: Seven'].join('\n');
      assert.equal(primingRoll._parseChunks(md)[0].id, '07',
        'the displayed id must match the plan, not the normalized key');
    });
  });

  describe('governed pointer spelled with the .prawduct/ prefix', () => {
    it('resolves without double-prefixing', () => {
      // Documented as `.prawduct/`-relative, but an author may reasonably
      // spell the dir out; double-prefixing would dangle and silently skip.
      const dir = path.join(projectPath, '.prawduct', 'artifacts');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'p.md'), '### Chunk 1: Only\n');
      fs.writeFileSync(
        path.join(projectPath, '.prawduct', 'project-state.yaml'),
        'active_build_plan: .prawduct/artifacts/p.md\n'
      );
      const res = primingRoll._resolvePlanPath(projectPath, { id: 'next-session-prime' });
      assert.equal(res.ok, true, 'a .prawduct/-prefixed pointer must resolve');
      assert.match(res.planPath, /\.prawduct[/\\]artifacts[/\\]p\.md$/);
      assert.doesNotMatch(res.planPath, /\.prawduct[/\\]\.prawduct/);
    });
  });

  describe('skip reason for a chunkless plan', () => {
    it('mentions both the heading and roster forms', async () => {
      // The old reason misdirected a roster-only author toward headings.
      const dir = path.join(projectPath, '.tangleclaw', 'plans');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'spec.md'), '# A design doc\n\nNo chunks here.\n');
      const result = await primingRoll.run({
        project: { name: 'sandbox', path: projectPath, id: 1 },
        session: null,
        step: { id: 'next-session-prime' },
        previousResults: [],
        staged: {},
        options: {}
      });
      assert.equal(result.status, 'skipped');
      assert.match(result.output.reason, /### Chunk N:/);
      assert.match(result.output.reason, /## Status/);
    });
  });
});

describe('wrap-step priming-roll — engine-agnostic path resolution (#612 widened)', () => {
  // Plans and priming files are TangleClaw orchestration state. They used to
  // resolve under `.claude/`, so a project on any other engine silently found
  // no plan and the step reported "nothing to roll" — a failure that looked
  // like success. These pin the TC-owned home as the sole plan-RESOLUTION
  // location (the legacy fallback it once also checked was retired by
  // #1050, once every project it covered was migrated) and the still-live
  // legacy PRIMING-FILE fallback, which is a separate, unretired concern.
  const primingRoll = require('../lib/wrap-steps/priming-roll');

  let tmpDir;
  let projectPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-priming-paths-'));
    projectPath = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Write a plan into an arbitrary plans directory.
   * @param {string} relDir - Project-relative plans directory
   * @param {string} name - Plan filename
   * @param {string} body - Plan markdown
   * @returns {string} Absolute path written
   */
  function writePlanIn(relDir, name, body) {
    const dir = path.join(projectPath, relDir);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    return p;
  }

  const PLAN_BODY = ['### Chunk 1: Done ✅', '### Chunk 2: Active'].join('\n');

  it('names TangleClaw\'s own directory as the default, not any engine\'s', () => {
    // The regression this chunk exists to prevent. If either default points
    // back inside an engine-owned directory, a non-Claude project silently
    // resolves nothing again.
    assert.equal(primingRoll.DEFAULT_PLANS_DIR, '.tangleclaw/plans');
    assert.equal(primingRoll.DEFAULT_PRIMING_PATH, '.tangleclaw/priming/build-session.md');
    assert.doesNotMatch(primingRoll.DEFAULT_PLANS_DIR, /\.claude/);
    assert.doesNotMatch(primingRoll.DEFAULT_PRIMING_PATH, /\.claude/);
  });

  it('resolves a plan from .tangleclaw/plans', () => {
    writePlanIn('.tangleclaw/plans', 'plan.md', PLAN_BODY);
    const resolved = primingRoll._resolvePlansDir(projectPath);
    assert.equal(resolved.relative, '.tangleclaw/plans');
    assert.equal(resolved.legacy, false);
  });

  it('never resolves from legacy .claude/plans, even when it is the only plan anywhere (#1050)', () => {
    // RETIRED (#1050): the 48 plan files this fallback existed for are all
    // migrated. A plan sitting only in the legacy location is now invisible
    // to resolution, not a fallback target.
    writePlanIn('.claude/plans', 'plan.md', PLAN_BODY);
    assert.equal(primingRoll._resolvePlansDir(projectPath), null);
  });

  it('a plan in .claude/plans never shadows or competes with .tangleclaw/plans (#1050)', () => {
    writePlanIn('.claude/plans', 'legacy.md', PLAN_BODY);
    writePlanIn('.tangleclaw/plans', 'current.md', PLAN_BODY);
    const resolved = primingRoll._resolvePlansDir(projectPath);
    assert.equal(resolved.relative, '.tangleclaw/plans');
    assert.equal(resolved.legacy, false);
  });

  it('returns null when neither directory exists', () => {
    assert.equal(primingRoll._resolvePlansDir(projectPath), null);
  });

  it('an EMPTY TangleClaw dir does NOT fall back to legacy plans (#1050)', () => {
    // Inverted from the pre-#1050 contract: resolution used to fall back to a
    // real legacy plan rather than report "nothing to roll" against an empty
    // TC-owned dir. Now there is no fallback, so the empty dir IS the answer.
    fs.mkdirSync(path.join(projectPath, '.tangleclaw/plans'), { recursive: true });
    writePlanIn('.claude/plans', 'real.md', PLAN_BODY);

    const resolved = primingRoll._resolvePlansDir(projectPath);
    assert.equal(resolved.relative, '.tangleclaw/plans');

    const plan = primingRoll._resolvePlanPath(projectPath, {});
    assert.equal(plan.ok, false, 'the legacy plan must NOT be found');
    assert.equal(plan.skip, true);
  });

  it('a NON-empty TangleClaw dir resolves normally regardless of legacy content', () => {
    writePlanIn('.tangleclaw/plans', 'current.md', PLAN_BODY);
    writePlanIn('.claude/plans', 'old.md', PLAN_BODY);
    assert.equal(primingRoll._resolvePlansDir(projectPath).relative, '.tangleclaw/plans');
  });

  it('reports against a real directory when one exists but holds no plans', () => {
    // "No .md plans here" must name a directory that exists, not read as a
    // missing-directory error.
    fs.mkdirSync(path.join(projectPath, '.tangleclaw/plans'), { recursive: true });
    const resolved = primingRoll._resolvePlansDir(projectPath);
    assert.equal(resolved.relative, '.tangleclaw/plans');
    assert.equal(resolved.legacy, false);
  });

  it('ignores a directory holding only non-markdown files, and does NOT fall back to legacy (#1050)', () => {
    fs.mkdirSync(path.join(projectPath, '.tangleclaw/plans'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.tangleclaw/plans/notes.txt'), 'not a plan');
    writePlanIn('.claude/plans', 'real.md', PLAN_BODY);
    assert.equal(primingRoll._resolvePlansDir(projectPath).relative, '.tangleclaw/plans');
    const plan = primingRoll._resolvePlanPath(projectPath, {});
    assert.equal(plan.ok, false, 'the legacy plan must NOT be found');
    assert.equal(plan.skip, true);
    assert.match(plan.reason, /No \.md plans found/);
  });

  it('names only the TC-owned location in the skip reason when no plans directory is found (#676, #1050)', async () => {
    const result = await primingRoll.run({
      project: { path: projectPath },
      step: { id: 'next-session-prime' },
      staged: {}
    });
    // The no-plans-dir case skips (#676), not blocks. Since #1050 the legacy
    // location is no longer a resolution candidate, so the reason names only
    // the TC-owned one, not both homes.
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /\.tangleclaw\/plans/);
    assert.doesNotMatch(result.output.reason, /\.claude\/plans/);
  });

  it('a bare activePlan filename that only exists in the LEGACY dir is treated as missing, cleared, and falls through (#1050, #1757)', () => {
    // The escape hatch no longer checks the legacy dir either (#1050): a
    // plan living only there is as unresolvable as one that was deleted,
    // which routes through #1757's stale-pin handling.
    writePlanIn('.claude/plans', 'chosen.md', PLAN_BODY);
    writePlanIn('.tangleclaw/plans', 'other.md', PLAN_BODY);
    fs.mkdirSync(path.join(projectPath, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, '.tangleclaw', 'project.json'),
      JSON.stringify({ activePlan: 'chosen.md' })
    );
    const resolved = primingRoll._resolvePlanPath(projectPath, {});
    assert.equal(resolved.ok, true);
    assert.equal(resolved.staleActivePlan, 'chosen.md');
    assert.equal(resolved.planPath, path.join(projectPath, '.tangleclaw/plans/other.md'));
  });

  it('sends a NEW priming file to the TangleClaw home', () => {
    assert.equal(
      primingRoll._resolvePrimingPath(projectPath, {}),
      path.join(projectPath, '.tangleclaw/priming/build-session.md')
    );
  });

  it('keeps writing to an EXISTING legacy priming file rather than orphaning it', () => {
    const legacy = path.join(projectPath, '.claude/priming');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'build-session.md'), '# existing\n');
    assert.equal(
      primingRoll._resolvePrimingPath(projectPath, {}),
      path.join(projectPath, '.claude/priming/build-session.md')
    );
  });

  it('a legacy-plans-only project still gets a NEW priming file at the TC-owned home (#1050)', () => {
    // Plan resolution is no longer legacy-aware, so `_resolvePlansDir` never
    // reports `legacy: true` any more — the priming-file home this once
    // followed into the legacy directory now always lands at the default.
    writePlanIn('.claude/plans', 'plan.md', PLAN_BODY);
    assert.equal(
      primingRoll._resolvePrimingPath(projectPath, {}),
      path.join(projectPath, '.tangleclaw/priming/build-session.md')
    );
  });

  it('uses the TangleClaw home when the project has no legacy plans either', () => {
    writePlanIn('.tangleclaw/plans', 'plan.md', PLAN_BODY);
    assert.equal(
      primingRoll._resolvePrimingPath(projectPath, {}),
      path.join(projectPath, '.tangleclaw/priming/build-session.md')
    );
  });

  it('lets an explicit step.primingPath outrank both', () => {
    assert.equal(
      primingRoll._resolvePrimingPath(projectPath, { primingPath: 'custom/prime.md' }),
      path.join(projectPath, 'custom/prime.md')
    );
  });
});

// #1052 — the three plan pointers this step resolves used to hand-roll their
// containment check. They now share `lib/project-paths`' one predicate, and the
// one place they differ from its default (symlinks are not followed) is a
// deliberate policy that nothing else asserted — mutating it left every existing
// case in this file green.
describe('wrap-step priming-roll — plan-pointer containment policy (#1052)', () => {
  const primingRoll = require('../lib/wrap-steps/priming-roll');
  const PLAN_BODY = ['### Chunk 1: Done ✅', '### Chunk 2: Active'].join('\n');

  let tmpDir, projectPath, outsideDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-priming-contain-'));
    projectPath = path.join(tmpDir, 'proj');
    outsideDir = path.join(tmpDir, 'primary');
    fs.mkdirSync(path.join(projectPath, '.prawduct', 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(projectPath, '.tangleclaw', 'priming'), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  /**
   * @param {object} step - Step spec
   * @returns {object} A wrap-step context for `projectPath`
   */
  function ctx(step) {
    return { project: { name: 'contain', path: projectPath, id: 1 }, session: null, step, previousResults: [], staged: {}, options: {} };
  }

  it('accepts a plan reached through a symlink that leaves the project', async () => {
    // The worktree case, and the reason this policy exists: a session working in
    // `git worktree add` symlinks its governance state back to the primary
    // checkout, so `.prawduct/artifacts/build-plan.md` IS a symlink pointing out
    // of the worktree. Following symlinks would refuse every such session's
    // plan pointer as an escape.
    const realPlan = path.join(outsideDir, 'build-plan.md');
    fs.writeFileSync(realPlan, PLAN_BODY);
    fs.symlinkSync(realPlan, path.join(projectPath, '.prawduct', 'artifacts', 'build-plan.md'));
    fs.writeFileSync(path.join(projectPath, '.prawduct', 'project-state.yaml'),
      'active_build_plan: artifacts/build-plan.md\n');

    const result = await primingRoll.run(ctx({ id: 'next-session-prime' }));
    assert.equal(result.ok, true, `expected the symlinked plan to resolve, got: ${JSON.stringify(result.blockers || result)}`);
  });

  it('still refuses a lexical escape, symlinks or not', async () => {
    fs.writeFileSync(path.join(outsideDir, 'escaped.md'), PLAN_BODY);
    const result = await primingRoll.run(ctx({ id: 'next-session-prime', planPath: '../primary/escaped.md' }));
    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /resolves outside the project root/);
  });

  it('refuses a pointer that resolves to the project root, and says THAT', async () => {
    // A plan pointer names a file, and the root is never one. The hand-rolled
    // check counted it as inside, so this reached a read of a directory instead
    // of a blocker that says what is wrong. The message matters as much as the
    // refusal: telling an operator their path "resolves outside the project
    // root" when it resolved TO the root sends them hunting for an escape that
    // is not there.
    fs.writeFileSync(path.join(projectPath, '.tangleclaw', 'project.json'),
      JSON.stringify({ activePlan: 'plans/..' }));
    const result = await primingRoll.run(ctx({ id: 'next-session-prime' }));
    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /resolves to the project root itself/);
    assert.doesNotMatch(result.blockers[0], /resolves outside/);
  });
});

// #2320 — the priming file is tracked and shared by every checkout, and the
// roll is written from whichever plan one checkout holds. A project that works
// under a coordinator must leave it alone and say why.
describe('wrap-step priming-roll — a coordinated project is not rolled (#2320)', () => {
  const primingRoll = require('../lib/wrap-steps/priming-roll');
  const mergeAuthority = require('../lib/merge-authority');
  const { initRepo } = require('./_temp-repo');
  const { execFileSync } = require('node:child_process');

  const PLAN = '# Lane plan\n\n### Chunk 1: First ✅\n\n### Chunk 2: Second\n\n### Chunk 3: Third\n';
  const PRIMING = '# Priming\n\nShared text every lane reads.\n';
  const GITHUB = 'https://github.com/acme/widgets.git';

  let tmpDir, projectPath, primingPath, originals, authorityOriginals, execCalls;

  before(() => {
    originals = { ...primingRoll._internal };
    authorityOriginals = { ...mergeAuthority._internal };
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-priming-lane-'));
    projectPath = path.join(tmpDir, 'lane');
    fs.mkdirSync(path.join(projectPath, '.tangleclaw', 'plans'), { recursive: true });
    fs.mkdirSync(path.join(projectPath, '.tangleclaw', 'priming'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.tangleclaw', 'plans', 'lane-plan.md'), PLAN);
    primingPath = path.join(projectPath, '.tangleclaw', 'priming', 'build-session.md');
    fs.writeFileSync(primingPath, PRIMING);
    execCalls = [];
    // No merge queue unless a test makes one: the store behind the real lookup
    // is not this file's to open.
    mergeAuthority._internal.findActiveQueue = () => null;
    mergeAuthority._internal.getProject = () => null;
    answerGit({ remote: GITHUB, branch: 'main' });
  });

  afterEach(() => {
    Object.assign(primingRoll._internal, originals);
    Object.assign(mergeAuthority._internal, authorityOriginals);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Answer the step's two git reads; a null value is a read that failed.
   * @param {{remote: string|null, branch: string|null}} said - What git says
   * @returns {void}
   */
  function answerGit(said) {
    primingRoll._internal.exec = async (file, args) => {
      execCalls.push([file, ...args].join(' '));
      const value = args[0] === 'remote' ? said.remote : said.branch;
      return value === null
        ? { exitCode: 1, stdout: '', stderr: 'fatal', error: 'exit 1', timedOut: false }
        : { exitCode: 0, stdout: `${value}\n`, stderr: '', error: null, timedOut: false };
    };
  }

  /**
   * Write the project's settings file.
   * @param {string} text - The file's whole content
   * @returns {void}
   */
  function settings(text) {
    fs.writeFileSync(path.join(projectPath, '.tangleclaw', 'project.json'), text);
  }

  /**
   * Run the step on the lane project.
   * @param {string} [name='lane-a'] - The project's name
   * @returns {Promise<{result: object, staged: object}>}
   */
  async function roll(name = 'lane-a') {
    const context = {
      project: { name, path: projectPath, id: 900001 },
      session: null, step: { id: 'next-session-prime' }, previousResults: [], staged: {}, options: {}
    };
    return { result: await primingRoll.run(context), staged: context.staged };
  }

  /**
   * Assert the step skipped, staged nothing and left the priming file alone.
   * @param {{result: object, staged: object}} ran - What `roll` returned
   * @returns {object} The step's output
   */
  function assertNotRolled({ result, staged }) {
    assert.equal(result.ok, true, 'a skipped roll never fails the wrap');
    assert.equal(result.status, 'skipped');
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(staged, {}, 'nothing is staged for the commit step to write');
    assert.equal(fs.readFileSync(primingPath, 'utf8'), PRIMING, 'the priming file is byte-identical');
    assert.equal(result.output.detail, result.output.reason, 'the drawer prints a skipped row\'s detail');
    assert.match(result.output.reason, /the shared priming file is not rewritten from one checkout's plan/);
    return result.output;
  }

  it('skips, names the coordinator and stages nothing when the settings name one', async () => {
    settings(JSON.stringify({ workloadNudge: { coordinatorProject: 'lane-int' } }));
    const output = assertNotRolled(await roll());
    assert.deepEqual(output.mergeAuthority, { authority: 'integrator', integrator: 'lane-int', source: 'coordinator' });
    // The row is cut to one line in the wrap drawer, so the name comes first.
    assert.match(output.reason, /^Works under lane-int, the coordinator this project's settings name, so /);
    assert.match(output.reason, /belongs in the handoff/);
    assert.deepEqual(execCalls, ['git remote get-url origin', 'git symbolic-ref --short -q HEAD'],
      'the answer is keyed on the repository and the branch the wrap fired from');
  });

  it('rolls exactly as before, and reads no git, when the settings name no coordinator', async () => {
    // The same project with the coordinator removed: proof the skip above is
    // the guard's doing and not a fixture that could never roll.
    settings(JSON.stringify({ workloadNudge: { enabled: true } }));
    primingRoll._internal.exec = async () => { throw new Error('a project that decides for itself must run no git command here'); };
    const { result, staged } = await roll();
    assert.equal(result.status, 'done');
    assert.equal(result.output.changed, true);
    assert.equal(result.output.pointer.current.id, '2');
    assert.match(staged['next-session-prime'].newContent, /\*\*Active:\*\* Chunk 2 — Second/);
    assert.equal(result.output.mergeAuthority, undefined);
  });

  it('rolls when there is no settings file at all', async () => {
    primingRoll._internal.exec = async () => { throw new Error('no git read is expected'); };
    const { result } = await roll();
    assert.equal(result.status, 'done');
  });

  it('is asked before any plan is resolved: plans that would block the step do not block a lane wrap', async () => {
    settings(JSON.stringify({ workloadNudge: { coordinatorProject: 'lane-int' } }));
    fs.writeFileSync(path.join(projectPath, '.tangleclaw', 'plans', 'second-plan.md'), PLAN);
    primingRoll._internal.lookupIssueStates = async () => { throw new Error('no plan is examined in a coordinated project'); };
    assertNotRolled(await roll());

    // Without the coordinator the same two in-progress plans block, as they always did.
    settings('{}');
    const { result } = await roll();
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /Multiple in-progress plans/);
  });

  it('skips with its own sentence when the project is the coordinator itself', async () => {
    settings(JSON.stringify({ workloadNudge: { coordinatorProject: 'lane-int' } }));
    const output = assertNotRolled(await roll('lane-int'));
    assert.match(output.reason, /^lane-int coordinates a lane, so the shared priming file is not rewritten/);
    assert.doesNotMatch(output.reason, /works under/i);
  });

  it('skips and says what could not be read when the settings file is not readable JSON', async () => {
    settings('{ "workloadNudge": { "coordinatorProject": "lane-');
    const output = assertNotRolled(await roll());
    assert.equal(output.mergeAuthority.authority, 'unknown');
    assert.match(output.reason, /^Coordinator not established \(this project's settings \(\.tangleclaw\/project\.json\) could not be read\), so /);
    assert.match(output.reason, /until it can be\.$/);
  });

  it('skips when the coordinator setting is not a project name', async () => {
    settings(JSON.stringify({ workloadNudge: { coordinatorProject: '   ' } }));
    const output = assertNotRolled(await roll());
    assert.equal(output.mergeAuthority.authority, 'unknown');
  });

  for (const [what, said, expected] of [
    ['the remote cannot be read', { remote: null, branch: 'main' }, /the repository could not be named/],
    ['the remote is not a github.com repository', { remote: '/srv/git/widgets.git', branch: 'main' }, /the repository could not be named/],
    ['HEAD is detached', { remote: GITHUB, branch: null }, /the base branch is not known/]
  ]) {
    it(`skips as unknown, and still stages nothing, when ${what}`, async () => {
      settings(JSON.stringify({ workloadNudge: { coordinatorProject: 'lane-int' } }));
      answerGit(said);
      const output = assertNotRolled(await roll());
      assert.equal(output.mergeAuthority.authority, 'unknown');
      assert.match(output.reason, expected);
      assert.match(output.reason, /its settings name lane-int as coordinator/);
    });
  }

  it('passes the repository and the branch to the question, so a merge queue is looked up for them', async () => {
    settings(JSON.stringify({ workloadNudge: { coordinatorProject: 'lane-int' } }));
    answerGit({ remote: 'git@github.com:acme/widgets.git', branch: 'release/9' });
    const asked = [];
    mergeAuthority._internal.findActiveQueue = (repo, baseBranch) => {
      asked.push([repo, baseBranch]);
      return { ownerProjectId: 900002 };
    };
    mergeAuthority._internal.getProject = (id) => (id === 900002 ? { id, name: 'someone-else' } : null);
    const output = assertNotRolled(await roll());
    assert.deepEqual(asked, [['acme/widgets', 'release/9']]);
    assert.equal(output.mergeAuthority.authority, 'unknown', 'a queue owned by another project is a disagreement, not a go-ahead');
    assert.match(output.reason, /is owned by someone-else/);
  });

  it('reads a real repository through its own git seam: the remote, the branch, and a detached HEAD', async () => {
    // The seam's real half. Everything above answers git by hand, so nothing
    // else here would notice the two commands being wrong for a real checkout.
    Object.assign(primingRoll._internal, { exec: originals.exec });
    settings(JSON.stringify({ workloadNudge: { coordinatorProject: 'lane-int' } }));
    const git = (...args) => execFileSync('git', args, { cwd: projectPath, encoding: 'utf8' }).trim();
    initRepo(projectPath, ['--initial-branch=trunk']);
    git('config', 'user.email', 'lane@example.invalid');
    git('config', 'user.name', 'Lane');
    git('config', 'commit.gpgsign', 'false');
    git('remote', 'add', 'origin', GITHUB);
    git('add', '-A');
    git('commit', '-m', 'first');

    const asked = [];
    mergeAuthority._internal.findActiveQueue = (repo, baseBranch) => { asked.push([repo, baseBranch]); return null; };
    const onBranch = assertNotRolled(await roll());
    assert.deepEqual(asked, [['acme/widgets', 'trunk']]);
    assert.equal(onBranch.mergeAuthority.authority, 'integrator');

    git('checkout', '--detach', '-q');
    const detached = assertNotRolled(await roll());
    assert.equal(detached.mergeAuthority.authority, 'unknown', 'a detached HEAD names no base branch; it is not a branch called HEAD');
    assert.match(detached.reason, /the base branch is not known/);
    assert.equal(asked.length, 1, 'no queue is looked up without a base branch');
  });
});

'use strict';

// Tests for the `priming-roll` wrap step (`next-session-prime`, #139 Chunk 6).
// Covers: pure helpers (`_parseChunks`, `_selectPointer`, `_replaceManagedBlock`,
// `_renderPointerBody`) and the handler (`run`) — plan resolution/disambiguation
// (#226/#302), the chunk-less skip contract (#515), managed-block rolling, and
// staged-write single-transaction discipline.
// Extracted from wrap-pipeline.test.js per TST-4X8N (focused per-submodule suites).

const { describe, it, before, after, beforeEach } = require('node:test');
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

    it('replaces an existing managed block in place, preserving surrounding text', () => {
      const prior = `Header content\n${begin}\nold body\n${end}\nFooter content`;
      const out = primingRoll._replaceManagedBlock(prior, '\nnew body\n');
      assert.match(out, /^Header content\n/);
      assert.match(out, /Footer content$/);
      assert.match(out, /new body/);
      assert.ok(!out.includes('old body'), 'old managed body must be wiped');
    });

    it('appends a fresh managed block when none exists, with a blank line separator', () => {
      const prior = 'Some user prose.\n';
      const out = primingRoll._replaceManagedBlock(prior, '\nfresh body\n');
      assert.match(out, /^Some user prose\.\n/);
      assert.ok(out.includes(begin) && out.includes(end));
      assert.match(out, /fresh body/);
    });

    it('appends without leading separator when prior is empty', () => {
      const out = primingRoll._replaceManagedBlock('', '\nbody\n');
      assert.ok(out.startsWith(begin), 'empty prior → block at top with no leading whitespace');
    });

    it('treats out-of-order markers as "no managed block" and appends', () => {
      // If END appears before BEGIN, slice math would corrupt the file —
      // the implementation defensively treats it as a fresh-append case.
      // Any user prose between the misordered markers MUST survive.
      const prior = `${end}\nuser-prose-between\n${begin}\n`;
      const out = primingRoll._replaceManagedBlock(prior, '\nbody\n');
      // Original BEGIN/END count: 1 each. After append: 2 each.
      const beginCount = out.split(begin).length - 1;
      const endCount = out.split(end).length - 1;
      assert.equal(beginCount, 2);
      assert.equal(endCount, 2);
      assert.match(out, /user-prose-between/,
        'defensive append must not destroy user content sitting between misordered markers');
    });

    it('with multiple BEGIN/END pairs, edits only the first pair (leaves orphans untouched)', () => {
      // Documented behavior: indexOf finds the first marker of each
      // kind. A duplicated managed block (e.g. user copy-pasted) leaves
      // the orphan second pair as inert content rather than corrupting
      // anything. Worth pinning so a future "find all markers" refactor
      // is intentional, not accidental.
      const prior =
        `${begin}\nfirst\n${end}\n` +
        `middle\n` +
        `${begin}\nsecond\n${end}\n`;
      const out = primingRoll._replaceManagedBlock(prior, '\nrolled\n');
      assert.match(out, /rolled/);
      assert.ok(!out.includes('first'),
        'first managed-block body must be replaced');
      assert.match(out, /second/,
        'orphan second block remains as inert content (pin for intentionality)');
      assert.match(out, /middle/, 'prose between pairs survives');
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

  /** Write a plan markdown file into <project>/.claude/plans/<name>. */
  function writePlan(name, body) {
    const dir = path.join(projectPath, '.claude', 'plans');
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

  it('blocks when no .claude/plans directory exists and no step.planPath', async () => {
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /No plans directory/);
  });

  it('skips (not blocks) when .claude/plans is empty (#302)', async () => {
    // An empty active plans dir means "no plan to roll" — same as the
    // all-complete case below. Must skip cleanly, not block the wrap.
    fs.mkdirSync(path.join(projectPath, '.claude', 'plans'), { recursive: true });
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, true, 'an empty active plans dir must not block the wrap');
    assert.equal(result.status, 'skipped');
    assert.match(result.output.reason, /No \.md plans found/i);
    assert.deepEqual(result.blockers, []);
  });

  it('skips when all plans are archived under .claude/plans/archive/ (#302 repro)', async () => {
    // The exact reported scenario: every shipped plan has been moved to
    // the archive subdir (per CLAUDE.md's archive rule), leaving the
    // active dir holding only `archive/`. The non-recursive `.md` filter
    // must ignore the subdir's plans, so the step skips rather than
    // mistaking 20 archived plans for active ones.
    const archiveDir = path.join(projectPath, '.claude', 'plans', 'archive');
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

  it('does NOT emit output.candidates for a single-plan/skip block (#428)', async () => {
    // The candidates array is specific to the multi-in-progress case. A
    // chunk-less single plan skips (no block, no candidates); the
    // no-plans-dir case blocks WITHOUT candidates.
    const skip = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(skip.status, 'blocked'); // no .claude/plans dir → blocked
    assert.equal(skip.output.candidates, undefined,
      'a non-multi-plan block must not carry a candidates array');
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

  it('blocks with remediation when activePlan points at a missing file (#226)', async () => {
    writePlan('one.md', '### Chunk 1: A\n');
    writePlan('two.md', '### Chunk 1: A\n');
    const tcDir = path.join(projectPath, '.tangleclaw');
    fs.mkdirSync(tcDir, { recursive: true });
    fs.writeFileSync(path.join(tcDir, 'project.json'), JSON.stringify({ activePlan: 'ghost.md' }));
    const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers[0], /activePlan "ghost\.md".*does not exist/);
    assert.match(result.output.remediation, /activePlan/);
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
    assert.match(result.output.reason, /no `### Chunk N:` headings/i);
    assert.match(result.output.reason, /nothing to roll/i);
    assert.match(result.output.reason, /add chunk headings/i);
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
      fs.existsSync(path.join(projectPath, '.claude/priming/build-session.md')),
      false,
      'handler must NOT write to disk — that is the Chunk 9 commit step'
    );

    // Staged shape pinned for commit-step consumption.
    const stagedEntry = ctx.staged['next-session-prime'];
    assert.ok(stagedEntry, 'must stage under step.id');
    assert.equal(
      stagedEntry.primingPath,
      path.join(projectPath, '.claude/priming/build-session.md')
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
    fs.writeFileSync(path.join(primingDir, 'build-session.md'), 'existing\n');

    // First read (plan) succeeds; second read (priming) throws.
    let calls = 0;
    const realRead = originals.readFileSync;
    primingRoll._internal.readFileSync = (p, enc) => {
      calls++;
      if (calls === 1) return realRead(p, enc);
      throw new Error('disk gone');
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

  /** Write a plan under `.claude/plans/<name>`. */
  function writeLegacyPlan(name, body) {
    const dir = path.join(projectPath, '.claude', 'plans');
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
    it('rolls to the governed plan instead of the lone .claude/plans file (#620 repro)', async () => {
      // The exact reported failure: an unrelated plan sits in .claude/plans/
      // and used to win by the "only .md in the dir" rule, priming the next
      // session onto stale work.
      writeLegacyPlan('unrelated.md', '### Chunk 01 — One-way auto-inject\n');
      writeGovernedPlan('active.md', '### Chunk 08: Habitat clean-room ✅\n### Chunk 09: Phase B discovery\n');
      writeState('active_build_plan: artifacts/active.md\n');

      const ctx = buildContext({ id: 'next-session-prime' });
      const result = await primingRoll.run(ctx);

      assert.equal(result.ok, true);
      assert.equal(result.status, 'done');
      assert.match(result.output.planPath, /\.prawduct[/\\]artifacts[/\\]active\.md$/,
        'must resolve the governed plan, not the .claude/plans file');
      assert.equal(result.output.pointer.current.id, '09');
      assert.equal(result.output.pointer.current.title, 'Phase B discovery');
      assert.match(ctx.staged['next-session-prime'].newContent, /Chunk 09 — Phase B discovery/);
    });

    it('lets step.planPath outrank the governed pointer', async () => {
      writeGovernedPlan('governed.md', '### Chunk 1: Governed\n');
      writeState('active_build_plan: artifacts/governed.md\n');
      writeLegacyPlan('explicit.md', '### Chunk 1: Explicit\n');

      const result = await primingRoll.run(buildContext({
        id: 'next-session-prime',
        planPath: '.claude/plans/explicit.md'
      }));
      assert.equal(result.ok, true);
      assert.equal(result.output.pointer.current.title, 'Explicit');
    });

    it("lets the operator's activePlan escape hatch outrank the governed pointer", async () => {
      // The multi-plan picker (#428) persists the operator's choice to
      // activePlan; an auto-derived pointer must not override a human pick.
      writeGovernedPlan('governed.md', '### Chunk 1: Governed\n');
      writeState('active_build_plan: artifacts/governed.md\n');
      writeLegacyPlan('picked.md', '### Chunk 1: Picked\n');
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
      writeLegacyPlan('unrelated.md', '### Chunk 1: Unrelated\n');
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

    it('falls through to .claude/plans when no pointer is declared', async () => {
      // Ungoverned projects keep today's behavior byte-for-byte.
      writeState('classification:\n  domain: [x]\n');
      writeLegacyPlan('only.md', '### Chunk 1: Legacy\n');
      const result = await primingRoll.run(buildContext({ id: 'next-session-prime' }));
      assert.equal(result.ok, true);
      assert.equal(result.output.pointer.current.title, 'Legacy');
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
    assert.equal(roster.get('01').done, true);
    assert.equal(roster.get('03').done, false);
    assert.equal(roster.get('03').title, 'Phase B discovery');
  });
});

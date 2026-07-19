'use strict';

/**
 * The wrap path must not require one engine's capabilities (#612, widened).
 *
 * TangleClaw orchestrates several engines, so no wrap feature may be built on a
 * single engine's file layout or UI behavior. Two shapes of coupling had shipped:
 * runtime path defaults that resolved inside Claude Code's `.claude/` directory
 * (a non-Claude project silently found no plan and the step reported "nothing to
 * roll" — a failure that looked like success), and bundled prompts naming
 * `CLAUDE.md` or Claude's TUI to every engine.
 *
 * These are guard tests: they fail if either shape returns. Lives in its own
 * file because it initializes the store singleton — sharing a suite file would
 * let base-path setup leak across suites.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('wrap path is engine-agnostic (#612 widened)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-engine-agnostic-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('{engineConfigFile} prompt token', () => {
    const aiContent = require('../lib/wrap-steps/ai-content');

    it('substitutes the project engine\'s own config filename', () => {
      const out = aiContent._interpolatePrompt(
        'Skim {engineConfigFile} for conventions.', [], { engineId: 'claude' }
      );
      assert.equal(out, 'Skim CLAUDE.md for conventions.');
    });

    it('resolves a DIFFERENT filename per engine — the whole point of the token', () => {
      const render = (engineId) => aiContent._interpolatePrompt('read {engineConfigFile}', [], { engineId });
      assert.equal(render('codex'), 'read .codex.yaml');
      assert.equal(render('aider'), 'read .aider.conf.yml');
      assert.equal(render('antigravity'), 'read .antigravity.md');
      assert.notEqual(render('codex'), render('claude'));
    });

    it('strips the openclaw connection suffix before resolving', () => {
      // openclaw declares no config file, so the generic phrase is correct —
      // naming another engine's file is exactly what this token prevents.
      const out = aiContent._interpolatePrompt('read {engineConfigFile}', [], { engineId: 'openclaw:abc-123' });
      assert.doesNotMatch(out, /CLAUDE\.md|\.codex\.yaml/);
      assert.match(out, /configuration file/);
    });

    it('degrades to a generic phrase rather than naming a wrong file', () => {
      for (const project of [undefined, {}, { engineId: 'not-a-real-engine' }]) {
        const out = aiContent._interpolatePrompt('read {engineConfigFile}', [], project);
        assert.match(out, /configuration file/);
        assert.doesNotMatch(out, /CLAUDE\.md/);
        assert.ok(!out.includes('{engineConfigFile}'), 'token must not leak through');
      }
    });

    it('leaves the existing {previousMemoryBlock} token working alongside it', () => {
      const out = aiContent._interpolatePrompt(
        '{previousMemoryBlock} then {engineConfigFile}',
        [{ stepId: 'memory-update', status: 'done', output: { capturedText: 'MEM' } }],
        { engineId: 'claude' }
      );
      assert.equal(out, 'MEM then CLAUDE.md');
    });
  });

  describe('bundled prompts name no engine-specific file or UI', () => {
    const TEMPLATE_PATH = path.join(__dirname, '..', 'data', 'templates', 'prawduct', 'template.json');

    /**
     * Every prompt string shipped in the bundled template, with its step id.
     * @returns {Array<{id: string, prompt: string}>}
     */
    function bundledPrompts() {
      const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
      // `wrap_pipeline` is snake_case in the template schema.
      const steps = (template.wrap_pipeline && template.wrap_pipeline.steps) || [];
      return steps.filter((s) => typeof s.prompt === 'string').map((s) => ({ id: s.id, prompt: s.prompt }));
    }

    it('finds prompts to check (guard against a silently empty assertion)', () => {
      assert.ok(bundledPrompts().length > 0, 'no prompts found — this suite would pass vacuously');
    });

    it('no prompt names a specific engine config file', () => {
      // The filenames TC models per engine. A prompt naming any of them
      // literally is telling every OTHER engine to read a file it lacks.
      const engineFiles = store.engines.list()
        .map((e) => e.configFormat && e.configFormat.filename)
        .filter(Boolean);
      assert.ok(engineFiles.includes('CLAUDE.md'), 'precondition: engine profiles carry config filenames');

      for (const { id, prompt } of bundledPrompts()) {
        for (const filename of engineFiles) {
          assert.ok(
            !prompt.includes(filename),
            `step "${id}" names ${filename} literally — use the {engineConfigFile} token instead`
          );
        }
      }
    });

    it('no prompt attributes UI behavior to a named engine', () => {
      // The captureFile mechanism is engine-neutral and stays; only the
      // explanation was Claude-specific. Rendering markdown is a property of
      // rich TUIs generally, so the prose must not name one product.
      for (const { id, prompt } of bundledPrompts()) {
        assert.doesNotMatch(
          prompt, /Claude Code TUI/i,
          `step "${id}" attributes TUI rendering to a named engine — describe the behavior, not the product`
        );
      }
    });
  });

  describe('runtime path defaults are TangleClaw-owned', () => {
    const primingRoll = require('../lib/wrap-steps/priming-roll');

    it('priming-roll resolves no default inside an engine directory', () => {
      // The highest-severity coupling: path resolution fails SILENTLY, so a
      // non-Claude project reported "nothing to roll" rather than an error.
      for (const value of [primingRoll.DEFAULT_PLANS_DIR, primingRoll.DEFAULT_PRIMING_PATH]) {
        assert.doesNotMatch(value, /\.claude/, `${value} still resolves inside an engine's directory`);
        assert.match(value, /^\.tangleclaw\//, `${value} must live under TangleClaw's own directory`);
      }
    });

    it('keeps the legacy location readable so pre-move projects still resolve', () => {
      assert.equal(primingRoll.LEGACY_PLANS_DIR, '.claude/plans');
      assert.equal(primingRoll.LEGACY_PRIMING_PATH, '.claude/priming/build-session.md');
    });
  });

  describe('transcript capture degrades honestly per engine', () => {
    const transcript = require('../lib/transcript');

    it('every engine TC ships has an adapter, so none falls through to Claude\'s layout', () => {
      // Transcript capture reads the ENGINE'S OWN files, so unlike the paths
      // above there is no neutral location to move to. The correct shape is an
      // adapter per engine with an honest null — which is what must not regress
      // into a bare `~/.claude` lookup for everyone.
      for (const engine of store.engines.list()) {
        const key = transcript._normalizeHarness(engine.id);
        assert.ok(
          Object.prototype.hasOwnProperty.call(transcript.ADAPTERS, key),
          `engine ${engine.id} (harness "${key}") has no transcript adapter — it would silently get another engine's layout`
        );
      }
    });

    it('only the claude adapter resolves a location; the rest skip rather than guess', () => {
      const resolving = Object.entries(transcript.ADAPTERS)
        .filter(([, a]) => a.resolve('/tmp/nonexistent-project', {}) !== null)
        .map(([k]) => k);
      // If a non-claude adapter ever starts resolving, it must resolve ITS OWN
      // layout — this pins that none silently inherits Claude's.
      assert.deepEqual(resolving, [], 'no adapter should resolve a transcript for a nonexistent project');
    });
  });
});

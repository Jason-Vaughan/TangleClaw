'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const skills = require('../lib/skills');

describe('skills', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-skills-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadSkills', () => {
    it('loads session-wrap skill from methodology template', () => {
      // prawduct template has wrap config
      const result = skills.loadSkills('prawduct');
      assert.equal(result.error, null);
      assert.ok(result.skills.length > 0);

      const wrapSkill = result.skills.find((s) => s.id === 'session-wrap');
      assert.ok(wrapSkill);
      assert.equal(wrapSkill.type, 'lifecycle');
      assert.ok(wrapSkill.config.steps);
    });

    it('loads action skills from methodology template', () => {
      const result = skills.loadSkills('prawduct');
      const actionSkills = result.skills.filter((s) => s.type === 'action');
      // prawduct has "Mark Critic Run" action (renamed in #230)
      assert.ok(actionSkills.length > 0);
    });

    it('returns error for unknown methodology', () => {
      const result = skills.loadSkills('nonexistent');
      assert.ok(result.error.includes('not found'));
      assert.deepEqual(result.skills, []);
    });

    it('loads skills from minimal template', () => {
      const result = skills.loadSkills('minimal');
      assert.equal(result.error, null);
      // minimal may or may not have wrap config
    });
  });

  describe('getWrapSkill', () => {
    it('returns wrap config for prawduct', () => {
      const wrap = skills.getWrapSkill('prawduct');
      assert.ok(wrap);
      assert.ok(Array.isArray(wrap.steps));
      assert.ok(Array.isArray(wrap.captureFields));
    });

    it('returns null for unknown methodology', () => {
      const wrap = skills.getWrapSkill('nonexistent');
      assert.equal(wrap, null);
    });

    // #139 Chunk 2 — behavior preservation. The shim must produce the same
    // legacy `{command, steps, captureFields}` shape that `lib/sessions.js:
    // triggerWrap` consumed before the schema migration. If this snapshot
    // changes, the wrap NL prompt sent to the AI engine changes — that's a
    // user-visible regression masquerading as a refactor.
    //
    // Pins the two bundled templates (prawduct + minimal).
    it('synthesizes legacy shape from wrap_pipeline (post-C2 step list for prawduct)', () => {
      // #139 Chunk 11c added `open-pr-check` + `critic-check` to prawduct's
      // wrap_pipeline.steps[]. CC-1 appended `continuity-write` after
      // `commit` (writes the hot continuity index the next prime reads).
      // C2 (#353) stripped the L3 `critic-check` step (governance moved to the
      // V2 plugin). PIDX slice 3 (#360) added `project-map` after `features-toc`;
      // PIDX #426 added `index-describe` after `project-map`.
      // The shim flattens every step.id into the legacy steps array, so the
      // surface order here reflects the template-level edits.
      assert.deepStrictEqual(skills.getWrapSkill('prawduct'), {
        command: null,
        steps: ['open-pr-check', 'version-bump', 'changelog-update', 'learnings-capture', 'learnings-db-write', 'next-session-prime', 'features-toc', 'project-map', 'index-describe', 'memory-update', 'commit', 'continuity-write'],
        captureFields: ['summary', 'nextSteps', 'learnings']
      });
      assert.deepStrictEqual(skills.getWrapSkill('minimal'), {
        command: null,
        steps: ['learnings-capture', 'memory-update', 'commit'],
        captureFields: ['summary']
      });
    });
  });

  describe('wrapShapeFromTemplate (#139 Chunk 2)', () => {
    it('synthesizes legacy shape from wrap_pipeline (steps map from id; captureFields flatten/union)', () => {
      const result = skills.wrapShapeFromTemplate({
        wrap_pipeline: {
          schemaVersion: '1.0',
          steps: [
            { id: 'version-bump', kind: 'version-bump' },
            { id: 'memory-update', kind: 'ai-content', captureFields: ['summary', 'nextSteps'] },
            { id: 'summary-derive', kind: 'ai-content', captureFields: ['learnings', 'summary'] },
            { id: 'commit', kind: 'commit' }
          ]
        }
      });
      assert.deepStrictEqual(result, {
        command: null,
        steps: ['version-bump', 'memory-update', 'summary-derive', 'commit'],
        // Union across all steps' captureFields; deduped; order = first-seen.
        captureFields: ['summary', 'nextSteps', 'learnings']
      });
    });

    it('falls back to legacy wrap block when wrap_pipeline is absent (back-compat for pre-migrated installs)', () => {
      const result = skills.wrapShapeFromTemplate({
        wrap: { command: null, steps: ['a', 'b'], captureFields: ['x'] }
      });
      assert.deepStrictEqual(result, {
        command: null,
        steps: ['a', 'b'],
        captureFields: ['x']
      });
    });

    it('preserves a non-null command from legacy wrap block', () => {
      const result = skills.wrapShapeFromTemplate({
        wrap: { command: 'custom-wrap', steps: [], captureFields: [] }
      });
      assert.equal(result.command, 'custom-wrap');
    });

    it('prefers wrap_pipeline over wrap when both are present', () => {
      const result = skills.wrapShapeFromTemplate({
        wrap_pipeline: { steps: [{ id: 'new-step', kind: 'commit' }] },
        wrap: { command: null, steps: ['old-step'], captureFields: [] }
      });
      assert.deepStrictEqual(result.steps, ['new-step']);
    });

    it('returns null for template with neither wrap nor wrap_pipeline', () => {
      assert.equal(skills.wrapShapeFromTemplate({ id: 'whatever' }), null);
    });

    it('returns null for null/undefined input', () => {
      assert.equal(skills.wrapShapeFromTemplate(null), null);
      assert.equal(skills.wrapShapeFromTemplate(undefined), null);
    });

    it('skips steps without an id (defensive — malformed entries do not crash the shim)', () => {
      const result = skills.wrapShapeFromTemplate({
        wrap_pipeline: {
          steps: [
            { id: 'good', kind: 'commit' },
            { kind: 'ai-content' }, // no id
            null,                    // null entry
            { id: 42, kind: 'ai-content' } // non-string id
          ]
        }
      });
      assert.deepStrictEqual(result.steps, ['good']);
    });
  });

  describe('getProjectSkills', () => {
    it('returns error for unknown project', () => {
      const result = skills.getProjectSkills('nonexistent');
      assert.ok(result.error.includes('not found'));
    });

    it('returns skills for registered project', () => {
      const projDir = path.join(tmpDir, 'skill-proj');
      fs.mkdirSync(projDir, { recursive: true });

      store.projects.create({
        name: 'skill-proj',
        path: projDir,
        methodology: 'prawduct'
      });

      const result = skills.getProjectSkills('skill-proj');
      assert.equal(result.error, null);
      assert.ok(result.skills.length > 0);
    });
  });
});

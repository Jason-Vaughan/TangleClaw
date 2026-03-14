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
      // prawduct has "Run Critic" action
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

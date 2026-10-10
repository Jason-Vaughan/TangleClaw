'use strict';

/**
 * The per-project `workloadNudge` setting (#2262): how it reads, and what a
 * save will and will not store.
 *
 * The setting decides whether TangleClaw types a line into a session's pane,
 * so the reader's failure direction is the property that matters: nothing a
 * project file can contain by accident turns the nudge on. And the save and
 * the reader share one judgement of each value, so a value that saves cleanly
 * is never one the reader then throws away.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const projectConfig = require('../lib/project-config');
const workload = require('../lib/workload');

const { resolveWorkloadNudge, workloadNudgeProblem } = projectConfig;

describe('resolveWorkloadNudge (#2262)', () => {
  it('is off, with the default line, nobody named and a ten minute wait, for a project that sets nothing', () => {
    const expected = {
      enabled: false, text: null, coordinatorProject: null, escalateAfterMinutes: 10, escalateAfterMs: 600_000,
      sources: { enabled: 'default', text: 'default', coordinatorProject: 'default', escalateAfterMinutes: 'default' },
      warnings: []
    };
    assert.equal(projectConfig.DEFAULT_PROJECT_CONFIG.workloadNudge, null,
      'null, so a settings save writes no opinion into a project that never chose one');
    for (const config of [null, undefined, {}, { workloadNudge: null }, { workloadNudge: {} }]) {
      assert.deepEqual(resolveWorkloadNudge(config), expected, JSON.stringify(config));
    }
  });

  it('takes each good value and says it came from the project', () => {
    const resolved = resolveWorkloadNudge({
      workloadNudge: { enabled: true, text: 'Report your workload now.', coordinatorProject: 'TC Lane INT', escalateAfterMinutes: 2.5 }
    });
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.text, 'Report your workload now.');
    assert.equal(resolved.coordinatorProject, 'TC Lane INT');
    assert.equal(resolved.escalateAfterMinutes, 2.5);
    assert.equal(resolved.escalateAfterMs, 150_000);
    assert.deepEqual(resolved.sources,
      { enabled: 'workloadNudge', text: 'workloadNudge', coordinatorProject: 'workloadNudge', escalateAfterMinutes: 'workloadNudge' });
    assert.deepEqual(resolved.warnings, []);
  });

  it('keeps the settings a partial block names and defaults the rest', () => {
    const resolved = resolveWorkloadNudge({ workloadNudge: { enabled: true } });
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.text, null);
    assert.equal(resolved.escalateAfterMinutes, 10);
    assert.deepEqual(resolved.sources,
      { enabled: 'workloadNudge', text: 'default', coordinatorProject: 'default', escalateAfterMinutes: 'default' });
  });

  it('never reads an unreadable enabled as on', () => {
    for (const bad of ['true', 'yes', 1, 'on', [], {}, null]) {
      const resolved = resolveWorkloadNudge({ workloadNudge: { enabled: bad } });
      assert.equal(resolved.enabled, false, JSON.stringify(bad));
      assert.equal(resolved.sources.enabled, 'invalid');
      assert.match(resolved.warnings[0], /^workloadNudge\.enabled \(.+\) must be true or false; using false$/);
    }
  });

  it('ignores a block that is not an object, and stays off', () => {
    for (const bad of [true, 'on', 1, [{ enabled: true }]]) {
      const resolved = resolveWorkloadNudge({ workloadNudge: bad });
      assert.equal(resolved.enabled, false, JSON.stringify(bad));
      assert.equal(resolved.sources.enabled, 'default');
      assert.equal(resolved.warnings.length, 1);
      assert.match(resolved.warnings[0], /is not an object; the nudge stays off$/);
    }
    const line = resolveWorkloadNudge({ workloadNudge: 'Report your workload, secretly.' });
    assert.equal(line.warnings[0], 'workloadNudge (a string of 31 characters) is not an object; the nudge stays off',
      'a block that is a bare string is described, not copied into a warning that will be logged');
  });

  it('falls back on one bad value and keeps what the others said', () => {
    const resolved = resolveWorkloadNudge({
      workloadNudge: { enabled: true, text: 'line one\nline two', coordinatorProject: ' padded ', escalateAfterMinutes: 500 }
    });
    assert.equal(resolved.enabled, true, 'a bad line does not switch the nudge off; the default line is used');
    assert.equal(resolved.text, null);
    assert.equal(resolved.coordinatorProject, null);
    assert.equal(resolved.escalateAfterMinutes, 10);
    assert.equal(resolved.escalateAfterMs, 600_000);
    assert.deepEqual(resolved.sources,
      { enabled: 'workloadNudge', text: 'invalid', coordinatorProject: 'invalid', escalateAfterMinutes: 'invalid' });
    assert.equal(resolved.warnings.length, 3);
    assert.match(resolved.warnings[2], /workloadNudge\.escalateAfterMinutes \(500\) must be a number of minutes between 2 and 120; using 10/);
  });

  it('names a refused value in its warning without repeating it', () => {
    const resolved = resolveWorkloadNudge({ workloadNudge: { text: 'secret\u001b[31mline', coordinatorProject: 'two\nlines' } });
    const all = resolved.warnings.join('\n');
    assert.ok(!all.includes('secret'), 'the refused line is not copied into a warning that will be logged');
    assert.ok(!all.includes('\u001b'));
    assert.ok(!all.includes('two\nlines'));
    assert.match(resolved.warnings[0], /^workloadNudge\.text \(a string of 15 characters\) must be null or one line/);
  });

  it('says so when the block carries a key that is not a setting, and still reads the rest', () => {
    const resolved = resolveWorkloadNudge({ workloadNudge: { enabled: true, enabeld: true, nudgeBudget: 3 } });
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.warnings.length, 1);
    assert.match(resolved.warnings[0], /has a key that is not a setting and is ignored; it takes enabled, text, coordinatorProject, escalateAfterMinutes/);
  });
});

describe('workloadNudgeProblem (#2262)', () => {
  it('accepts the edges of each range and refuses one step past them', () => {
    assert.equal(workloadNudgeProblem('escalateAfterMinutes', 2), null);
    assert.equal(workloadNudgeProblem('escalateAfterMinutes', 120), null);
    for (const bad of [1.99, 120.01, 0, -5, NaN, Infinity, '10', null]) {
      assert.match(workloadNudgeProblem('escalateAfterMinutes', bad), /between 2 and 120/, String(bad));
    }
    assert.equal(workloadNudgeProblem('text', 'x'.repeat(2000)), null);
    assert.match(workloadNudgeProblem('text', 'x'.repeat(2001)), /at most 2000 characters/);
    assert.equal(workloadNudgeProblem('coordinatorProject', 'p'.repeat(255)), null);
    assert.match(workloadNudgeProblem('coordinatorProject', 'p'.repeat(256)), /at most 255 characters/);
  });

  it('refuses a line that is not one line of visible text', () => {
    for (const bad of ['', '   ', 'a\nb', 'a\tb', 'a\rb', 'a b', 'zero​width', 'bell\u0007', 42, {}, ['line']]) {
      assert.ok(workloadNudgeProblem('text', bad), JSON.stringify(bad));
    }
    assert.equal(workloadNudgeProblem('text', null), null, 'null is the default line');
    assert.equal(workloadNudgeProblem('text', 'Écrivez votre rapport — maintenant.'), null);
  });

  it('refuses a coordinator that could not be a project name', () => {
    for (const bad of ['', ' ', ' lead', 'lead ', 'two\nlines', 7, true, {}]) {
      assert.ok(workloadNudgeProblem('coordinatorProject', bad), JSON.stringify(bad));
    }
    assert.equal(workloadNudgeProblem('coordinatorProject', null), null, 'null names nobody');
    assert.equal(workloadNudgeProblem('coordinatorProject', 'My Coordinator'), null, 'a project name may contain a space');
  });

  it('refuses a key that is not a setting', () => {
    assert.equal(workloadNudgeProblem('budget', 1), 'is not a workloadNudge setting');
  });

  it('judges a line of text exactly as a workload summary is judged', () => {
    // `lib/project-config.js` cannot import `lib/workload.js`, so the character
    // classes are written in both. This is what stops them drifting apart.
    const samples = [
      'plain', 'two words', '', ' ', '\t', 'a\tb', 'a\nb', 'a\r\nb', 'nul\u0000', 'del\u007f', 'c1\u0085',
      'zwsp​', 'zwj‍', 'bom﻿', 'rtl‮', 'soft­hyphen', 'ls ', 'ps ',
      'tag\u{e0041}', 'vs️', '́', 'é', 'café', '日本語', '😀', '—', '1', '.', ' ', 'a b',
      'word⁠joiner', 'hangulㅤfiller', 'mongolian᠎vowel'
    ];
    for (const sample of samples) {
      assert.equal(projectConfig.isSafeLineText(sample), workload.isSafeText(sample), JSON.stringify(sample));
    }
    assert.equal(projectConfig.isSafeLineText(undefined), false);
    assert.equal(projectConfig.isSafeLineText(5), false);
  });
});

describe('saving workloadNudge through updateProject (#2262)', () => {
  let tmpDir;
  let projectsDir;
  let projects;
  let seq = 0;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-nudge-settings-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    projects = require('../lib/projects');
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A fresh project, optionally with a `workloadNudge` value already in its file.
   * @param {unknown} [stored] - The stored value; omitted leaves the default
   * @returns {{name: string, dir: string}}
   */
  function makeProject(stored) {
    const name = `nudge-${++seq}`;
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    store.projects.create({ name, path: dir, engine: 'claude' });
    const cfg = JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG));
    cfg.engine = 'claude';
    if (stored !== undefined) cfg.workloadNudge = stored;
    store.projectConfig.save(dir, cfg);
    return { name, dir };
  }

  /**
   * What the project's file holds for the setting.
   * @param {string} dir - Project directory
   * @returns {unknown}
   */
  const stored = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.tangleclaw', 'project.json'), 'utf8')).workloadNudge;

  it('leaves a project that never set it at null through an unrelated save', async () => {
    const { name, dir } = makeProject();
    const r = await projects.updateProject(name, { medusaWake: true });
    assert.ok(r.project);
    assert.equal(stored(dir), null);
  });

  it('stores a full block, and it reads back as saved', async () => {
    const { name, dir } = makeProject();
    const block = { enabled: true, text: 'Report your workload.', coordinatorProject: 'lead', escalateAfterMinutes: 15 };
    const r = await projects.updateProject(name, { workloadNudge: block });
    assert.ok(r.project, JSON.stringify(r.errors));
    assert.deepEqual(stored(dir), block);
    const resolved = resolveWorkloadNudge(store.projectConfig.load(dir));
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.text, 'Report your workload.');
    assert.equal(resolved.coordinatorProject, 'lead');
    assert.equal(resolved.escalateAfterMinutes, 15);
    assert.deepEqual(resolved.warnings, []);
  });

  it('writes every key on a first partial save, so the file shows what is in force', async () => {
    const { name, dir } = makeProject();
    const r = await projects.updateProject(name, { workloadNudge: { enabled: true } });
    assert.ok(r.project);
    assert.deepEqual(stored(dir), { enabled: true, text: null, coordinatorProject: null, escalateAfterMinutes: 10 });
  });

  it('keeps what a later partial save does not mention', async () => {
    const { name, dir } = makeProject({ enabled: true, text: 'Kept.', coordinatorProject: 'lead', escalateAfterMinutes: 30 });
    const r = await projects.updateProject(name, { workloadNudge: { escalateAfterMinutes: 5 } });
    assert.ok(r.project);
    assert.deepEqual(stored(dir), { enabled: true, text: 'Kept.', coordinatorProject: 'lead', escalateAfterMinutes: 5 });
    const cleared = await projects.updateProject(name, { workloadNudge: { text: null, coordinatorProject: null } });
    assert.ok(cleared.project);
    assert.deepEqual(stored(dir), { enabled: true, text: null, coordinatorProject: null, escalateAfterMinutes: 5 });
  });

  it('does not carry a hand-edited bad value forward under a save that names something else', async () => {
    const { name, dir } = makeProject({ enabled: 'yes', text: 'a\nb', escalateAfterMinutes: 9000, stray: 1 });
    const r = await projects.updateProject(name, { workloadNudge: { coordinatorProject: 'lead' } });
    assert.ok(r.project);
    assert.deepEqual(stored(dir), { enabled: false, text: null, coordinatorProject: 'lead', escalateAfterMinutes: 10 });
    assert.deepEqual(resolveWorkloadNudge(store.projectConfig.load(dir)).warnings, []);
  });

  it('resets the whole setting on null', async () => {
    const { name, dir } = makeProject({ enabled: true, text: 'Gone.', coordinatorProject: 'lead', escalateAfterMinutes: 30 });
    const r = await projects.updateProject(name, { workloadNudge: null });
    assert.ok(r.project);
    assert.equal(stored(dir), null);
    assert.equal(resolveWorkloadNudge(store.projectConfig.load(dir)).enabled, false);
  });

  it('refuses each bad value with a message naming the field, and writes nothing', async () => {
    const before = { enabled: true, text: 'Before.', coordinatorProject: 'lead', escalateAfterMinutes: 30 };
    const { name, dir } = makeProject(before);
    const refused = [
      [{ enabled: 'true' }, /^workloadNudge\.enabled must be true or false$/],
      [{ enabled: null }, /^workloadNudge\.enabled must be true or false$/],
      [{ text: 'two\nlines' }, /^workloadNudge\.text must be null or one line of at most 2000 characters/],
      [{ text: 'x'.repeat(2001) }, /^workloadNudge\.text must be null or one line of at most 2000 characters/],
      [{ text: '' }, /^workloadNudge\.text must be null or one line/],
      [{ coordinatorProject: '' }, /^workloadNudge\.coordinatorProject must be null or a project name/],
      [{ coordinatorProject: 12 }, /^workloadNudge\.coordinatorProject must be null or a project name/],
      [{ escalateAfterMinutes: 1 }, /^workloadNudge\.escalateAfterMinutes must be a number of minutes between 2 and 120$/],
      [{ escalateAfterMinutes: 121 }, /^workloadNudge\.escalateAfterMinutes must be a number of minutes between 2 and 120$/],
      [{ escalateAfterMinutes: '10' }, /^workloadNudge\.escalateAfterMinutes must be a number of minutes between 2 and 120$/],
      [{ nudgeBudget: 2 }, /^workloadNudge has no setting nudgeBudget; it takes enabled, text, coordinatorProject, escalateAfterMinutes$/],
      [{ enabled: true, a: 1, b: 2 }, /^workloadNudge has no settings a, b; it takes/],
      [{}, /^workloadNudge must set at least one of enabled, text, coordinatorProject, escalateAfterMinutes$/],
      [[], /^workloadNudge must be an object or null$/],
      ['on', /^workloadNudge must be an object or null$/],
      [true, /^workloadNudge must be an object or null$/]
    ];
    for (const [patch, message] of refused) {
      const r = await projects.updateProject(name, { workloadNudge: patch });
      assert.equal(r.project, null, JSON.stringify(patch));
      assert.match(r.errors[0], message);
      assert.deepEqual(stored(dir), before, 'the stored block is untouched');
    }
  });

  it('applies nothing else in a save whose workloadNudge is refused', async () => {
    const { name, dir } = makeProject();
    const r = await projects.updateProject(name, { medusaWake: true, workloadNudge: { enabled: 'yes' } });
    assert.equal(r.project, null);
    assert.notEqual(store.projectConfig.load(dir).medusaWake, true, 'the setting beside it was not saved either');
  });
});

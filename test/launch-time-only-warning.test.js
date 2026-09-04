'use strict';

/*
 * #758 — a launch-time-only setting changed under a running session.
 *
 * The setting is resolved once, at launch. Changing it mid-session stores the
 * new value and leaves the running process on the old one, so the modal accepts
 * the input, reports success, and changes nothing observable.
 *
 * Two layers. The roster and its change detector are pure, and the roster is
 * ITERATED rather than restated — a setting added to `LAUNCH_TIME_ONLY_SETTINGS`
 * with no working `current` reader goes red here without anyone editing this
 * file. (The copied-roster shape is this repo's recurring defect; #1231 is its
 * fourth instance. Not making a fifth.) The warning itself is then driven
 * end to end through `updateProject` against a real store.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const projects = require('../lib/projects');
const loadApiHelperGlobals = require('./_api-helper-globals');
const { setLevel } = require('../lib/logger');

setLevel('error');

const { LAUNCH_TIME_ONLY_SETTINGS, launchTimeOnlyChanges } = projects;

/**
 * Any value that differs from `v`, derived from its type — so this test needs
 * no per-key table of sample values to fall out of date.
 * @param {*} v
 * @returns {*}
 */
function differentFrom(v) {
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'number') return v + 1;
  return `${v === undefined || v === null ? '' : v}-other`;
}

describe('#758 — launch-time-only settings', () => {
  let tmpDir;
  let projectsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-launch-time-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A claude project, optionally with a running session.
   * @param {string} name
   * @param {boolean} live - Whether to start an active session for it.
   * @returns {object} The project row.
   */
  function mkProject(name, live) {
    const projPath = path.join(projectsDir, name);
    fs.mkdirSync(projPath, { recursive: true });
    store.projects.create({ name, path: projPath, engine: 'claude' });
    const row = store.projects.getByName(name);
    if (live) store.sessions.start({ projectId: row.id, engineId: 'claude' });
    return row;
  }

  // The roster is exercised against the REAL shapes its readers will see — a
  // project row the store created and that project's own on-disk config. A
  // synthetic fixture carrying only today's three keys made these tests
  // vacuous: a reader naming a field that does not exist returned `undefined`
  // and every assertion still passed, while in production it would report the
  // setting as changed on every single save.
  describe('the roster', () => {
    /** @returns {{project: object, cfg: object}} A real project row and its real config. */
    function realShapes() {
      const project = mkProject(`lt-roster-${Math.random().toString(36).slice(2, 8)}`, false);
      return { project, cfg: store.projectConfig.load(project.path) };
    }

    it('every declared setting has a key, a label, and a reader', () => {
      assert.ok(LAUNCH_TIME_ONLY_SETTINGS.length > 0);
      for (const s of LAUNCH_TIME_ONLY_SETTINGS) {
        assert.equal(typeof s.key, 'string', 'a setting needs a key');
        assert.ok(s.label && typeof s.label === 'string', `${s.key} needs a label`);
        assert.equal(typeof s.current, 'function', `${s.key} needs a current reader`);
      }
    });

    it('every reader resolves against a real project — no reader names a dead field', () => {
      const { project, cfg } = realShapes();
      for (const s of LAUNCH_TIME_ONLY_SETTINGS) {
        assert.notEqual(s.current(project, cfg), undefined,
          `${s.key}'s current reader found nothing on a real project — it would report `
          + 'the setting as changed on every save');
      }
    });

    it('each declared setting is detected when its value actually changes', () => {
      const { project, cfg } = realShapes();
      for (const s of LAUNCH_TIME_ONLY_SETTINGS) {
        const changed = launchTimeOnlyChanges(
          { [s.key]: differentFrom(s.current(project, cfg)) }, project, cfg
        );
        assert.deepEqual(changed, [s.label],
          `${s.key} changed but produced no warning — add it to the warning path`);
      }
    });

    it('a key sent at its EXISTING value is silent', () => {
      const { project, cfg } = realShapes();
      for (const s of LAUNCH_TIME_ONLY_SETTINGS) {
        const changed = launchTimeOnlyChanges({ [s.key]: s.current(project, cfg) }, project, cfg);
        assert.deepEqual(changed, [],
          `${s.key} warned on a no-op — the settings modal sends every key on every save`);
      }
    });

    it('a key nobody declared is silent', () => {
      const { project, cfg } = realShapes();
      assert.deepEqual(launchTimeOnlyChanges({ tags: ['a'] }, project, cfg), []);
    });

    it('several changes at once are reported together, in declaration order', () => {
      const { project, cfg } = realShapes();
      // Derived, not sampled — the last two declared settings, each moved off
      // whatever it really holds. A literal here went stale against the real
      // defaults the moment this fixture stopped being synthetic.
      const picked = LAUNCH_TIME_ONLY_SETTINGS.slice(-2);
      const updates = {};
      for (const s of picked) updates[s.key] = differentFrom(s.current(project, cfg));
      const changed = launchTimeOnlyChanges(updates, project, cfg);
      assert.deepEqual(changed, picked.map(s => s.label),
        'both changes must be reported, in the order the roster declares them');
    });
  });

  it('warns when a launch-time-only setting changes under a running session', async () => {
    mkProject('lt-live', true);
    const res = await projects.updateProject('lt-live', { defaultLaunchMode: 'plan' });
    assert.deepEqual(res.errors, []);
    assert.equal(res.warnings.length, 1);
    assert.match(res.warnings[0], /Default launch mode is saved/);
    assert.match(res.warnings[0], /running session/);
    assert.match(res.warnings[0], /relaunch/, 'the warning must name the action, not just the fact');
  });

  it('still SAVES the value — nothing reverts and nothing blocks', async () => {
    mkProject('lt-saves', true);
    const res = await projects.updateProject('lt-saves', { defaultLaunchMode: 'plan' });
    assert.ok(res.project, 'the update must succeed');
    assert.equal(res.project.defaultLaunchMode, 'plan');
  });

  it('stays silent with no running session — no new friction for the common case', async () => {
    mkProject('lt-idle', false);
    const res = await projects.updateProject('lt-idle', { defaultLaunchMode: 'plan' });
    assert.deepEqual(res.warnings, []);
  });

  it('stays silent for a change that is not launch-time-only', async () => {
    mkProject('lt-tags', true);
    const res = await projects.updateProject('lt-tags', { tags: ['alpha'] });
    assert.deepEqual(res.warnings, []);
  });

  it('stays silent when a live session PATCHes a key at its existing value', async () => {
    mkProject('lt-noop', true);
    const res = await projects.updateProject('lt-noop', { engine: 'claude', tags: ['beta'] });
    assert.deepEqual(res.warnings, [],
      'the modal sends engine on every save; a no-op must not warn');
  });

  it('names both settings when two change at once', async () => {
    mkProject('lt-two', true);
    const res = await projects.updateProject('lt-two', {
      defaultLaunchMode: 'plan', showLaunchModePicker: false
    });
    assert.equal(res.warnings.length, 1, 'one sentence, not one per setting');
    assert.match(res.warnings[0], /Default launch mode and Show launch mode picker are saved/);
  });

  it('says nothing about which engine — the class is engine-agnostic', async () => {
    mkProject('lt-agnostic', true);
    const res = await projects.updateProject('lt-agnostic', { defaultLaunchMode: 'plan' });
    assert.ok(!/claude|codex|gemini|aider/i.test(res.warnings[0]),
      'settings apply at next launch on every engine; the copy must not name one');
  });
});

describe('#758 — the banner that carries it', () => {
  const G = loadApiHelperGlobals();
  const { makeDocument } = require('./_mini-dom');

  /** @returns {{doc: object, el: object}} A document holding the banner's three elements. */
  function bannerWorld() {
    const { doc, ids } = makeDocument(
      ['settingsWarningsBanner', 'settingsWarningsText', 'settingsWarningsDismissBtn']
    );
    ids.settingsWarningsBanner.classList.add('hidden');
    return { doc, el: ids };
  }

  it('shows the warning text and reveals the banner', () => {
    const { doc, el } = bannerWorld();
    G.tcRenderSettingsWarnings(doc, ['Engine is saved, but ... relaunch the session to apply.']);
    assert.equal(el.settingsWarningsBanner.classList.contains('hidden'), false);
    assert.match(el.settingsWarningsText.textContent, /relaunch/);
  });

  it('sets the warning as TEXT, never as markup', () => {
    const { doc, el } = bannerWorld();
    G.tcRenderSettingsWarnings(doc, ['<img src=x onerror=alert(1)>']);
    assert.equal(el.settingsWarningsText.innerHTML, '',
      'a server string must not reach innerHTML');
    assert.match(el.settingsWarningsText.textContent, /<img/);
  });

  it('an empty or absent list hides the banner', () => {
    const { doc, el } = bannerWorld();
    G.tcRenderSettingsWarnings(doc, ['something']);
    G.tcRenderSettingsWarnings(doc, []);
    assert.ok(el.settingsWarningsBanner.classList.contains('hidden'));
    G.tcRenderSettingsWarnings(doc, undefined);
    assert.ok(el.settingsWarningsBanner.classList.contains('hidden'));
  });

  it('dismiss clears it, and binds only once', () => {
    const { doc, el } = bannerWorld();
    G.tcRenderSettingsWarnings(doc, ['first']);
    G.tcRenderSettingsWarnings(doc, ['second']);
    assert.equal(el.settingsWarningsDismissBtn.dataset.wired, '1');
    el.settingsWarningsDismissBtn.dispatch('click');
    assert.ok(el.settingsWarningsBanner.classList.contains('hidden'));
    assert.equal(el.settingsWarningsText.textContent, '');
  });

  it('no timer dismisses it — it names an action the operator must take', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');
    const start = src.indexOf('function tcRenderSettingsWarnings(');
    const body = src.slice(start, src.indexOf('\n  /**', start));
    assert.ok(!/setTimeout|setInterval/.test(body),
      'this project bans timer-driven UI lifecycle (#98, #268)');
  });

  it('both pages carry the banner the renderer drives', () => {
    const pub = path.join(__dirname, '..', 'public');
    for (const page of ['index.html', 'session.html']) {
      const html = fs.readFileSync(path.join(pub, page), 'utf8');
      for (const id of ['settingsWarningsBanner', 'settingsWarningsText', 'settingsWarningsDismissBtn']) {
        assert.ok(html.includes(`id="${id}"`), `${page} is missing ${id}`);
      }
    }
  });

  it('the session page surfaces the PATCH response instead of discarding it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
    const start = src.indexOf('async function closeSettings()');
    const body = src.slice(start, src.indexOf('\n}', start));
    assert.match(body, /tcRenderSettingsWarnings\(document, res && res\.warnings\)/,
      'the engine change on this page is the launch-time-only case #758 exists for');
  });
});

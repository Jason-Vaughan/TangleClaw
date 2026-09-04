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

const { LAUNCH_TIME_ONLY_SETTINGS, launchTimeOnlyChanges, formatLaunchTimeWarnings } = projects;

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

  /**
   * A PATCH body that really changes `key`, derived from what the project holds
   * now — a literal here is how the first version of this test sent
   * `silentPrime: true` to a project whose default is already `true` and
   * concluded the code was broken.
   * @param {object} row - The project row from mkProject.
   * @param {string} key - A LAUNCH_TIME_ONLY_SETTINGS key.
   * @returns {object} A one-key update.
   */
  function changeOf(row, key) {
    const s = LAUNCH_TIME_ONLY_SETTINGS.find(e => e.key === key);
    assert.ok(s, `${key} is not a declared launch-time-only setting`);
    return { [key]: differentFrom(s.current(row, store.projectConfig.load(row.path))) };
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

    it('every declared setting has a key, a label, a reader and a divergence', () => {
      assert.ok(LAUNCH_TIME_ONLY_SETTINGS.length > 0);
      for (const s of LAUNCH_TIME_ONLY_SETTINGS) {
        assert.equal(typeof s.key, 'string', 'a setting needs a key');
        assert.ok(s.label && typeof s.label === 'string', `${s.key} needs a label`);
        assert.equal(typeof s.current, 'function', `${s.key} needs a current reader`);
        assert.ok(['running', 'next-launch'].includes(s.divergence),
          `${s.key} needs a divergence — the two groups get opposite advice, and a `
          + 'setting with neither would be told to relaunch on a guess');
      }
    });

    it('each declared setting produces the advice its divergence promises', () => {
      for (const s of LAUNCH_TIME_ONLY_SETTINGS) {
        const [line] = formatLaunchTimeWarnings([s]);
        assert.ok(line.startsWith(`${s.label} is saved.`), `${s.key}: ${line}`);
        if (s.divergence === 'running') {
          assert.match(line, /close and relaunch/i,
            `${s.key} diverges from the running session, so a relaunch is the remedy`);
        } else {
          assert.doesNotMatch(line, /relaunch/i,
            `${s.key} is read fresh at the next launch — telling the operator to kill `
            + 'live work for it is the same kind of lie #758 removes');
          assert.match(line, /next launch/i);
        }
      }
      // Both branches above must actually run, or one is asserted by nobody.
      const groups = new Set(LAUNCH_TIME_ONLY_SETTINGS.map(s => s.divergence));
      assert.deepEqual([...groups].sort(), ['next-launch', 'running']);
    });

    it('the two groups are separate sentences — one cannot be true of both', () => {
      const changed = LAUNCH_TIME_ONLY_SETTINGS.filter(
        (s, i) => LAUNCH_TIME_ONLY_SETTINGS.findIndex(o => o.divergence === s.divergence) === i
      );
      const lines = formatLaunchTimeWarnings(changed);
      assert.equal(lines.length, 2, 'one warning per divergence group present');
      assert.equal(lines.filter(l => /relaunch/i.test(l)).length, 1,
        'exactly one of the two asks for a relaunch');
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
        assert.deepEqual(changed.map(c => c.label), [s.label],
          `${s.key} changed but produced no warning — add it to the warning path`);
      }
    });

    it('a key sent at its EXISTING value is silent', () => {
      const { project, cfg } = realShapes();
      for (const s of LAUNCH_TIME_ONLY_SETTINGS) {
        const changed = launchTimeOnlyChanges({ [s.key]: s.current(project, cfg) }, project, cfg);
        assert.deepEqual(changed.map(c => c.label), [],
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
      assert.deepEqual(changed.map(c => c.label), picked.map(s => s.label),
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
  });

  it('a setting the running process really holds asks for a relaunch', async () => {
    const row = mkProject('lt-relaunch', true);
    const res = await projects.updateProject('lt-relaunch', changeOf(row, 'silentPrime'));
    assert.equal(res.warnings.length, 1);
    assert.match(res.warnings[0], /Silent prime is saved/);
    assert.match(res.warnings[0], /close and relaunch/i,
      'the warning must name the action, not just the fact');
  });

  it('a setting read fresh at the next launch does NOT ask for a relaunch', async () => {
    mkProject('lt-norelaunch', true);
    const res = await projects.updateProject('lt-norelaunch', { defaultLaunchMode: 'plan' });
    assert.doesNotMatch(res.warnings[0], /relaunch/i,
      'launchSession reads this fresh every time — asking the operator to kill live '
      + 'work for it would be a new lie in place of the old one');
    assert.match(res.warnings[0], /next launch/i);
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

  it('names both settings in one sentence when they share a divergence', async () => {
    mkProject('lt-two', true);
    const res = await projects.updateProject('lt-two', {
      defaultLaunchMode: 'plan', showLaunchModePicker: false
    });
    assert.equal(res.warnings.length, 1, 'one sentence per group, not one per setting');
    assert.match(res.warnings[0], /Default launch mode and Show launch mode picker are saved/);
  });

  it('splits into two sentences when the changes need opposite advice', async () => {
    const row = mkProject('lt-split', true);
    const res = await projects.updateProject('lt-split', {
      ...changeOf(row, 'silentPrime'), defaultLaunchMode: 'plan'
    });
    assert.equal(res.warnings.length, 2,
      'one sentence covering both could only be true of one of them');
    assert.equal(res.warnings.filter(w => /relaunch/i.test(w)).length, 1);
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

  it('the builder emits every id the renderer drives, hidden and advisory', () => {
    const html = G.tcSettingsWarningsMarkup();
    for (const id of ['settingsWarningsBanner', 'settingsWarningsText', 'settingsWarningsDismissBtn']) {
      assert.ok(html.includes(`id="${id}"`), `the builder is missing ${id}`);
    }
    assert.match(html, /class="settings-warnings-banner hidden"/, 'it must start hidden');
    assert.match(html, /role="alert"/);
    assert.ok(!/engine-error-banner|orphan-banner/.test(html),
      'a save that SUCCEEDED must not borrow the danger-red or another feature\'s banner');
  });

  it('both pages host the builder rather than hand-copying its markup', () => {
    const pub = path.join(__dirname, '..', 'public');
    for (const page of ['index.html', 'session.html']) {
      const html = fs.readFileSync(path.join(pub, page), 'utf8');
      assert.ok(html.includes('id="settingsWarningsHost"'), `${page} has no host element`);
      assert.ok(!html.includes('id="settingsWarningsBanner"'),
        `${page} still declares the banner by hand — that is how it drifted into danger-red`);
    }
    for (const script of ['ui.js', 'session.js']) {
      const src = fs.readFileSync(path.join(pub, script), 'utf8');
      assert.match(src, /settingsWarningsHost[\s\S]{0,120}tcSettingsWarningsMarkup\(\)/,
        `${script} does not fill its host from the shared builder`);
    }
  });

  it('every class the builder emits is defined in the stylesheet BOTH pages load', () => {
    const pub = path.join(__dirname, '..', 'public');
    // session.html does not load style.css, so a rule that lives only there is
    // invisible on the session page — which is how the first version of this
    // banner would have shipped unstyled and permanently visible.
    const shared = fs.readFileSync(path.join(pub, 'shared-controls.css'), 'utf8');
    const classes = [...G.tcSettingsWarningsMarkup().matchAll(/class="([^"]+)"/g)]
      .flatMap(m => m[1].split(/\s+/))
      .filter(c => c !== 'hidden');
    assert.ok(classes.length > 0);
    for (const c of classes) {
      assert.ok(shared.includes(`.${c}`), `.${c} is not in shared-controls.css`);
    }
    for (const page of ['index.html', 'session.html']) {
      const html = fs.readFileSync(path.join(pub, page), 'utf8');
      assert.match(html, /href="\/shared-controls\.css"/, `${page} must load it`);
    }
  });

  it('the session page surfaces BOTH outcomes of the PATCH, not just the good one', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
    const start = src.indexOf('async function closeSettings()');
    const body = src.slice(start, src.indexOf('\n}', start));
    assert.match(body, /tcRenderSettingsWarnings\(document, res\.warnings\)/,
      'the engine change on this page is the launch-time-only case #758 exists for');
    assert.match(body, /if \(!res\)[\s\S]{0,400}api\.lastError/,
      'a REJECTED save must not be the one silent outcome — that is the same false '
      + '"it took effect" this work removes');
  });
});

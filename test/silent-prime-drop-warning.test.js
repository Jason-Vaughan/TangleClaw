'use strict';

/*
 * #741 — on an engine without `supportsSilentPrime` the project's `silentPrime`
 * setting is neither honored nor offered, and nothing said so: the capability
 * gate fell through in silence and "Codex sessions behave differently" was
 * the only tell. These pin the one owner of that answer
 * (`engines.silentPrimeDisposition`) and the launch path's record of it —
 * recorded at info, not warn, because a stored value on such a project is
 * indistinguishable from the shipped default, so an alarm would fire on every
 * non-Claude launch about a preference nobody set.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel, setConsoleStream } = require('../lib/logger');
setLevel('error');
const store = require('../lib/store');
const { installTmuxGuard, removeTmuxGuard, reapFixtureSessions } = require('./_tmux-guard');

describe('#741 a silentPrime that does not apply on this engine says so', () => {
  let tmpDir;
  let projectsDir;
  let sessions;
  let tmux;
  let engines;
  const saved = {};

  before(() => {
    installTmuxGuard();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-silent-prime-drop-'));
    store._setBasePath(tmpDir);
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);
    sessions = require('../lib/sessions');
    tmux = require('../lib/tmux');
    engines = require('../lib/engines');
    saved.createSession = tmux.createSession;
    saved.probeSession = tmux.probeSession;
    saved.sendKeys = tmux.sendKeys;
    saved.detectEngine = engines.detectEngine;
    tmux.createSession = () => true;
    tmux.probeSession = () => ({ live: false, answered: true, cause: null });
    tmux.sendKeys = () => true;
    engines.detectEngine = () => ({ available: true, path: '/usr/bin/engine' });
  });

  after(() => {
    tmux.createSession = saved.createSession;
    tmux.probeSession = saved.probeSession;
    tmux.sendKeys = saved.sendKeys;
    engines.detectEngine = saved.detectEngine;
    store.close();
    removeTmuxGuard();
    const leaked = reapFixtureSessions(['spd-']);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    assert.deepEqual(leaked, [], `leaked tmux sessions: ${leaked.join(', ')}`);
  });

  /**
   * Create a project on an engine with a silentPrime setting, launch it, and
   * return the warn-level log lines the launch produced.
   * @param {string} name - Project name.
   * @param {string} engine - Engine id.
   * @param {boolean} silentPrime - The project's configured preference.
   * @param {object} [extraConfig] - Further project-config keys to store.
   * @returns {string[]} Captured log lines that mention silentPrime.
   */
  function launchAndCaptureWarnings(name, engine, silentPrime, extraConfig) {
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    store.projects.create({ name, path: dir, engine });
    store.projectConfig.save(dir, { engine, silentPrime, ...(extraConfig || {}) });
    const lines = [];
    setConsoleStream({ write: (s) => lines.push(String(s)) });
    setLevel('info');
    let result;
    try {
      result = sessions.launchSession(name);
    } finally {
      setConsoleStream(null);
      setLevel('error');
    }
    assert.ok(result.session, `launch must succeed: ${result.error}`);
    store.sessions.kill(result.session.id, 'test cleanup');
    lastLaunchLines = lines;
    return lines.filter((l) => /silentPrime/.test(l));
  }

  // Every line the last launch logged, for assertions about a setting other
  // than silentPrime.
  let lastLaunchLines = [];

  it('records, naming the engine and the setting, that silentPrime does not apply on codex', () => {
    const lines = launchAndCaptureWarnings('spd-codex-on', 'codex', true);
    const hit = lines.filter((l) => /silentPrime does not apply on this engine/.test(l));
    assert.equal(hit.length, 1, `exactly one line, got:\n${lines.join('')}`);
    assert.match(hit[0], /\bengine=codex\b/, 'names the engine, as the logger renders context');
    assert.match(hit[0], /setting=silentPrime/, 'and the setting');
    assert.match(hit[0], /supportsSilentPrime is not true/, 'and why');
    assert.match(hit[0], /INFO/, 'a record, not an alarm — the value may be the shipped default');
    assert.doesNotMatch(hit[0], /WARN/);
  });

  it('records the same on codex when the stored value is false — the setting is inapplicable either way', () => {
    const lines = launchAndCaptureWarnings('spd-codex-off', 'codex', false);
    assert.equal(lines.filter((l) => /does not apply on this engine/.test(l)).length, 1);
  });

  it('says nothing on an engine that honors the setting', () => {
    const lines = launchAndCaptureWarnings('spd-claude-on', 'claude', true);
    assert.deepEqual(lines.filter((l) => /does not apply/.test(l)), []);
  });

  describe('the level the launch path records at is the disposition\'s, not the call site\'s (ADR 0013)', () => {
    it('warns when the dropped defaultLaunchMode is one the operator chose', () => {
      // 'plan' is a claude mode codex does not define, and it differs from the
      // shipped 'default' — real intent, dropped, so it is an alarm.
      launchAndCaptureWarnings('spd-mode-warn', 'codex', false, { defaultLaunchMode: 'plan' });
      const hit = lastLaunchLines.filter((l) => /defaultLaunchMode is not usable/.test(l));
      assert.equal(hit.length, 1, `exactly one line, got:\n${lastLaunchLines.join('')}`);
      assert.match(hit[0], /WARN/);
      assert.match(hit[0], /does not offer the launch mode/, 'the operator-readable reason');
      assert.match(hit[0], /engine does not define this mode/, 'and the profile fact behind it');
    });

    it('says nothing about a defaultLaunchMode the engine runs', () => {
      launchAndCaptureWarnings('spd-mode-ok', 'codex', false, { defaultLaunchMode: 'fullAuto' });
      assert.deepEqual(lastLaunchLines.filter((l) => /defaultLaunchMode is not usable/.test(l)), []);
    });

    it('warns rather than records when the dropped silentPrime was a real choice', () => {
      // The mirror of the info case above, and the reason the level is derived
      // from provenance rather than attached to the setting: `silentPrime` is
      // not "the info one" — a stored `false` differs from the shipped `true`.
      const lines = launchAndCaptureWarnings('spd-codex-chosen-off', 'codex', false);
      const hit = lines.filter((l) => /does not apply on this engine/.test(l));
      assert.equal(hit.length, 1);
      assert.match(hit[0], /WARN/);
    });
  });

  describe('silentPrimeDisposition is the one owner of the answer', () => {
    const engines = require('../lib/engines');
    const supporting = { capabilities: { supportsSilentPrime: true } };
    const declaresFalse = { capabilities: { supportsSilentPrime: false } };
    const declaresNothing = { capabilities: {} };

    it('answers on/off only where the engine can honor it', () => {
      assert.equal(engines.silentPrimeDisposition({ silentPrime: true }, supporting), 'on');
      assert.equal(engines.silentPrimeDisposition({ silentPrime: false }, supporting), 'off');
      assert.equal(engines.silentPrimeDisposition({}, supporting), 'off');
    });

    it('answers not-applicable for an engine that declares false, declares nothing, or is missing', () => {
      for (const profile of [declaresFalse, declaresNothing, null]) {
        assert.equal(engines.silentPrimeDisposition({ silentPrime: true }, profile), 'not-applicable');
        assert.equal(engines.silentPrimeDisposition({ silentPrime: false }, profile), 'not-applicable');
      }
    });

    it('the launch path reads the owner rather than restating the predicate', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sessions.js'), 'utf8');
      const launch = src.slice(src.indexOf('function launchSession('), src.indexOf('function _deferEngineInit'));
      assert.match(launch, /engines\.silentPrimeDisposition\(projConfig, engineProfile\)/);
      assert.doesNotMatch(launch, /projConfig\.silentPrime === true\s*&&\s*engineProfile\.capabilities/,
        'the launch-time predicate has one owner');
    });
  });
});

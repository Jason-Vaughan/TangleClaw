'use strict';

/*
 * #741 — a configured `silentPrime: true` that the engine cannot honor is a
 * DROPPED preference, and a dropped preference that says nothing reads as
 * "Codex sessions behave differently" rather than "your setting was
 * discarded". `defaultLaunchMode` already warns on the identical situation
 * thirty lines below; these pin the same voice for `silentPrime`, on the
 * launch path itself, and only there.
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

describe('#741 a dropped silentPrime warns like a dropped launch mode', () => {
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
   * @returns {string[]} Captured log lines at warn level.
   */
  function launchAndCaptureWarnings(name, engine, silentPrime) {
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    store.projects.create({ name, path: dir, engine });
    store.projectConfig.save(dir, { engine, silentPrime });
    const lines = [];
    setConsoleStream({ write: (s) => lines.push(String(s)) });
    setLevel('warn');
    let result;
    try {
      result = sessions.launchSession(name);
    } finally {
      setConsoleStream(null);
      setLevel('error');
    }
    assert.ok(result.session, `launch must succeed: ${result.error}`);
    store.sessions.kill(result.session.id, 'test cleanup');
    return lines.filter((l) => /WARN/.test(l));
  }

  it('warns, naming the engine and the setting, when the engine lacks supportsSilentPrime', () => {
    const warnings = launchAndCaptureWarnings('spd-codex-on', 'codex', true);
    const hit = warnings.filter((l) => /silentPrime is not usable for this engine/.test(l));
    assert.equal(hit.length, 1, `exactly one warning, got:\n${warnings.join('')}`);
    assert.match(hit[0], /"engine":"codex"|engine: 'codex'|engine=codex|codex/, 'names the engine');
    assert.match(hit[0], /supportsSilentPrime/, 'and says which capability is missing');
    assert.match(hit[0], /pasted into the pane/, 'and what happens instead');
  });

  it('stays silent when the engine honors the setting', () => {
    const warnings = launchAndCaptureWarnings('spd-claude-on', 'claude', true);
    assert.deepEqual(warnings.filter((l) => /silentPrime/.test(l)), []);
  });

  it('stays silent when silentPrime is not configured — nothing was dropped', () => {
    const warnings = launchAndCaptureWarnings('spd-codex-off', 'codex', false);
    assert.deepEqual(warnings.filter((l) => /silentPrime/.test(l)), []);
  });
});

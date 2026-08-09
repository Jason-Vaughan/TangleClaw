'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Give a test store one engine that is ALWAYS detected as installed.
 *
 * Setup refuses to finish with no engine installed — TangleClaw's whole job is
 * launching AI coding sessions, and an install with none is a dashboard that can
 * launch nothing. Every suite that drives setup to completion therefore has to
 * satisfy that precondition, exactly as it already satisfies the admin-credential
 * one.
 *
 * It must not depend on what the machine happens to have. The bundled profiles
 * detect real CLIs (`claude`, `codex`, …), so a developer's Mac passes and a CI
 * runner with none of them installed fails 43 tests in four suites — measured,
 * by making the gate see zero engines and running the suite. This profile uses
 * the `path` detection strategy pointed at the running node binary, which exists
 * by construction wherever the test is running.
 *
 * Written straight into the store's engines directory rather than through an
 * API, because `store.engines.list()` reads that directory on every call and
 * bundled-profile sync leaves unknown files alone.
 *
 * @param {string} basePath - The store base path the test passed to
 *   `store._setBasePath()`.
 * @param {string} [id] - Engine id, if a test needs more than one.
 * @returns {string} The profile path, so a test can remove it to exercise the
 *   no-engine case.
 */
function installAlwaysAvailableEngine(basePath, id) {
  const engineId = id || 'test-engine';
  const dir = path.join(basePath, 'engines');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${engineId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    id: engineId,
    name: 'Test Engine',
    command: process.execPath,
    interactionModel: 'interactive',
    configFormat: 'markdown',
    // `path` rather than `which`: the running node binary is present by
    // definition, so detection cannot depend on the host's PATH or on which
    // CLIs someone happens to have installed.
    detection: { strategy: 'path', target: process.execPath },
    launch: { shellCommand: process.execPath, args: [], env: {} }
  }, null, 2));
  return file;
}

module.exports = { installAlwaysAvailableEngine };

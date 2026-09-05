'use strict';

/*
 * A real store on a THROWAWAY base path, established SYNCHRONOUSLY at require
 * time.
 *
 * `medusa-wake` derives `ENGINE_WAKE_PROFILES` from the profiles the store
 * holds (#1255), so a test file that reads the table leans on whatever
 * `~/.tangleclaw/engines` the host happens to have — green on a dev machine
 * with a live install, red on CI where the directory does not exist and every
 * engine reads as unprofiled. `test/engine-config-managed-block.test.js`
 * already recorded that exact failure for `writeEngineConfig`; this is the same
 * hazard one module over, and the same fix.
 *
 * Synchronous, not a `before()` hook, because the reads it protects happen at
 * file load: `const CLAUDE = wake.ENGINE_WAKE_PROFILES.claude` at module scope
 * runs long before any hook does.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');

/**
 * Point the store at a fresh temp directory and populate it from the bundle.
 *
 * `store.init()` is the real producer of what the runtime reads — it is the
 * canonical-source sync (#251) that copies `data/engines/` into the user-local
 * directory — so the fixture comes from it rather than from a hand-rolled copy
 * that could drift from what a boot actually writes.
 *
 * @param {string} label - Short tag for the temp directory name.
 * @returns {{path: string, cleanup: () => void}} The base path, and a teardown
 *   suitable for an `after()` hook.
 */
function useThrowawayStore(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-${label}-store-`));
  store._setBasePath(dir);
  store.init();
  return {
    path: dir,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

module.exports = { useThrowawayStore };

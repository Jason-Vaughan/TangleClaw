'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLogger } = require('./logger');

const log = createLogger('ttyd-attach');

const ATTACH_BASENAME = 'ttyd-attach.sh';

/**
 * Canonical install location for the ttyd attach script — under `~/.tangleclaw`,
 * which is NOT TCC-protected. ttyd reads this file on every client connection
 * and ttyd is denied Full Disk Access, so a copy under the repo's `~/Documents`
 * path freezes ttyd's per-connection `open()` (#500). The plist points here; the
 * repo copy at `deploy/ttyd-attach.sh` is the source this is synced from.
 * @param {string} home - The user's home directory (`os.homedir()`).
 * @returns {string} Absolute path to the installed attach script.
 */
function attachScriptPath(home) {
  return path.join(home, '.tangleclaw', 'deploy', ATTACH_BASENAME);
}

/**
 * @param {Buffer} buf
 * @returns {string} sha1 hex digest.
 */
function _sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/**
 * Copy `deploy/ttyd-attach.sh` out of the (TCC-protected) repo into the non-TCC
 * `~/.tangleclaw/deploy/` location so ttyd can read it per connection without
 * hanging in `open()` (#500). Idempotent and drift-correcting: writes only when
 * the destination is missing or its bytes differ from the repo source, and
 * always asserts the `0755` exec bit. The refresh-on-diff is what keeps the copy
 * current after an update bumps the repo script — every server restart (which an
 * update triggers) re-runs this at boot.
 *
 * Non-throwing by design: called at server boot and from the ingress cutover,
 * neither of which may die on an fs wrinkle. Returns a reason instead.
 *
 * @param {object} opts
 * @param {string} opts.repoDir - Repo root (source is `<repoDir>/deploy/ttyd-attach.sh`).
 * @param {string} opts.home - The user's home directory.
 * @returns {{ synced: boolean, reason: string, path: string }} `synced` = a write
 *   happened this call; `reason` ∈ copied|refreshed|up-to-date|no-source|error:*.
 */
function syncAttachScript({ repoDir, home }) {
  const dest = attachScriptPath(home);
  try {
    const src = path.join(repoDir, 'deploy', ATTACH_BASENAME);
    if (!fs.existsSync(src)) return { synced: false, reason: 'no-source', path: dest };
    const srcBuf = fs.readFileSync(src);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    let reason;
    if (!fs.existsSync(dest)) {
      reason = 'copied';
    } else if (_sha1(fs.readFileSync(dest)) !== _sha1(srcBuf)) {
      reason = 'refreshed';
    } else {
      // Bytes already match — still assert the exec bit (a non-executable copy
      // hangs ttyd a different way) but skip the rewrite.
      fs.chmodSync(dest, 0o755);
      return { synced: false, reason: 'up-to-date', path: dest };
    }

    fs.writeFileSync(dest, srcBuf);
    fs.chmodSync(dest, 0o755);
    log.info('Synced ttyd attach script into non-TCC path (#500)', { dest, reason });
    return { synced: true, reason, path: dest };
  } catch (err) { // prawduct:allow prawduct/broad-except -- boot/cutover fs helper must never crash startup; logged, non-fatal
    log.warn('ttyd attach-script sync failed (non-fatal) — ttyd may use a stale copy', { dest, error: err.message });
    return { synced: false, reason: `error: ${err.message}`, path: dest };
  }
}

module.exports = { attachScriptPath, syncAttachScript, ATTACH_BASENAME };

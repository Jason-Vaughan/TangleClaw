#!/usr/bin/env node
'use strict';

// AUTH-1 (#395) — ingress cutover. Reversibly switch TangleClaw between:
//   • 'direct' ingress — TC terminates its own HTTPS, ttyd binds TCP :3100 (today's default)
//   • 'caddy'  ingress — Caddy terminates TLS as the single front door; TC binds
//                        localhost plain-HTTP; ttyd binds a Unix socket (unreachable
//                        except via the proxy chain)
//
//   node scripts/ingress-cutover.js --to caddy             activate Caddy ingress
//   node scripts/ingress-cutover.js --to direct            roll back to direct HTTPS
//   node scripts/ingress-cutover.js --rollback             alias for --to direct
//   node scripts/ingress-cutover.js --to caddy --dry-run   print the plan, touch nothing
//   node scripts/ingress-cutover.js --to caddy --force      overwrite a hand-edited Caddyfile
//   node scripts/ingress-cutover.js --to caddy --result-file <path>
//                                                          also write a JSON outcome for a
//                                                          caller that is not reading stdout
//
// Fail-closed: in caddy mode the Caddyfile is `caddy validate`d BEFORE any
// launchd reload, so a bad config can never take the ingress down. The flip
// restarts the TC server so its listener re-binds for the new mode.
//
// #397 production-durability fixes: (1) the cert is STAGED into the non-TCC store
// dir so the launchd caddy (no Full Disk Access) can read it; (2) ttyd's launchd
// job runs /bin/bash (a non-TCC binary) and unlinks a stale Unix socket inline
// from argv before exec'ing ttyd on every restart — never a repo-resident script,
// which would exit 126 under TCC when the repo is in ~/Documents; (3) a
// hand-edited Caddyfile is backed up and NOT overwritten without --force.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const REPO_DIR = path.resolve(__dirname, '..');
const caddy = require(path.join(REPO_DIR, 'lib', 'caddy'));
const ttydAttach = require(path.join(REPO_DIR, 'lib', 'ttyd-attach'));
const store = require(path.join(REPO_DIR, 'lib', 'store'));

const DEPLOY_DIR = path.join(REPO_DIR, 'deploy');
const SERVER_LABEL = 'com.tangleclaw.server';
const TTYD_LABEL = 'com.tangleclaw.ttyd';
// From lib/caddy, not a local literal: the settings surface reloads this same job
// by label, and a second copy is a rename away from restarting nothing while
// reporting success.
const CADDY_LABEL = caddy.CADDY_LABEL;
// The names every TangleClaw cert must carry regardless of what an older cert
// happened to include — the floor that stops an additive regeneration coming out
// with FEWER names than a fresh one. Imported rather than re-listed: a local copy
// of the same three strings drifts silently the moment one side gains a name.


/**
 * Every hostname a regenerated certificate must carry.
 *
 * Regenerating is destructive to names nothing else records: no config field
 * stores the host list a cert was minted with, so generating from the defaults
 * discards a tailnet FQDN supplied through `POST /api/setup/generate-cert` — and
 * the tailnet HTTPS site reuses this very cert. Measured on a clean-room
 * install, so this is not a theoretical hazard. Both generation paths and the
 * dry-run preview call THIS, because the two paths drifted once already: the
 * union was added to one of them and the other silently kept dropping names.
 *
 * @param {string|null} certPath - Existing cert to carry names forward from.
 * @param {object} config - Loaded TangleClaw config.
 * @returns {string[]} Deduplicated host list for mkcert.
 */
function certHostUnion(certPath, config) {
  const httpsSetup = httpsSetupModule();
  // Read from the standard cert location as well as whatever the caller has
  // resolved so far. The "no valid cert configured" branch calls this BEFORE
  // ctx.certPath is assigned — it is still null there — and that is precisely
  // the branch that regenerates, so reading only the argument carried nothing
  // forward and dropped every name anyway. Verified by running it: a cert
  // holding a tailnet FQDN still came out with only the defaults until this
  // fallback existed.
  const candidates = [certPath, path.join(httpsSetup.getCertsDir(), 'cert.pem')].filter(Boolean);
  const carried = candidates.flatMap((p) => httpsSetup.certSanHosts(p));
  return [...new Set([
    ...carried,
    ...httpsSetup.MKCERT_HOSTS_DEFAULT,
    httpsSetup.mdnsHostFor(require('node:os').hostname()),
    (config && config.caddyTailnetHost) || null,
    (config && config.publicDomain) || null
  ].filter(Boolean))];
}

/** @returns {object} lib/https-setup, resolved lazily (REPO_DIR-relative like the others). */
function httpsSetupModule() {
  return require(path.join(REPO_DIR, 'lib', 'https-setup'));
}

/**
 * Replace `__TOKEN__` placeholders in a plist template string.
 * @param {string} tpl
 * @param {Record<string,string>} subs - keys are the bare token names (no underscores).
 * @returns {string}
 */
function fillTemplate(tpl, subs) {
  let out = tpl;
  for (const [k, v] of Object.entries(subs)) {
    out = out.split(`__${k}__`).join(v);
  }
  return out;
}

/**
 * Build the declarative cutover plan. PURE given resolved inputs — performs no
 * I/O — so it is unit-testable. The executor (main) writes the files, applies
 * the config patch, and runs the launchctl commands in order.
 *
 * @param {'caddy'|'direct'} target
 * @param {object} ctx
 * @param {object} ctx.config - loaded TC config.
 * @param {object} ctx.env - { caddyPath, ttydPath, home, repoDir, launchdPath, launchAgentsDir, uid }
 * @param {number} ctx.upstreamPort - TC's actual listen port (Caddy upstream / direct health port).
 * @param {string} ctx.certPath - mkcert cert for the local Caddy site (caddy target only).
 * @param {string} ctx.keyPath - mkcert key (caddy target only).
 * @param {string} ctx.caddyfilePath
 * @param {string} ctx.socketPath - ttyd Unix socket path (caddy target).
 * @param {string} ctx.ttydTemplate - ttyd plist template contents.
 * @param {string} ctx.caddyTemplate - caddy plist template contents.
 * @param {string|null} [ctx.existingCaddyfileText] - Current Caddyfile text (null
 *   when absent) — feeds the #397 refuse-to-ungate guard.
 * @returns {{ target, caddyfile: {path,content}|null, plists: Array<{path,content}>, configPatch: object, launchctl: Array<string[]>, healthUrl: string, rollbackHint: string }}
 */
function planCutover(target, ctx) {
  const { config, env, upstreamPort } = ctx;
  const ttydPlistPath = path.join(env.launchAgentsDir, `${TTYD_LABEL}.plist`);
  const caddyPlistPath = path.join(env.launchAgentsDir, `${CADDY_LABEL}.plist`);
  const serverTarget = `gui/${env.uid}/${SERVER_LABEL}`;

  if (target === 'caddy') {
    const httpsPort = config.caddyHttpsPort || 8443;
    // #397 credential durability — NEVER regenerate a gated ingress into an
    // ungated one. If the existing Caddyfile carries a credential but the
    // config would emit no gate, abort: the operator must adopt/set the
    // credential first (boot-time adoption or scripts/reset-admin.js). This is
    // the fail-closed twin of the 2026-07-03 lockout: losing the credential
    // locked the operator OUT; dropping the gate would let everyone else IN.
    const effectiveAuth = Boolean(config.authEnabled && config.basicAuthUser && config.basicAuthHash);
    if (!effectiveAuth && typeof ctx.existingCaddyfileText === 'string'
        && caddy.listBasicAuthUsers(ctx.existingCaddyfileText).length > 0) {
      const err = new Error('cutover would replace a basic_auth-GATED Caddyfile with an UNGATED one '
        + '(config has no credential). Set one first: node scripts/reset-admin.js '
        + '(or restart the server in caddy mode to auto-adopt the live credential into config).');
      // Tagged so a caller can tell THIS refusal from the five unrelated errors
      // buildCaddyfileContent raises below (missing port, missing cert pair, …).
      // Without the tag they collapse into one code, and a wizard would answer a
      // missing-certificate fault by telling the operator to reset their password.
      err.cutoverCode = 'ungate-refused';
      throw err;
    }
    const caddyfile = caddy.buildCaddyfileContent({
      serverPort: upstreamPort,
      certPath: ctx.certPath,
      keyPath: ctx.keyPath,
      httpsPort,
      httpPort: config.caddyHttpPort || 8080,
      publicDomain: config.publicDomain || null,
      // AUTH-2 — gate the ingress only when basic_auth is enabled. The config
      // PATCH guarantees authEnabled ⇒ user+hash present, and the generator's
      // both-or-neither guard backstops it; passing null/null leaves an open site.
      basicAuthUser: config.authEnabled ? config.basicAuthUser : null,
      basicAuthHash: config.authEnabled ? config.basicAuthHash : null,
      // #397 — preserve the remote plain-HTTP catch-all shape (adopted from the
      // live file or set explicitly). Generator enforces gate-required.
      remoteHttpCatchAll: config.caddyRemoteHttp === true,
      // #434 — preserve the tailnet HTTPS site + http→https redirect (adopted
      // from the live file or set explicitly). Generator enforces gate-required.
      tailnetHost: config.caddyTailnetHost || null,
      // #863 — the machine's own mDNS name, so the dashboard answers to
      // something other than `localhost`. Without it the generated Caddyfile has
      // exactly one site and every other address fails the TLS handshake, which
      // made "reach it from your phone" impossible on a default install. The
      // generator adds it only when a gate exists and only if it parses as a
      // hostname; `ctx.lanHost` is already null when the cert cannot vouch for
      // the name.
      lanHost: ctx.lanHost
    });
    const ttydPlist = fillTemplate(ctx.ttydTemplate, {
      TTYD_PATH: env.ttydPath, HOME: env.home,
      // #500: the attach script lives outside the repo (non-TCC); main() syncs
      // the copy before applying the plan.
      TTYD_ATTACH: ttydAttach.attachScriptPath(env.home),
      LAUNCHD_PATH: env.launchdPath,
      TTYD_BIND_KEY: '--interface', TTYD_BIND_VAL: ctx.socketPath,
      // Ignored by ttyd when the interface is a unix socket (verified: no TCP
      // listener is opened), but the template slot must still be filled or the
      // literal placeholder would reach argv.
      TTYD_PORT: String(config.ttydPort || 3100),
      // #397 bug 2: tell the inline launcher which socket to unlink before bind.
      TTYD_SOCKET: ctx.socketPath
    });
    const caddyPlist = fillTemplate(ctx.caddyTemplate, {
      CADDY_PATH: env.caddyPath, CADDYFILE: ctx.caddyfilePath,
      HOME: env.home, LAUNCHD_PATH: env.launchdPath
    });
    return {
      target,
      caddyfile: { path: ctx.caddyfilePath, content: caddyfile },
      plists: [
        { path: ttydPlistPath, content: ttydPlist },
        { path: caddyPlistPath, content: caddyPlist }
      ],
      configPatch: { ingressMode: 'caddy' },
      // Reload ttyd onto the socket, bring Caddy up, restart the server so it
      // re-binds localhost plain-HTTP. unload-before-load is idempotent.
      launchctl: [
        ['unload', ttydPlistPath],
        ['load', ttydPlistPath],
        ['unload', caddyPlistPath],
        ['load', caddyPlistPath],
        ['kickstart', '-k', serverTarget]
      ],
      healthUrl: `https://localhost:${httpsPort}/api/health`,
      rollbackHint: 'node scripts/ingress-cutover.js --to direct'
    };
  }

  // target === 'direct' — restore direct TCP. Only the ttyd plist needs
  // rewriting (back to TCP); Caddy is unloaded; the server restarts onto its
  // own HTTPS.
  //
  // #710: rolling back to direct must NOT reopen the terminal to the network.
  // ttyd runs `--writable` against `tmux attach-session`, so its interface is a
  // security boundary rather than a convenience. It is pinned to loopback
  // unconditionally and does NOT follow `bindAllInterfaces` — that setting is
  // about reaching the DASHBOARD remotely, and nothing addresses ttyd directly
  // since TC proxies to it. See lib/ttyd-bind.js#desiredBind.
  const ttydBindAddress = '127.0.0.1';
  const ttydPlist = fillTemplate(ctx.ttydTemplate, {
    TTYD_PATH: env.ttydPath, HOME: env.home,
    // #500: attach script installed outside the repo (non-TCC).
    TTYD_ATTACH: ttydAttach.attachScriptPath(env.home),
    LAUNCHD_PATH: env.launchdPath,
    TTYD_BIND_KEY: '--interface', TTYD_BIND_VAL: ttydBindAddress,
    TTYD_PORT: String(config.ttydPort || 3100),
    // Direct mode binds TCP — no socket to unlink; leave TTYD_SOCKET empty.
    TTYD_SOCKET: ''
  });
  const protocol = (config.httpsEnabled && config.httpsCertPath && config.httpsKeyPath) ? 'https' : 'http';
  return {
    target,
    caddyfile: null,
    plists: [{ path: ttydPlistPath, content: ttydPlist }],
    configPatch: { ingressMode: 'direct' },
    launchctl: [
      ['unload', caddyPlistPath],
      ['unload', ttydPlistPath],
      ['load', ttydPlistPath],
      ['kickstart', '-k', serverTarget]
    ],
    healthUrl: `${protocol}://localhost:${upstreamPort}/api/health`,
    rollbackHint: 'node scripts/ingress-cutover.js --to caddy'
  };
}

// ── Executor (side-effecting; not unit-tested — VRF-auth-1-cutover) ──

/**
 * Parse CLI args into { target, dryRun, force, resultFile }.
 * `--force` overrides the guard that refuses to overwrite a hand-edited Caddyfile
 * (#397 bug 3). `--result-file` names a path to write a machine-readable outcome
 * to; it is what lets a caller that is not watching stdout learn how the cutover
 * ended.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ target: 'caddy'|'direct'|null, dryRun: boolean, force: boolean, resultFile: (string|null) }}
 */
function parseArgs(argv) {
  let target = null;
  let dryRun = false;
  let force = false;
  let resultFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') { target = argv[++i]; }
    else if (a === '--rollback') { target = 'direct'; }
    else if (a === '--dry-run') { dryRun = true; }
    else if (a === '--force') { force = true; }
    else if (a === '--result-file') { resultFile = argv[++i] || null; }
  }
  if (target !== 'caddy' && target !== 'direct') target = null;
  return { target, dryRun, force, resultFile };
}

/**
 * Outcome codes written to a `--result-file`. Stable strings: a caller branches
 * on these rather than on prose, so they are part of the contract and must not be
 * reworded to suit a message.
 *
 * `ungate-refused` and `unreadable`/`hand-edited` differ in kind and a caller
 * needs to tell them apart: the first means config has no credential to emit, the
 * others mean an existing file must not be touched.
 * @type {Readonly<Record<string, string>>}
 */
const CUTOVER_CODES = Object.freeze({
  OK: 'ok',
  CADDY_MISSING: 'caddy-missing',
  UNREADABLE: 'unreadable',
  HAND_EDITED: 'hand-edited',
  UNGATE_REFUSED: 'ungate-refused',
  VALIDATE_FAILED: 'validate-failed',
  FAILED: 'failed'
});

/**
 * Write the cutover's machine-readable outcome, best-effort.
 *
 * Deliberately never throws: this is a reporting channel, and a caller that
 * cannot be told the outcome is strictly better off than one whose ingress
 * cutover aborted because a status file could not be written. A missing result
 * file is itself meaningful to the reader (the run died before finishing), so
 * silence here degrades honestly rather than misleading.
 * @param {string|null} resultFile - Path to write, or null to do nothing.
 * @param {{ok: boolean, code: string, target: string, error?: (string|null), healthUrl?: (string|null), healthOk?: (boolean|null), healthError?: (string|null)}} result
 *   `healthError` is why the health probe could not be *made*, and it is separate
 *   from `error` on purpose: `error` means the cutover failed, while a probe that
 *   could not run says nothing about whether the plan applied. Conflating them
 *   reports a gated install as ungated. Since the builder below names every key
 *   explicitly, a field absent from this type is a field that gets dropped — so
 *   this list is the contract, not a summary of it.
 * @returns {boolean} Whether the file was written.
 */
function writeCutoverResult(resultFile, result) {
  if (!resultFile) return false;
  try {
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, `${JSON.stringify({
      ok: Boolean(result.ok),
      code: result.code,
      target: result.target,
      error: result.error || null,
      healthUrl: result.healthUrl || null,
      healthOk: typeof result.healthOk === 'boolean' ? result.healthOk : null,
      // Distinct from `error` ON PURPOSE. `finish` derives both `ok` and the exit
      // code from `error`, so routing a health-probe reason through it would make
      // a fully-applied cutover report {ok:false, code:'ok'} and exit 1 — which the
      // wizard renders as "No login is in force" on an install that IS gated. The
      // health result is a separate fact from whether the cutover succeeded, and
      // this key exists so it can be reported without inverting the outcome.
      // This builder names every key explicitly: anything absent here is dropped.
      healthError: result.healthError || null,
      finishedAt: new Date().toISOString()
    })}\n`, { mode: 0o600 });
    return true;
  } catch (err) { // prawduct:allow prawduct/broad-except -- reporting channel; see JSDoc. Reported with its cause below, never swallowed, and must not abort a cutover that has already touched launchd.
    try {
      // The cause matters: EACCES on the directory and ENOSPC are different
      // problems for whoever has to work out why the caller never got a result.
      process.stderr.write(`WARNING: could not write cutover result file ${resultFile}: ${err.message}\n`);
    } catch { // prawduct:allow prawduct/broad-except -- stderr itself is what just failed (detached child, closed fds); there is no remaining channel to report on, and throwing here would abort a completed cutover
      /* nothing left to report with */
    }
    return false;
  }
}

/**
 * Dry-run twin of caddy.adoptCredentialIntoConfig: apply the live Caddyfile's
 * credential and ingress shapes (remote-HTTP catch-all, tailnet HTTPS site) to
 * the IN-MEMORY config only — nothing is saved — so the previewed plan reflects
 * the post-adoption state instead of crashing on the refuse-to-ungate guard
 * (Critic-caught: dry-run and real-run diverged on exactly the #397 recovery
 * scenario). Delegates to `caddy.computeCaddyfileAdoption` — the same pure core
 * the real path runs (CAD-7X4V) — so dry-run and real adoption cannot drift;
 * this wrapper only owns the no-Caddyfile guard and the boolean return.
 * @param {object} config - Loaded config, mutated in place (in-memory only).
 * @param {string|null} existingCaddyfileText - Live Caddyfile text, if any.
 * @returns {boolean} Whether any adoption was previewed.
 */
function applyDryRunAdoptionPreview(config, existingCaddyfileText) {
  if (typeof existingCaddyfileText !== 'string') return false;
  return caddy.computeCaddyfileAdoption(config, existingCaddyfileText).changed;
}


/** Resolve TC's actual listen port: the installed server plist's TANGLECLAW_PORT wins, else config. */
function resolveUpstreamPort(serverPlistPath, config) {
  try {
    const xml = fs.readFileSync(serverPlistPath, 'utf8');
    const m = xml.match(/<key>TANGLECLAW_PORT<\/key>\s*<string>(\d+)<\/string>/);
    if (m) return Number(m[1]);
  } catch { /* not installed yet — fall through */ }
  // Config, then the shipped default — deliberately NOT `effectiveServerPort`.
  // This script runs out-of-process, so a TANGLECLAW_PORT in its environment
  // describes whoever launched the shell (a TangleClaw-spawned session inherits
  // it from the server), not the installed service Caddy must proxy to. The
  // plist above is that authority; config is the better second guess than an
  // ambient variable. Pinned by a test that sets the variable and asserts it is
  // ignored, so a later "unification" onto the helper fails loudly.
  return config.serverPort || store.DEFAULT_CONFIG.serverPort;
}

function which(bin) {
  try { return execFileSync('which', [bin], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

function main() {
  const { target, dryRun, force, resultFile } = parseArgs(process.argv.slice(2));
  if (!target) {
    process.stderr.write('Usage: node scripts/ingress-cutover.js --to caddy|direct [--dry-run] [--force] [--result-file <path>]\n       node scripts/ingress-cutover.js --rollback\n');
    process.exit(2);
  }

  /**
   * End the run: report the outcome to `--result-file` (if asked), close the
   * store, and exit. Every exit *after the run begins* goes through here, so a
   * caller polling the result file can never mistake a refusal for a crash — an
   * ABSENT file means the process died, and that reading only holds because the
   * refusals write one too.
   *
   * Two exits deliberately do not: a usage error (exits before this exists —
   * the arguments were never valid, so there is no run to report on) and
   * `--dry-run` (a preview must never be readable as a completed cutover).
   * @param {string} code - A CUTOVER_CODES value.
   * @param {string|null} error - Why the CUTOVER failed, or null on success.
   *   Load-bearing beyond reporting: `ok` and the exit code are both derived from
   *   it, so any non-null value here declares the run a failure. Reasons that are
   *   not the cutover failing — a health probe that could not be built, say —
   *   belong in `extra`, never here.
   * @param {{healthUrl?: string, healthOk?: boolean, healthError?: (string|null)}} [extra]
   *   Merged into the result file verbatim, and constrained by what
   *   `writeCutoverResult` names: a key it does not list is dropped silently.
   * @returns {never}
   */
  const finish = (code, error, extra = {}) => {
    writeCutoverResult(resultFile, {
      ok: !error, code, target, error: error || null, ...extra
    });
    store.close();
    process.exit(error ? 1 : 0);
  };

  store.init();
  const config = store.config.load();
  const home = require('node:os').homedir();
  const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');

  // Build the launchd PATH the same way install.sh does (user PATH + system dirs).
  let launchdPath = process.env.PATH || '';
  for (const p of ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    if (!launchdPath.split(':').includes(p)) launchdPath += `:${p}`;
  }

  const env = {
    caddyPath: which('caddy'),
    ttydPath: which('ttyd'),
    home,
    repoDir: REPO_DIR,
    launchdPath,
    launchAgentsDir,
    uid: process.getuid()
  };

  // Classify the existing Caddyfile ONCE, up front, and derive every later
  // decision from this single read.
  //
  // Order matters and is the whole point: reading the file to build `ctx` below
  // is what a present-but-unreadable config crashes on (EACCES), and it happens
  // long before any guard downstream could refuse gracefully. Classifying first
  // means the refusal is reachable — otherwise the operator gets a bare stack
  // trace from the very case the refusal exists to explain.
  const caddyfilePath = caddy.getCaddyfilePath();
  const ingress = caddy.classifyIngressState(caddyfilePath);

  // Only a run that would WRITE the Caddyfile has to refuse an unreadable one.
  // `--to direct` never writes it (it unloads Caddy instead), so an unreadable
  // file is merely uninformative there, not blocking — the text below feeds the
  // caddy-only refuse-to-ungate guard.
  if (target === 'caddy' && ingress.state === 'unreadable' && !dryRun) {
    process.stderr.write(
      'ERROR: the existing Caddyfile cannot be read, so it cannot be backed up (ingress untouched).\n'
      + `  Path: ${caddyfilePath}\n`
      + '  Fix its permissions, or move it aside yourself, then re-run.\n'
      + '  --force does not apply: forcing past an unreadable file would replace it with no backup.\n'
    );
    finish(CUTOVER_CODES.UNREADABLE, `Caddyfile cannot be read: ${caddyfilePath}`);
  }

  const ctx = {
    config,
    env,
    upstreamPort: resolveUpstreamPort(path.join(launchAgentsDir, `${SERVER_LABEL}.plist`), config),
    caddyfilePath,
    socketPath: caddy.getTtydSocketPath(),
    ttydTemplate: fs.readFileSync(path.join(DEPLOY_DIR, `${TTYD_LABEL}.plist`), 'utf8'),
    caddyTemplate: fs.readFileSync(path.join(DEPLOY_DIR, `${CADDY_LABEL}.plist`), 'utf8'),
    certPath: null,
    // #863 — resolved below once a cert exists to vouch for the name. Declared
    // here so the shape is complete before any early return: planCutover reads
    // it unconditionally, and an undefined would advertise the name on a
    // dry-run path that never ran the coverage check.
    lanHost: null,
    keyPath: null,
    // #397 — the existing Caddyfile's text (null if absent OR unreadable) feeds
    // the refuse-to-ungate guard in planCutover. Read only in the states the
    // classification above proved readable; `unreadable` has already refused for
    // a caddy run, and a direct run does not consult this.
    //
    // Deliberately NOT taken from classifyIngressState's return: that shape is
    // also serialized by GET /api/setup/ingress-state, and putting raw Caddyfile
    // text on it would push the file's bcrypt hash across an HTTP boundary that
    // is careful today to expose only a state name.
    existingCaddyfileText: (ingress.state === 'absent' || ingress.state === 'unreadable')
      ? null
      : fs.readFileSync(caddyfilePath, 'utf8')
  };

  if (target === 'caddy') {
    // #397/#434 durability — before planning, adopt the live Caddyfile's
    // basic_auth credential and ingress shapes (remote-HTTP catch-all, tailnet
    // HTTPS site) into config where config lacks them, so the regenerated file
    // re-emits the SAME hash + sites instead of losing them. Dry-run reports
    // without mutating config.
    if (dryRun) {
      if (applyDryRunAdoptionPreview(config, ctx.existingCaddyfileText)) {
        process.stdout.write('NOTE: would ADOPT the live Caddyfile\'s basic_auth credential / ingress shapes into config (#397/#434 durability) — plan below previews the post-adoption state\n');
      }
    } else {
      const adoption = caddy.adoptCredentialIntoConfig({ requireCaddyMode: false });
      if (adoption.changed) {
        const parts = [];
        if (adoption.adopted) parts.push(`basic_auth credential (user: ${adoption.user})`);
        if (adoption.remoteHttp) parts.push('remote HTTP catch-all preserved');
        if (adoption.tailnetHost) parts.push(`tailnet HTTPS site preserved (${adoption.tailnetHost})`);
        process.stdout.write(`Adopted live Caddyfile state into config: ${parts.join(', ')}.\n`);
        Object.assign(config, store.config.load()); // refresh the in-memory copy the plan reads
      }
    }
    if (!env.caddyPath) {
      if (!dryRun) {
        process.stderr.write('ERROR: caddy not found on PATH. Install with: brew install caddy\n');
        finish(CUTOVER_CODES.CADDY_MISSING, 'caddy not found on PATH (install: brew install caddy)');
      }
      process.stdout.write('NOTE: caddy not found on PATH (dry-run) — install with: brew install caddy\n');
      env.caddyPath = 'caddy'; // placeholder for the previewed plist
    }
    // Reuse the operator's mkcert cert for the local site; generate one if absent.
    const httpsSetup = require(path.join(REPO_DIR, 'lib', 'https-setup'));
    if (config.httpsCertPath && config.httpsKeyPath &&
        httpsSetup.validateCertFiles(config.httpsCertPath, config.httpsKeyPath).ok) {
      ctx.certPath = config.httpsCertPath;
      ctx.keyPath = config.httpsKeyPath;
    } else if (dryRun) {
      // Don't generate anything during a dry-run — show the paths mkcert WOULD write.
      const certsDir = httpsSetup.getCertsDir();
      ctx.certPath = path.join(certsDir, 'cert.pem');
      ctx.keyPath = path.join(certsDir, 'key.pem');
    } else {
      process.stdout.write('No valid mkcert cert configured — generating one (mkcert)...\n');
      // Additive for the same reason the regeneration below is: "no VALID cert
      // configured" includes the case where a perfectly good cert exists but
      // config does not point at it, and generating from the defaults there
      // discards every name it carried. Measured on a clean-room install: a cert
      // holding a tailnet FQDN came out of this branch holding only the
      // defaults, silently un-covering the tailnet HTTPS site that reuses it.
      // `certSanHosts` returns [] for a cert that genuinely is not there, so a
      // true first run is unaffected.
      const gen = httpsSetup.generateCerts({ hosts: certHostUnion(ctx.certPath, config) });
      ctx.certPath = gen.certPath;
      ctx.keyPath = gen.keyPath;
    }

    // #863 — the name the dashboard answers to besides `localhost`.
    //
    // A certificate that does not carry the name is worse than no extra site: the
    // handshake succeeds and the browser rejects the name, which reads as "the
    // password page is broken" rather than "unreachable". So the name is only
    // advertised once the cert vouches for it. Older installs carry a cert whose
    // mDNS SAN was written `<host>.local.local` and covers nothing, so a plain
    // coverage check would leave exactly those installs stuck — regenerate
    // instead. mkcert generation is unprivileged and this function already does
    // it when no valid cert exists; the CA is untouched, so nothing needs
    // re-trusting that was trusted before.
    ctx.lanHost = httpsSetup.mdnsHostFor(require('node:os').hostname());
    // A preview must describe the destructive step, not omit it. Regenerating
    // the certificate is the one thing in this run that overwrites a file the
    // operator did not ask about, and `--dry-run` advertises itself as changing
    // nothing — so it has to SAY that a real run would rewrite the cert, and
    // which names it would carry forward. A preview that stays silent about a
    // rebuild is the inversion of the rule this project already holds itself to.
    if (ctx.lanHost && dryRun && !httpsSetup.certCoversHost(ctx.certPath, ctx.lanHost)) {
      const wouldCarry = certHostUnion(ctx.certPath, config);
      process.stdout.write(
        `NOTE: would REGENERATE the certificate (${ctx.certPath}) — it does not cover ${ctx.lanHost}.\n`
        + `      Names it would carry: ${wouldCarry.join(', ')}\n`
        + '      (existing names are preserved; the CA is untouched, so nothing needs re-trusting)\n');
    }
    if (ctx.lanHost && !dryRun && !httpsSetup.certCoversHost(ctx.certPath, ctx.lanHost)) {
      process.stdout.write(
        `Certificate does not cover ${ctx.lanHost} — regenerating so the dashboard can be reached by name...\n`);
      try {
        // ADDITIVE, never a replacement. Nothing records the host list a cert was
        // minted with, so regenerating from the defaults silently drops every
        // name added later — including a tailnet FQDN supplied through
        // `POST /api/setup/generate-cert`, whose HTTPS site reuses THIS cert and
        // would stop matching. The cert is its own only record, so the existing
        // SANs are read back out and carried forward, together with the sites
        // config says we are about to emit.
        const regen = httpsSetup.generateCerts({ hosts: certHostUnion(ctx.certPath, config) });
        ctx.certPath = regen.certPath;
        ctx.keyPath = regen.keyPath;
      } catch (e) {
        // Honest degradation: keep the working localhost cert and drop the extra
        // name, rather than emitting a site the browser will reject.
        process.stdout.write(
          `WARNING: could not regenerate the certificate (${e.message}). Continuing with `
          + 'localhost only — the dashboard will not be reachable by name from another device.\n');
        ctx.lanHost = null;
      }
      if (ctx.lanHost && !httpsSetup.certCoversHost(ctx.certPath, ctx.lanHost)) {
        process.stdout.write(
          `WARNING: the regenerated certificate still does not cover ${ctx.lanHost}. Continuing with `
          + 'localhost only.\n');
        ctx.lanHost = null;
      }
    }

    // #397 bug 1: the launchd caddy binary has no Full Disk Access, so a cert
    // under a TCC-protected dir (e.g. ~/Documents) silently fails to load. Stage
    // it into the non-TCC store dir and point the Caddyfile there. Dry-run only
    // previews the staged paths (no copy).
    if (dryRun) {
      const stagedDir = caddy.getStagedCertsDir();
      ctx.certPath = path.join(stagedDir, 'cert.pem');
      ctx.keyPath = path.join(stagedDir, 'key.pem');
    } else {
      const staged = caddy.stageCert(ctx.certPath, ctx.keyPath);
      ctx.certPath = staged.certPath;
      ctx.keyPath = staged.keyPath;
    }
  }

  let plan;
  try {
    plan = planCutover(target, ctx);
  } catch (err) { // prawduct:allow prawduct/broad-except -- planCutover's refusals and its generator's validation errors both arrive as Error; reported verbatim below, never swallowed
    process.stderr.write(`ERROR: ${err.message}\n`);
    // Only the tagged refusal is `ungate-refused`. Everything else the generator
    // raises is a plain build failure, and must not be reported as a credential
    // problem — the two have completely different operator remedies.
    finish(err.cutoverCode === 'ungate-refused' ? CUTOVER_CODES.UNGATE_REFUSED : CUTOVER_CODES.FAILED, err.message);
  }

  if (dryRun) {
    process.stdout.write(`\n[dry-run] ingress cutover → ${target}\n`);
    if (target === 'caddy') process.stdout.write(`  stage cert into: ${caddy.getStagedCertsDir()}\n`);
    if (plan.caddyfile) {
      // Preview the clobber guard (#397 bug 3) so the operator knows a hand-edited
      // Caddyfile would be protected, not silently overwritten.
      // Preview the two refusals separately — they do NOT resolve the same way,
      // and a preview that offers `--force` for the unreadable case would send
      // the operator to a flag the executor deliberately refuses to honor there.
      if (ingress.state === 'unreadable') {
        process.stdout.write(
          `  ✗ would REFUSE: ${plan.caddyfile.path} cannot be READ, so it cannot be backed up\n`
          + '    --force does NOT apply here — fix permissions or move the file aside, then re-run\n'
        );
      } else if (!ingress.safeToWrite) {
        process.stdout.write(force
          ? `  ⚠ overwrite HAND-EDITED Caddyfile (--force; timestamped backup written first): ${plan.caddyfile.path}\n`
          : `  ✗ would REFUSE: ${plan.caddyfile.path} is hand-edited (timestamped backup + re-run with --force to replace)\n`);
      }
      process.stdout.write(`  write Caddyfile: ${plan.caddyfile.path}\n`);
    }
    for (const f of plan.plists) process.stdout.write(`  write plist:     ${f.path}\n`);
    process.stdout.write(`  config patch:    ${JSON.stringify(plan.configPatch)}\n`);
    for (const c of plan.launchctl) process.stdout.write(`  launchctl ${c.join(' ')}\n`);
    process.stdout.write(`  health check:    ${plan.healthUrl}\n`);
    process.stdout.write(`  rollback:        ${plan.rollbackHint}\n\n`);
    // A preview changes nothing, so it deliberately writes NO result file: a
    // caller polling one must never see a dry run and conclude the ingress moved.
    if (resultFile) process.stdout.write('  note: --result-file is not written for a dry run\n');
    store.close();
    return;
  }

  // 1. Caddyfile first, then VALIDATE before touching launchd (fail-closed).
  fs.mkdirSync(path.join(home, '.tangleclaw', 'logs'), { recursive: true });
  if (plan.caddyfile) {
    fs.mkdirSync(path.dirname(plan.caddyfile.path), { recursive: true });
    // #397 bug 3: never silently clobber a hand-edited Caddyfile (it may carry
    // the operator's basic_auth password + remote-access block — wiping it locks
    // them out remotely). Back it up (timestamped, so repeated runs never
    // overwrite an earlier backup), and refuse unless --force.
    // The unreadable case was refused before `ctx` was built — it has to be,
    // because building `ctx` reads this same file and would otherwise crash on
    // EACCES first. `--force` never applies to it: force is survivable only
    // because of the backup taken below, and a file that cannot be read cannot
    // be backed up (copying raises the same EACCES), so forcing past it would
    // destroy a config with no recovery.
    if (!ingress.safeToWrite) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${plan.caddyfile.path}.${stamp}.bak`;
      fs.copyFileSync(plan.caddyfile.path, backup);
      // The file being backed up carries a bcrypt hash, and copyFileSync brings
      // the source's mode with it — a hand-edited Caddyfile at 0644 would leave
      // a credential readable by every account on the box.
      fs.chmodSync(backup, 0o600);
      if (!force) {
        process.stderr.write(`ERROR: refusing to overwrite a hand-edited Caddyfile (ingress untouched).\n  Backed up to: ${backup}\n  Re-run with --force to replace it.\n`);
        finish(CUTOVER_CODES.HAND_EDITED, `refusing to overwrite a hand-edited Caddyfile (backup: ${backup})`);
      }
      process.stdout.write(`WARNING: overwriting hand-edited Caddyfile (--force). Backup: ${backup}\n`);
    }
    fs.writeFileSync(plan.caddyfile.path, plan.caddyfile.content, { mode: 0o600 });
    const v = caddy.validateCaddyfile(plan.caddyfile.path);
    if (!v.ok) {
      process.stderr.write(`ERROR: generated Caddyfile failed validation — aborting (ingress untouched):\n  ${v.error}\n`);
      finish(CUTOVER_CODES.VALIDATE_FAILED, `generated Caddyfile failed validation: ${v.error}`);
    }
  }

  // 1b. Sync the ttyd attach script into the non-TCC path the plist points at
  //     (#500) before reloading ttyd — otherwise a first-ever cutover would
  //     rebind ttyd onto a path that doesn't exist yet. Idempotent; boot does
  //     this too, but the cutover reloads ttyd immediately so it can't wait.
  ttydAttach.syncAttachScript({ repoDir: REPO_DIR, home: env.home });

  // 2. Ensure the ttyd socket dir exists, and clear any leftover socket file so
  //    the rebinding ttyd doesn't fail on a stale inode (KeepAlive would then
  //    crash-loop with no obvious breadcrumb). The live ttyd keeps its bound
  //    inode until the unload below; the new instance binds a fresh one.
  if (target === 'caddy') {
    fs.mkdirSync(path.dirname(ctx.socketPath), { recursive: true });
    try { fs.rmSync(ctx.socketPath, { force: true }); } catch { /* best-effort; bind will surface real failures */ }
  }

  // 3. Write plists.
  for (const f of plan.plists) fs.writeFileSync(f.path, f.content);

  // 4. Apply the config patch (the restarted server reads the new ingressMode).
  Object.assign(config, plan.configPatch);
  store.config.save(config);

  // 5. launchctl sequence. unload may legitimately fail (job not loaded) — tolerate.
  for (const [sub, ...rest] of plan.launchctl) {
    try {
      execFileSync('launchctl', [sub, ...rest], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      if (sub !== 'unload') {
        process.stderr.write(`WARNING: launchctl ${sub} ${rest.join(' ')} failed: ${err.message}\n`);
      }
    }
  }

  process.stdout.write(`\nIngress switched to '${target}'.\n  Health: ${plan.healthUrl}\n  Rollback: ${plan.rollbackHint}\n\n`);

  // 6. Best-effort health poll (non-fatal — the operator VRF confirms end-to-end).
  // Captured so an unbuildable health URL reaches the RESULT FILE, not just
  // stderr the detached child has nobody reading. Without it the caller sees
  // healthOk:false with no error and is pointed at logs that say nothing.
  let healthError = null;
  pollHealth(plan.healthUrl, 6, (err) => { healthError = err.message; }).then((ok) => {
    process.stdout.write(ok
      ? '  ✓ health check passed\n'
      : `  ⚠ health check not green yet${healthError ? `: ${healthError}` : ' — check logs (~/.tangleclaw/logs/)'}\n`);
    // The cutover itself succeeded either way — the plan was applied. healthOk
    // carries whether it came up, which is a separate fact a caller may want to
    // act on (retry, surface a warning) without being told the run failed.
    // healthError goes in its OWN field, never as `error`: the cutover succeeded —
    // the plan was applied — and reporting otherwise would tell the wizard a gated
    // install has no login.
    finish(CUTOVER_CODES.OK, null, { healthUrl: plan.healthUrl, healthOk: ok, healthError });
  });
}

/**
 * Poll a health URL a few times; resolves true on HTTP 200/503. Accepts the
 * self-signed local cert (rejectUnauthorized:false).
 *
 * The client is chosen from the URL's scheme, not assumed. This used to call
 * `https.get` unconditionally, which worked for `--to caddy` (whose health URL is
 * `https://localhost:8443`) and threw `ERR_INVALID_PROTOCOL` for `--to direct`
 * (`http://localhost:3102`) — so the rollback switched the ingress successfully
 * and then crashed, exiting non-zero with no result file written. That is the
 * break-glass path out of a bad ingress state, and the asymmetry survived because
 * the only path anyone exercises regularly is the HTTPS one.
 *
 * The construction is also inside the try, because `get()` throws SYNCHRONOUSLY
 * on a scheme mismatch rather than emitting 'error'. A health poll that cannot
 * even build a request must report "not healthy" and let the caller decide — it
 * must never take down a run whose actual work already completed.
 * @param {string} url
 * @param {number} tries
 * @param {Function} [onUnbuildable] - Called with the Error when the request could
 *   not be constructed at all. Invoked only from the catch and `typeof`-guarded, so
 *   two-argument callers are unaffected and the success path cannot reach it.
 * @returns {Promise<boolean>}
 */
function pollHealth(url, tries, onUnbuildable) {
  return new Promise((resolve) => {
    let n = 0;
    const attempt = () => {
      n++;
      let req;
      try {
        // Parsed rather than prefix-matched: `new URL` is exact about the scheme
        // (case, credentials, whitespace) where startsWith is not, and it throws
        // on a malformed URL — which the catch below is already the right home for.
        const client = new URL(url).protocol === 'https:' ? https : http;
        req = client.get(url, { rejectUnauthorized: false, timeout: 2000 }, (res) => {
          res.resume();
          if (res.statusCode === 200 || res.statusCode === 503) return resolve(true);
          retry();
        });
      } catch (err) {
        // Unbuildable request (bad scheme, malformed URL). Not retryable — but not
        // silent either. Resolving false mutely is the same information loss #789
        // was about: the caller writes `healthOk:false` with no `error`, and the
        // operator is told to check logs that say nothing. The detached child has
        // no stdout anyone reads, so the reason has to reach the result file too.
        process.stderr.write(`WARNING: health check could not be attempted: ${err.message}\n`);
        if (typeof onUnbuildable === 'function') onUnbuildable(err);
        return resolve(false);
      }
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (n >= tries) return resolve(false);
      setTimeout(attempt, 1000);
    };
    attempt();
  });
}

if (require.main === module) {
  main();
}

module.exports = { planCutover, fillTemplate, parseArgs, resolveUpstreamPort, applyDryRunAdoptionPreview, writeCutoverResult, pollHealth, certHostUnion, CUTOVER_CODES };

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
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const REPO_DIR = path.resolve(__dirname, '..');
const caddy = require(path.join(REPO_DIR, 'lib', 'caddy'));

const DEPLOY_DIR = path.join(REPO_DIR, 'deploy');
const SERVER_LABEL = 'com.tangleclaw.server';
const TTYD_LABEL = 'com.tangleclaw.ttyd';
const CADDY_LABEL = 'com.tangleclaw.caddy';

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
      throw new Error('cutover would replace a basic_auth-GATED Caddyfile with an UNGATED one '
        + '(config has no credential). Set one first: node scripts/reset-admin.js '
        + '(or restart the server in caddy mode to auto-adopt the live credential into config).');
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
      tailnetHost: config.caddyTailnetHost || null
    });
    const ttydPlist = fillTemplate(ctx.ttydTemplate, {
      TTYD_PATH: env.ttydPath, REPO_DIR: env.repoDir, HOME: env.home,
      LAUNCHD_PATH: env.launchdPath,
      TTYD_BIND_KEY: '--interface', TTYD_BIND_VAL: ctx.socketPath,
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

  // target === 'direct' — restore today's behavior. Only the ttyd plist needs
  // rewriting (back to TCP); Caddy is unloaded; the server restarts onto its
  // own HTTPS on all interfaces.
  const ttydPlist = fillTemplate(ctx.ttydTemplate, {
    TTYD_PATH: env.ttydPath, REPO_DIR: env.repoDir, HOME: env.home,
    LAUNCHD_PATH: env.launchdPath,
    TTYD_BIND_KEY: '--port', TTYD_BIND_VAL: String(config.ttydPort || 3100),
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
 * Parse CLI args into { target, dryRun, force }.
 * `--force` overrides the guard that refuses to overwrite a hand-edited Caddyfile
 * (#397 bug 3).
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ target: 'caddy'|'direct'|null, dryRun: boolean, force: boolean }}
 */
function parseArgs(argv) {
  let target = null;
  let dryRun = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') { target = argv[++i]; }
    else if (a === '--rollback') { target = 'direct'; }
    else if (a === '--dry-run') { dryRun = true; }
    else if (a === '--force') { force = true; }
  }
  if (target !== 'caddy' && target !== 'direct') target = null;
  return { target, dryRun, force };
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

/**
 * Whether an existing Caddyfile is hand-edited (exists and is NOT an
 * integrity-verified generated file). Shared by the dry-run preview and the
 * executor so the clobber-guard decision (#397 bug 3) can't drift between them.
 * @param {string} caddyfilePath
 * @returns {boolean}
 */
function caddyfileIsHandEdited(caddyfilePath) {
  if (!fs.existsSync(caddyfilePath)) return false;
  return !caddy.isGeneratedCaddyfile(fs.readFileSync(caddyfilePath, 'utf8'));
}

/** Resolve TC's actual listen port: the installed server plist's TANGLECLAW_PORT wins, else config. */
function resolveUpstreamPort(serverPlistPath, config) {
  try {
    const xml = fs.readFileSync(serverPlistPath, 'utf8');
    const m = xml.match(/<key>TANGLECLAW_PORT<\/key>\s*<string>(\d+)<\/string>/);
    if (m) return Number(m[1]);
  } catch { /* not installed yet — fall through */ }
  return config.serverPort || 3101;
}

function which(bin) {
  try { return execFileSync('which', [bin], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

function main() {
  const { target, dryRun, force } = parseArgs(process.argv.slice(2));
  if (!target) {
    process.stderr.write('Usage: node scripts/ingress-cutover.js --to caddy|direct [--dry-run] [--force]\n       node scripts/ingress-cutover.js --rollback\n');
    process.exit(2);
  }

  const store = require(path.join(REPO_DIR, 'lib', 'store'));
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

  const ctx = {
    config,
    env,
    upstreamPort: resolveUpstreamPort(path.join(launchAgentsDir, `${SERVER_LABEL}.plist`), config),
    caddyfilePath: caddy.getCaddyfilePath(),
    socketPath: caddy.getTtydSocketPath(),
    ttydTemplate: fs.readFileSync(path.join(DEPLOY_DIR, `${TTYD_LABEL}.plist`), 'utf8'),
    caddyTemplate: fs.readFileSync(path.join(DEPLOY_DIR, `${CADDY_LABEL}.plist`), 'utf8'),
    certPath: null,
    keyPath: null,
    // #397 — the existing Caddyfile's text (null if absent) feeds the
    // refuse-to-ungate guard in planCutover.
    existingCaddyfileText: fs.existsSync(caddy.getCaddyfilePath())
      ? fs.readFileSync(caddy.getCaddyfilePath(), 'utf8')
      : null
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
        process.exit(1);
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
      const gen = httpsSetup.generateCerts();
      ctx.certPath = gen.certPath;
      ctx.keyPath = gen.keyPath;
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

  const plan = planCutover(target, ctx);

  if (dryRun) {
    process.stdout.write(`\n[dry-run] ingress cutover → ${target}\n`);
    if (target === 'caddy') process.stdout.write(`  stage cert into: ${caddy.getStagedCertsDir()}\n`);
    if (plan.caddyfile) {
      // Preview the clobber guard (#397 bug 3) so the operator knows a hand-edited
      // Caddyfile would be protected, not silently overwritten.
      if (caddyfileIsHandEdited(plan.caddyfile.path)) {
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
    if (caddyfileIsHandEdited(plan.caddyfile.path)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${plan.caddyfile.path}.${stamp}.bak`;
      fs.copyFileSync(plan.caddyfile.path, backup);
      if (!force) {
        process.stderr.write(`ERROR: refusing to overwrite a hand-edited Caddyfile (ingress untouched).\n  Backed up to: ${backup}\n  Re-run with --force to replace it.\n`);
        store.close();
        process.exit(1);
      }
      process.stdout.write(`WARNING: overwriting hand-edited Caddyfile (--force). Backup: ${backup}\n`);
    }
    fs.writeFileSync(plan.caddyfile.path, plan.caddyfile.content, { mode: 0o600 });
    const v = caddy.validateCaddyfile(plan.caddyfile.path);
    if (!v.ok) {
      process.stderr.write(`ERROR: generated Caddyfile failed validation — aborting (ingress untouched):\n  ${v.error}\n`);
      store.close();
      process.exit(1);
    }
  }

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
  pollHealth(plan.healthUrl, 6).then((ok) => {
    process.stdout.write(ok ? '  ✓ health check passed\n' : '  ⚠ health check not green yet — check logs (~/.tangleclaw/logs/)\n');
    store.close();
  });
}

/**
 * Poll a health URL a few times; resolves true on HTTP 200/503. Accepts the
 * self-signed local cert (rejectUnauthorized:false).
 * @param {string} url
 * @param {number} tries
 * @returns {Promise<boolean>}
 */
function pollHealth(url, tries) {
  return new Promise((resolve) => {
    let n = 0;
    const attempt = () => {
      n++;
      const req = https.get(url, { rejectUnauthorized: false, timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200 || res.statusCode === 503) return resolve(true);
        retry();
      });
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

module.exports = { planCutover, fillTemplate, parseArgs, resolveUpstreamPort, caddyfileIsHandEdited, applyDryRunAdoptionPreview };

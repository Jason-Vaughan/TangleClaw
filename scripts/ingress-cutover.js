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
//
// Fail-closed: in caddy mode the Caddyfile is `caddy validate`d BEFORE any
// launchd reload, so a bad config can never take the ingress down. The flip
// restarts the TC server so its listener re-binds for the new mode.

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
 * @returns {{ target, caddyfile: {path,content}|null, plists: Array<{path,content}>, configPatch: object, launchctl: Array<string[]>, healthUrl: string, rollbackHint: string }}
 */
function planCutover(target, ctx) {
  const { config, env, upstreamPort } = ctx;
  const ttydPlistPath = path.join(env.launchAgentsDir, `${TTYD_LABEL}.plist`);
  const caddyPlistPath = path.join(env.launchAgentsDir, `${CADDY_LABEL}.plist`);
  const serverTarget = `gui/${env.uid}/${SERVER_LABEL}`;

  if (target === 'caddy') {
    const httpsPort = config.caddyHttpsPort || 8443;
    const caddyfile = caddy.buildCaddyfileContent({
      serverPort: upstreamPort,
      certPath: ctx.certPath,
      keyPath: ctx.keyPath,
      httpsPort,
      httpPort: config.caddyHttpPort || 8080,
      publicDomain: config.publicDomain || null
    });
    const ttydPlist = fillTemplate(ctx.ttydTemplate, {
      TTYD_PATH: env.ttydPath, REPO_DIR: env.repoDir, HOME: env.home,
      LAUNCHD_PATH: env.launchdPath,
      TTYD_BIND_KEY: '--interface', TTYD_BIND_VAL: ctx.socketPath
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
    TTYD_BIND_KEY: '--port', TTYD_BIND_VAL: String(config.ttydPort || 3100)
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
 * Parse CLI args into { target, dryRun }.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ target: 'caddy'|'direct'|null, dryRun: boolean }}
 */
function parseArgs(argv) {
  let target = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') { target = argv[++i]; }
    else if (a === '--rollback') { target = 'direct'; }
    else if (a === '--dry-run') { dryRun = true; }
  }
  if (target !== 'caddy' && target !== 'direct') target = null;
  return { target, dryRun };
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
  const { target, dryRun } = parseArgs(process.argv.slice(2));
  if (!target) {
    process.stderr.write('Usage: node scripts/ingress-cutover.js --to caddy|direct [--dry-run]\n       node scripts/ingress-cutover.js --rollback\n');
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
    keyPath: null
  };

  if (target === 'caddy') {
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
  }

  const plan = planCutover(target, ctx);

  if (dryRun) {
    process.stdout.write(`\n[dry-run] ingress cutover → ${target}\n`);
    if (plan.caddyfile) process.stdout.write(`  write Caddyfile: ${plan.caddyfile.path}\n`);
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

module.exports = { planCutover, fillTemplate, parseArgs, resolveUpstreamPort };

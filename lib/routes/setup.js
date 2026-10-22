'use strict';

/**
 * The setup wizard's route family — the mkcert and ingress probes
 * (`/api/setup/https-check`, `/api/setup/ingress-state`), the cutover outcome
 * (`/api/setup/provision-status`), certificate generation
 * (`/api/setup/generate-cert`), the project scan and directory creation
 * (`/api/setup/scan`, `/api/setup/create-dir`) and the batch finish
 * (`/api/setup/complete`) — with the host-list validation the certificate
 * route uses and the two test seams only this family reads: the restart
 * scheduler the finish schedules and the ingress-cutover spawner it starts,
 * moved out of `server.js` unchanged (#2248).
 *
 * `register(deps)` registers the routes through the shared kernel, in the
 * order they held in `server.js`; the entry point calls it at the position
 * the routes held, so the route table reads as before. Three helpers the
 * handlers call still live in `server.js` because other families read them
 * too — the setup credential decision (`_decideSetupCredential`, shared with
 * the config route's Skip path), the ingress door reader (`_gateIngress`) and
 * the sign-in helper (`_signIn`) — so they arrive as `deps` rather than
 * through a require of the entry point, which would be a cycle. The two seam
 * setters keep their place on `server.js`'s own export surface, re-exported
 * from here as the same functions, so the tests that swap them are unchanged.
 *
 * @module lib/routes/setup
 */

const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../logger');
const store = require('../store');
const projects = require('../projects');
const engines = require('../engines');
const master = require('../master');
const caddy = require('../caddy');
const httpsSetup = require('../https-setup');
const ingressProvision = require('../ingress-provision');
const hostInventory = require('../host-inventory');
const authGate = require('../auth-gate');
const bindPolicy = require('../bind-policy');
const recoveryCodes = require('../recovery-codes');
const { route, jsonResponse, errorResponse } = require('./_kernel');

// The logger keeps the entry point's name so every log line this family writes
// reads exactly as it did before the move.
const log = createLogger('server');

// ── Restart scheduler (overridable in tests) ──
let _scheduleRestart = () => {
  setTimeout(() => {
    log.info('Setup complete — restarting server to apply HTTPS config');
    process.exit(0);
  }, 500);
};

/**
 * Override the restart scheduler (used by tests to prevent process.exit).
 * @param {Function} fn
 */
function _setRestartScheduler(fn) {
  _scheduleRestart = fn;
}

// How setup starts the ingress cutover. A seam for the same reason the restart
// scheduler is one: the real call rewrites launchd plists and restarts this
// server. Tests replace it to assert that a cutover WOULD have been started,
// without one happening. `lib/ingress-provision.js` additionally refuses a real
// spawn from a test process, so forgetting to override fails loudly.
let _spawnCutover = (opts) => ingressProvision.spawnCutover(opts);

/**
 * Override the ingress-cutover spawner (used by tests).
 * @param {Function} fn - Receives `{ target }`, returns `{ ok, pid, error }`.
 */
function _setCutoverSpawner(fn) {
  _spawnCutover = fn;
}

// Valid host: letters/digits/dots/colons/hyphens, not starting with '-' so mkcert
// can't mistake it for a flag. Max length 253 per RFC 1035 (plus IPv6 colons).
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.\-:]{0,252})$/;
/**
 * Validate an optional host-name array from a generate-cert body.
 *
 * @param {*} value - The body field.
 * @param {string} field - Its name, for the error message.
 * @returns {{hosts: string[]|null, error: string|null}}
 */
function _certHostListArg(value, field) {
  if (value === undefined) return { hosts: null, error: null };
  if (!Array.isArray(value) || value.length === 0) {
    return { hosts: null, error: `${field} must be a non-empty array of strings` };
  }
  for (const h of value) {
    if (typeof h !== 'string' || !HOST_RE.test(h)) {
      return { hosts: null, error: `Invalid host: ${JSON.stringify(h)}` };
    }
  }
  return { hosts: value, error: null };
}

/**
 * Register the setup routes on the shared route table.
 * @param {object} deps - What the handlers use that still lives in `server.js`.
 * @param {(config: object, route: {adoptionSupplies: boolean, optOut: boolean}) => object} deps._decideSetupCredential -
 *   Whether finishing setup needs a login, may offer the choice of none, and may be skipped, for one config.
 * @param {() => object} deps._gateIngress - Read the ingress door (the Caddyfile's gate) as the auth gate sees it.
 * @param {(req: object, res: object, user: object) => void} deps._signIn - Create the browser session for a signed-in user.
 * @returns {void}
 */
function register(deps) {
  const { _decideSetupCredential, _gateIngress, _signIn } = deps;

  // GET /api/setup/https-check — Detect mkcert availability for the wizard
  route('GET', '/api/setup/https-check', (_req, res) => {
    const detection = httpsSetup.detectMkcert();
    const caInstalled = detection.available ? httpsSetup.isCaInstalled(detection.carootPath) : false;
    jsonResponse(res, 200, {
      mkcert: {
        available: detection.available,
        version: detection.version,
        carootPath: detection.carootPath,
        caInstalled,
        error: detection.error
      },
      certsDir: httpsSetup.getCertsDir()
    });
  });

  // GET /api/setup/ingress-state — What the wizard is allowed to do about a login.
  //
  // Two facts the wizard needs before it can offer to put a gate in front of this
  // install: whether Caddy is installed at all, and whether a Caddy config already
  // exists that a human maintains. Detection only — this never writes the
  // Caddyfile, never reloads, and never provisions; it is the sibling of
  // /api/setup/https-check, which reports on mkcert the same way.
  //
  // Deliberately narrower than `classifyIngressState` returns. The credential hash
  // never crosses the boundary, and the raw user list is reduced to a count.
  //
  // The one username this can disclose is released only while `setupComplete` is
  // false. The wizard needs it for a single sentence — "keeping your existing
  // login for <user>" — and that sentence is only ever shown during setup. Once
  // setup is finished the name is withheld, because in direct mode this route
  // answers with no gate in front of it and an installed, running TangleClaw
  // should not hand out an account name for the asking. The state and the count
  // still answer honestly, which is all any later caller needs.
  // `plan` is the wizard's step-list decision, derived HERE and never in the
  // browser. Whether the admin step appears is a security decision — a duplicate
  // of the six-state table in public/setup.js could drift from this one and start
  // collecting a credential nothing enforces. The wizard branches on
  // `plan.action` alone.
  // `credential` is the same kind of decision, for the login step itself: whether
  // Finish needs a login, whether the choice of none may be offered, and whether
  // Skip — which adopts nothing — may finish. Asked of `lib/setup-credential.js`
  // through the same fact-gatherer the two routes that finish setup use, so the
  // step the wizard shows and the rule each route enforces cannot disagree.
  route('GET', '/api/setup/ingress-state', (_req, res) => {
    const config = store.config.load();
    const duringSetup = config.setupComplete === false;
    const detection = caddy.detectCaddy();
    const state = caddy.classifyIngressState();
    const plan = ingressProvision.decideProvisioning({
      state: state.state,
      safeToWrite: state.safeToWrite,
      caddyAvailable: detection.available,
      ingressMode: config.ingressMode,
      user: duringSetup ? state.user : null
    });
    const credential = _decideSetupCredential(config, { adoptionSupplies: plan.action === 'adopt', optOut: false });
    const skip = _decideSetupCredential(config, { adoptionSupplies: false, optOut: false });
    jsonResponse(res, 200, {
      state: state.state,
      safeToWrite: state.safeToWrite,
      user: duringSetup ? state.user : null,
      userCount: state.users.length,
      caddy: {
        available: detection.available,
        version: detection.version || null,
        error: detection.error || null
      },
      plan: {
        action: plan.action,
        reason: plan.reason,
        remedy: plan.remedy
      },
      credential: {
        required: credential.required,
        optOutAllowed: credential.optOutAllowed,
        optOutRefusal: credential.optOutRefusal,
        skipAllowed: !skip.required
      }
    });
  });

  // GET /api/setup/provision-status — how the ingress cutover the wizard started
  // ended, once it has ended.
  //
  // The cutover restarts this server, so it runs as a detached child and reports
  // through a file rather than a return value (see lib/ingress-provision.js). This
  // route is the read side of that channel.
  //
  // It deliberately needs no Caddy auth-bypass entry: pre-cutover the wizard is
  // served by TangleClaw directly, and the cutover does not move TangleClaw's
  // listen port — so a poll from that page never traverses the perimeter. What the
  // cutover DOES change is the protocol and the interface, which is why the wizard
  // must also handle its own origin disappearing (an operator who reached setup
  // over direct HTTPS, or over a LAN address, loses it at the restart).
  //
  // Nothing secret crosses this boundary, and that is enforced by what is BUILT
  // rather than by what the child happened to write. The response is exactly:
  // `state`, `ok`, `code`, `target`, `healthOk`, `hasError`, `logLocation` (a
  // RELATIVE path — the resolved one names the OS account) and `finishedAt`.
  // The child's free-text `error` is
  // deliberately NOT forwarded — its producer fills that field with absolute
  // filesystem paths (an unreadable Caddyfile names its path, a backup names its
  // path, `caddy validate` stderr names the config and can quote the offending
  // line), and this route has no `setupComplete` gate in front of it. The detail is
  // not lost: it goes to the server log and to the cutover's own log file, where an
  // operator can read it and a stranger cannot.
  route('GET', '/api/setup/provision-status', (_req, res) => {
    const { present, malformed, result } = ingressProvision.readResult();
    if (!present) {
      // Not "failed" — the child may still be running, or may never have started.
      // The wizard distinguishes those by its own deadline, not by this answer.
      //
      // `logLocation` rides along even here, because the case it serves is the one
      // where no better answer ever arrives: a child that dies between writing the
      // plists and calling finish() leaves NO result file, so every poll gets this
      // response until the wizard's deadline expires and it renders the crash
      // screen. The log is then the only durable evidence of what happened, and
      // without this the screen has no name to give for it. It discloses nothing —
      // the constant is a relative path, chosen so it never names the OS account.
      return jsonResponse(res, 200, {
        state: 'pending', ok: null, code: null,
        logLocation: ingressProvision.CUTOVER_LOG_RELATIVE
      });
    }
    if (malformed) {
      // `unparseable-result`, not `unreadable`: this surface already uses
      // `unreadable` for a Caddyfile that cannot be read, and one word meaning two
      // unrelated conditions on the same endpoint family is how a caller ends up
      // answering the wrong one.
      log.warn('Ingress cutover wrote an outcome file that could not be parsed',
        { path: ingressProvision.resultPath() });
      return jsonResponse(res, 200, {
        state: 'unparseable-result',
        ok: null,
        code: null,
        hasError: true,
        logLocation: ingressProvision.CUTOVER_LOG_RELATIVE
      });
    }
    if (result.ok !== true && typeof result.error === 'string' && result.error) {
      // Logged, not returned. This is the operator's copy of the detail the
      // response withholds — but "withheld from the response" is not the same as
      // "safe to log": on the validate-failed path this string is `caddy validate`
      // stderr, which quotes the offending Caddyfile line, and that line is
      // `basic_auth <user> <bcrypt-hash>`. observability-strategy.md forbids
      // passwords hashed or plaintext at any level, so it is redacted here rather
      // than trusted to be hash-free.
      log.warn('Ingress cutover reported a failure',
        { code: result.code || null, error: caddy.redactHashes(result.error) });
    }
    jsonResponse(res, 200, {
      state: 'done',
      ok: result.ok === true,
      code: typeof result.code === 'string' ? result.code : null,
      target: typeof result.target === 'string' ? result.target : null,
      healthOk: typeof result.healthOk === 'boolean' ? result.healthOk : null,
      // `hasError` rather than the message: enough for the wizard to say the
      // cutover reported a reason and name where to read it.
      hasError: typeof result.error === 'string' && result.error.length > 0,
      // A RELATIVE location, not the resolved path. Returning
      // `cutoverLogPath()` here would have re-introduced the disclosure this route
      // just removed — `/Users/<name>/…` names the OS account, on an endpoint with
      // no setupComplete gate. The operator knows where their own home directory is.
      logLocation: ingressProvision.CUTOVER_LOG_RELATIVE,
      finishedAt: typeof result.finishedAt === 'string' ? result.finishedAt : null
    });
  });

  // POST /api/setup/generate-cert — Run mkcert to produce cert.pem + key.pem
  route('POST', '/api/setup/generate-cert', (_req, res, _params, body) => {
    const extras = _certHostListArg(body && body.hosts, 'hosts');
    if (extras.error) return errorResponse(res, 400, extras.error, 'BAD_REQUEST');
    const removals = _certHostListArg(body && body.removeHosts, 'removeHosts');
    if (removals.error) return errorResponse(res, 400, removals.error, 'BAD_REQUEST');
    const reconcileArg = body ? body.reconcileTailnet : undefined;
    if (reconcileArg !== undefined && typeof reconcileArg !== 'boolean' && reconcileArg !== 'prepare') {
      return errorResponse(res, 400, 'reconcileTailnet must be true, false or "prepare"', 'BAD_REQUEST');
    }
    const reconcileTailnet = reconcileArg === true;
    const prepareTailnet = reconcileArg === 'prepare';

    // A mutation boundary: probe the overlay afresh, so the certificate is minted
    // for the name the machine has now, and every later reader of the shared
    // observation (the allowlist, the operator links) sees that same answer (#1905).
    const observation = hostInventory.observeOverlayDns({ refresh: true });
    const cfg = store.config.load();
    let tailnet = hostInventory.resolveTailnetHost(cfg, observation);

    // Reconciling moves the canonical tailnet host, which every consumer reads, so
    // it is refused wherever it cannot move all of them together.
    let reconciled = null;
    let prepared = null;
    if (reconcileTailnet || prepareTailnet) {
      if (!tailnet.drift) {
        return errorResponse(res, 409,
          'reconcileTailnet: the configured tailnet host matches the observed one '
          + `(${tailnet.host || 'none'}), so there is nothing to reconcile`, 'NO_TAILNET_DRIFT');
      }
      const applyCommand = `node scripts/ingress-cutover.js --to caddy --tailnet-host ${tailnet.drift.observed}`;
      if (cfg.ingressMode === 'caddy' && reconcileTailnet) {
        // The live Caddyfile names the configured host too, and this route writes
        // no Caddyfile. Flipping the config here would leave Caddy serving a name
        // the rest no longer do, so caddy mode moves in two phases instead.
        return jsonResponse(res, 409, {
          error: 'reconcileTailnet: in caddy mode the tailnet host moves with the live Caddyfile, in two '
            + 'phases. First {"reconcileTailnet": "prepare"} here, which mints a certificate carrying both '
            + `names; then ${applyCommand}, which moves the site and the config together and rolls back if `
            + `the new site is not healthy. ${tailnet.drift.configured} keeps serving until then.`,
          code: 'RECONCILE_NEEDS_CUTOVER',
          drift: tailnet.drift,
          next: { prepare: { reconcileTailnet: 'prepare' }, apply: applyCommand }
        });
      }
      if (cfg.ingressMode !== 'caddy' && prepareTailnet) {
        return errorResponse(res, 409,
          'reconcileTailnet "prepare" is the first phase of a caddy-mode move. With no live Caddyfile, '
          + '{"reconcileTailnet": true} moves the config and the certificate in one step.',
          'PREPARE_NOT_NEEDED');
      }
      const gateState = authGate.resolveGateState(() => cfg, store.authSessions, _gateIngress);
      if (!caddy.tailnetSiteGated(cfg, gateState)) {
        // `caddyTailnetHost` feeds a Caddy tailnet site, which the generator
        // refuses without a gate: persisting it here would turn the next cutover
        // into a failure.
        return errorResponse(res, 409,
          'reconcileTailnet: caddyTailnetHost feeds a Caddy tailnet site, and that site needs a gate. '
          + 'Arm the TangleClaw login (or enable a Caddy basic_auth credential), then reconcile.',
          'TAILNET_UNGATED');
      }
      if (prepareTailnet) {
        // Prepare changes nothing but the certificate: the config, the allowlist,
        // the links and the live Caddyfile all keep the configured host until the
        // cutover applies the move.
        prepared = { from: tailnet.drift.configured, to: tailnet.drift.observed, apply: applyCommand };
      } else {
        reconciled = { caddyTailnetHost: { from: tailnet.drift.configured, to: tailnet.drift.observed } };
      }
    }
    const effectiveConfig = reconciled
      ? { ...cfg, caddyTailnetHost: reconciled.caddyTailnetHost.to } : cfg;
    if (reconciled) tailnet = hostInventory.resolveTailnetHost(effectiveConfig, observation);

    // Names no request may remove. While reconciling, the outgoing name is still
    // canonical in the saved config until the save below lands, so it stays too.
    // Compared in one normalized form, so `LOCALHOST` or `host.tailnet.ts.net.`
    // cannot slip past the canonical check as a different name.
    const hostKey = (h) => hostInventory.normalizeHostName(h) || String(h).trim().toLowerCase();
    const mandatory = new Set([
      ...httpsSetup.mandatoryCertHosts(effectiveConfig, { observation }),
      ...((reconciled || prepared) ? httpsSetup.mandatoryCertHosts(cfg, { observation }) : []),
      ...(prepared ? [prepared.to] : [])
    ].map(hostKey));
    const removeSet = new Set((removals.hosts || []).map(hostKey));
    const refused = [...removeSet].filter((h) => mandatory.has(h));
    if (refused.length) {
      return jsonResponse(res, 409, {
        error: `removeHosts names ${refused.join(', ')}, which this install serves as a canonical host. `
          + 'Change the host itself (the tailnet host through reconcileTailnet, the machine name or '
          + 'config for the others) so every consumer moves with it.',
        code: 'CANONICAL_HOST_REMOVAL',
        hosts: refused
      });
    }

    let result;
    try {
      // Regeneration is ADDITIVE. Nothing records the host list a cert was minted
      // with, so the cert is its own only record — and this route's shipped caller
      // (`public/setup.js`, the "Generate Certificates" button) sends `{}`, no hosts
      // at all. `certHostUnion` carries every existing name forward with the
      // mandatory ones, `hosts` adds to it, and only `removeHosts` takes a
      // non-canonical name out. The mandatory names are unioned last, so no
      // combination of inputs mints a certificate missing one (#1905).
      const minted = [...new Set([
        ...httpsSetup.certHostUnion(null, effectiveConfig, { observation }),
        ...(extras.hosts || [])
      ])].filter((h) => !removeSet.has(hostKey(h)));
      for (const h of mandatory) {
        if (!minted.some((m) => hostKey(m) === h)) minted.push(h);
      }
      result = httpsSetup.generateCerts({ hosts: minted });
    } catch (err) {
      return errorResponse(res, 500, err.message, 'MKCERT_FAILED');
    }

    if (reconciled) {
      // The config is saved LAST. The certificate now carries both names, so if
      // this save fails the config, the allowlist, the links and the certificate
      // all still agree on the outgoing name: no canonical host is ever uncovered.
      try {
        store.config.save({ ...store.config.load(), caddyTailnetHost: reconciled.caddyTailnetHost.to });
      } catch (err) {
        log.error('Reconcile minted the certificate but could not save the config', {
          error: err.message, from: reconciled.caddyTailnetHost.from, to: reconciled.caddyTailnetHost.to
        });
        return jsonResponse(res, 500, {
          error: `The certificate now carries ${reconciled.caddyTailnetHost.to} as well as `
            + `${reconciled.caddyTailnetHost.from}, but the config could not be saved (${err.message}), `
            + `so ${reconciled.caddyTailnetHost.from} is still the tailnet host everywhere. `
            + 'Retry the same request once the config is writable.',
          code: 'RECONCILE_SAVE_FAILED',
          hosts: result.hosts
        });
      }
      log.info('Reconciled the tailnet host with the observed overlay name', {
        from: reconciled.caddyTailnetHost.from, to: reconciled.caddyTailnetHost.to
      });
    } else if (tailnet.drift) {
      log.warn('Configured tailnet host differs from the observed overlay name', tailnet.drift);
    }

    const mintedSet = new Set((result.hosts || []).map((h) => String(h).toLowerCase()));
    jsonResponse(res, 200, {
      ok: true,
      certPath: result.certPath,
      keyPath: result.keyPath,
      hosts: result.hosts,
      expiry: result.expiry,
      remoteTrust: httpsSetup.getRemoteTrustInstructions(result.carootPath),
      inventory: {
        tailnet: {
          host: tailnet.host,
          source: tailnet.source,
          provider: tailnet.provider,
          caddySite: tailnet.caddySite,
          drift: tailnet.drift,
          omission: tailnet.omission,
          covered: tailnet.host ? mintedSet.has(tailnet.host) : null
        },
        reconciled,
        prepared
      }
    });
  });

  // POST /api/setup/scan — Scan a directory for existing projects
  //
  // The scan itself lives in lib/projects because it must run off the main thread
  // under a deadline: this route reads a directory the operator types in, and on
  // macOS that can be a TCC-protected folder (~/Documents and its siblings),
  // where a read does not fail — it never returns. Inline and synchronous, that
  // blocked the event loop and took the whole server down on the first click of a
  // fresh install (#859).
  route('POST', '/api/setup/scan', async (_req, res, _params, body) => {
    // An all-whitespace path is not "no path": `path.resolve('')` is the server's
    // own working directory, so without this the wizard would scan the install
    // itself and offer its subdirectories as projects.
    if (!body || typeof body.directory !== 'string' || !body.directory.trim()) {
      return errorResponse(res, 400, 'directory is required', 'BAD_REQUEST');
    }

    const result = await projects.scanDirectoryForProjects(body.directory);
    if (!result.ok) {
      return errorResponse(res, 400, result.error, result.code);
    }

    jsonResponse(res, 200, { projects: result.projects });
  });

  // POST /api/setup/create-dir — Create the projects directory the operator named.
  //
  // The shipped default (~/Projects) does not exist on a stock Mac, so the first
  // thing a new install does — accept the pre-filled path, press
  // Next — used to answer "Directory does not exist" and stop, with no action
  // available anywhere in the product.
  //
  // Unauthenticated by necessity: this is first-run setup, before any credential
  // exists. The constraint in `createProjectsDir` is therefore the boundary — one
  // level, inside the operator's home directory — not a stand-in for one.
  route('POST', '/api/setup/create-dir', async (_req, res, _params, body) => {
    if (!body || typeof body.directory !== 'string' || !body.directory.trim()) {
      return errorResponse(res, 400, 'directory is required', 'BAD_REQUEST');
    }

    const result = await projects.createProjectsDir(body.directory);
    if (!result.ok) {
      return errorResponse(res, 400, result.error, result.code);
    }

    jsonResponse(res, 200, { ok: true, path: result.path, created: result.created });
  });

  // POST /api/setup/complete — Batch setup: update config + attach projects
  route('POST', '/api/setup/complete', async (req, res, _params, body) => {
    if (!body || typeof body !== 'object') {
      return errorResponse(res, 400, 'Request body must be a JSON object', 'BAD_REQUEST');
    }

    let config = store.config.load();
    const warnings = [];
    // Captured before this handler sets it. Provisioning is a FIRST-RUN action: it
    // rewrites launchd plists and restarts the server, and this route has never
    // required setup to be unfinished. Re-POSTing it on a completed install must
    // therefore not be a way to trigger an ingress cutover — on an install that is
    // ungated and network-reachable (the legacy grace state) that would hand an
    // unauthenticated caller a service restart. Changing the credential on a
    // finished install is a settings action with its own surface, not this one.
    const firstRun = config.setupComplete === false;

    // A login is the DEFAULT outcome of setup, not something that happens only on a
    // machine already running behind Caddy. The same derivation the wizard asked for
    // at GET /api/setup/ingress-state decides what this install can have, so the two
    // cannot disagree about a machine between the step list and the submission:
    //
    //   provision → the wizard collected a credential; persist it, then hand the
    //               cutover to a detached child (it restarts this server, so this
    //               handler cannot run it and live to report the outcome).
    //   adopt     → a working hand-rolled gate is already in front of us; take its
    //               credential into config and never collect a second one.
    //   refuse    → nothing may be written. Finish honestly ungated rather than
    //               storing a credential nothing enforces.
    const ingressDetection = caddy.detectCaddy();
    const ingressState = caddy.classifyIngressState();
    const ingressPlan = firstRun
      ? ingressProvision.decideProvisioning({
        state: ingressState.state,
        safeToWrite: ingressState.safeToWrite,
        caddyAvailable: ingressDetection.available,
        ingressMode: config.ingressMode,
        user: ingressState.user
      })
      // Already-complete install: report the state, act on nothing. `refuse` is the
      // no-op action, so a re-POST persists whatever config fields it carries and
      // leaves the ingress exactly as it found it.
      : { action: 'refuse', reason: 'Setup is already complete, so the ingress was left unchanged.',
        remedy: null, user: null };

    // Adoption happens HERE, before the credential gates below, because it is what
    // supplies the credential in this case. Run after them and a caddy-mode install
    // whose hand-maintained Caddyfile already holds the only login would be refused
    // with ADMIN_REQUIRED — the one shape the adopt path exists to serve.
    //
    // `adoptCredentialIntoConfig` persists its own copy of config, so re-read
    // rather than carrying a stale object forward. Safe at this point precisely
    // because nothing from the request body has been applied yet.
    let adoption = null;
    if (ingressPlan.action === 'adopt') {
      // requireCaddyMode is off because the plan already established that Caddy IS
      // the live ingress — the guard's own question, asked one layer up.
      adoption = caddy.adoptCredentialIntoConfig({ requireCaddyMode: false });
      if (adoption.changed) config = store.config.load();
    }

    // Setup cannot finish with no engine installed. TangleClaw's whole job is
    // launching AI coding sessions, and an install with no engine is a dashboard
    // that can launch nothing — the operator reaches a finished-looking product
    // and discovers the hole at the first Launch button, with nothing on screen
    // explaining it.
    //
    // Refused HERE and not only in the wizard, because the wizard's Next button
    // is not the rule. Anything that POSTs this route — a re-run, a script, a
    // client that skipped the step — must meet the same bar, or the gate is
    // decoration. `feedback_symmetric_capability_gates`: the two surfaces
    // coordinating around one condition have to test the same condition.
    //
    // First run only. A finished install whose engine was later uninstalled is a
    // different problem, and refusing to re-save its settings would strand it.
    // `refresh` because the operator has probably just installed one in another
    // window, which is the entire reason this request is being made again.
    if (firstRun) {
      if (!await engines.anyEngineInstalled()) {
        return errorResponse(
          res,
          400,
          'No AI engine is installed, so there would be nothing to launch. Install one '
          + '(Claude Code, Codex, Aider or Antigravity), then press Check again.',
          'ENGINE_REQUIRED'
        );
      }
    }

    // Snapshot HTTPS state before mutations so we can decide whether to restart
    const prevHttps = {
      enabled: !!config.httpsEnabled,
      certPath: config.httpsCertPath || null,
      keyPath: config.httpsKeyPath || null
    };

    // Update config fields
    if (body.projectsDir && typeof body.projectsDir === 'string') {
      config.projectsDir = body.projectsDir;
    }
    // The Master's launch mode belongs to the engine it was chosen for, and a
    // Master with no pin follows the default engine. So setting the default
    // engine here is judged by the same rule as `PATCH /api/config`: a mode
    // chosen for the previous engine returns to `default`, and the response says
    // so. This route sends no launch mode, so it can only keep or reset one.
    let masterModeReset = null;
    if (body.defaultEngine && typeof body.defaultEngine === 'string') {
      const masterEngineBefore = { defaultEngine: config.defaultEngine, master: config.master };
      config.defaultEngine = body.defaultEngine;
      const outcome = master.masterLaunchModeAfterPatch(masterEngineBefore, config, undefined);
      const held = master.masterSettings(config);
      if (held.launchMode !== outcome.launchMode || held.launchModeEngine !== outcome.launchModeEngine) {
        config.master = { ...held, launchMode: outcome.launchMode, launchModeEngine: outcome.launchModeEngine };
      }
      if (outcome.reset) {
        masterModeReset = outcome.reset;
        warnings.push(master.masterLaunchModeResetWarning(outcome.reset));
      }
    }
    if (body.deletePassword !== undefined) {
      if (body.deletePassword && typeof body.deletePassword === 'string') {
        config.deletePassword = projects.hashPassword(body.deletePassword);
      } else {
        config.deletePassword = null;
      }
    }
    if (typeof body.chimeEnabled === 'boolean') {
      config.chimeEnabled = body.chimeEnabled;
    }

    // HTTPS fields
    if (typeof body.httpsEnabled === 'boolean') {
      config.httpsEnabled = body.httpsEnabled;
    }
    if (body.httpsCertPath === null || typeof body.httpsCertPath === 'string') {
      config.httpsCertPath = body.httpsCertPath || null;
    }
    if (body.httpsKeyPath === null || typeof body.httpsKeyPath === 'string') {
      config.httpsKeyPath = body.httpsKeyPath || null;
    }

    if (config.httpsEnabled && config.httpsCertPath && config.httpsKeyPath) {
      const validation = httpsSetup.validateCertFiles(config.httpsCertPath, config.httpsKeyPath);
      if (!validation.ok) {
        return errorResponse(res, 400, `HTTPS cert validation failed: ${validation.error}`, 'BAD_REQUEST');
      }
    } else if (config.httpsEnabled && (config.httpsCertPath || config.httpsKeyPath)) {
      return errorResponse(res, 400, 'Both httpsCertPath and httpsKeyPath are required when HTTPS is enabled with cert paths', 'BAD_REQUEST');
    }

    // The login. A first run supplies one (adminUser + adminPassword, which become
    // TangleClaw's own account below), already has one, adopts a Caddy one, or
    // carries the operator's explicit choice of none. Which of those lets setup
    // finish is `lib/setup-credential.js`'s decision, enforced here server-side so
    // no client can bypass it.
    const adminProvided = body.adminUser !== undefined || body.adminPassword !== undefined;
    // The operator's explicit choice of no login, made on the wizard's login step.
    // A boolean or absent — anything else is a malformed request rather than a
    // choice, and guessing either way on a security decision is the wrong answer.
    if (body.noLogin !== undefined && typeof body.noLogin !== 'boolean') {
      return errorResponse(res, 400, 'noLogin must be a boolean', 'BAD_REQUEST');
    }
    const noLogin = body.noLogin === true;
    if (noLogin && adminProvided) {
      return errorResponse(res, 400,
        'A login and the choice of no login were both sent. Send one or the other.', 'BAD_REQUEST');
    }
    if (noLogin && !firstRun) {
      return errorResponse(res, 409,
        'Setup is already complete, so the choice of no login is not made here.',
        'SETUP_ALREADY_COMPLETE');
    }
    // The credential write is first-run only, for the same reason the cutover spawn
    // above is: this route authenticates nobody. Without this, an unauthenticated
    // caller could POST a credential of their choosing onto an ALREADY-COMPLETED
    // install — and on the ungated, network-reachable legacy grace state that is
    // reachable from off-box. Refuse loudly rather than ignoring the field: silently
    // dropping a credential the caller believes it set is its own false report, and
    // the wizard would have no way to tell the difference.
    if (adminProvided && !firstRun) {
      // Names both routes that can change a credential on a completed install: the
      // settings surface, which refuses unless a live gate is already
      // authenticating the caller, and the script, which requires local shell
      // access. Either bar is the right one for a route that authenticates nobody.
      //
      // A completed install with no login at all is not this route's either: a first
      // run is the only time this route sets one.
      return errorResponse(res, 409,
        'Setup is already complete. Change the admin login from global settings, or run '
        + '`node scripts/reset-admin.js` at a terminal.',
        'SETUP_ALREADY_COMPLETE');
    }
    if (adminProvided) {
      const adminUser = typeof body.adminUser === 'string' ? body.adminUser.trim() : '';
      const adminPassword = typeof body.adminPassword === 'string' ? body.adminPassword : '';
      if (!adminUser) {
        return errorResponse(res, 400, 'adminUser is required to set an admin credential', 'BAD_REQUEST');
      }
      const pwCheck = caddy.validateAdminPassword(adminPassword, adminUser);
      if (!pwCheck.ok) {
        return errorResponse(res, 400, pwCheck.error, 'BAD_REQUEST');
      }
      // The login itself is the TangleClaw account created below, which needs no
      // Caddy. The Caddy (bcrypt) copy is what a Caddy gate would enforce, and what
      // the fallback rebuild puts back if TangleClaw's own login ever breaks, so it
      // is made whenever `caddy hash-password` answers. A hashing failure on a
      // machine where Caddy was detected is still refused: there a Caddy gate may
      // need the copy, and a silent gap is worse than a retry. Where Caddy was NOT
      // detected there is no Caddy gate to hold it, and refusing the account for
      // want of it would leave the install with no login at all.
      let hash = null;
      try {
        hash = caddy.hashPassword(adminPassword);
      } catch (err) {
        // Never log the plaintext; the message is the caddy failure, not the secret.
        if (ingressDetection.available) {
          log.error('Admin credential hashing failed during setup', { error: err.message });
          return errorResponse(res, 500, `Could not hash admin password: ${err.message}`, 'HASH_FAILED');
        }
        log.info('No Caddy copy of the login was made, because Caddy is not installed', { error: err.message });
      }
      if (hash) {
        config.basicAuthUser = adminUser;
        config.basicAuthHash = hash;
      }
      config.authEnabled = true;
      log.info('Login set during setup', {
        user: adminUser, ingressMode: config.ingressMode, caddyCopy: hash !== null
      });
    }

    // The one decision (#804): whether setup may finish as things now stand. A
    // login in hand satisfies it; so does the operator's choice of none, where
    // that choice cannot leave the dashboard ungated and reachable.
    //
    // The adoption above supplies a login only when it actually adopted one — a
    // declined adoption supplies nothing, and must not finish setup as if it had.
    //
    // First run only, like the engine requirement: the demand stops a first run
    // finishing unprotected, and applied to a completed install's re-POST it would
    // make an unrelated field update impossible instead.
    const credential = _decideSetupCredential(config, {
      adoptionSupplies: !!(adoption && adoption.adopted), optOut: noLogin
    });
    if (noLogin && !credential.optOutAllowed) {
      return errorResponse(res, 400, credential.optOutRefusal.reason, 'OPT_OUT_REFUSED');
    }
    if (firstRun && credential.required) {
      return errorResponse(res, 400,
        'A username and password are required to finish setup — TangleClaw puts a login in front of '
        + 'itself by default. Set one, or choose to finish without one.',
        'ADMIN_REQUIRED');
    }
    // Recorded, so "the operator chose no login" is never confused with "nobody
    // asked": `authEnabled: false` is also what a config that predates setup says.
    // A login set here clears an earlier choice: `store.config.save` never writes
    // the record beside `authEnabled: true`. The refusal above covers a login
    // already in hand, so reaching here with `noLogin` means the choice is honoured.
    const optedOut = noLogin;
    if (optedOut) {
      config.loginOptOutAt = new Date().toISOString();
    }
    const adminConfigured = !!(config.authEnabled && config.basicAuthUser && config.basicAuthHash);

    // The TangleClaw account, from the same username and password. Setting
    // `authEnabled` closes TangleClaw's own gate while no account exists
    // (`account-required`), and this route's own browser is the first thing that
    // would meet it: the wizard keeps polling and loading after this response.
    // Creating the account here — the one moment the plaintext is in hand — and
    // signing the wizard in keeps setup from locking itself out, and makes the
    // password the operator just chose the one that signs in.
    //
    // Created BEFORE the config save, so a failure leaves setup unfinished and
    // retryable rather than finished with no account. An existing account (an
    // operator who ran `reset-admin.js --store` first) is kept, not replaced.
    //
    // The account's first recovery codes are minted with it and returned once, on
    // this response — the wizard shows them before anything else, because a
    // cutover started below restarts the server and nothing can be fetched after.
    // A failure to mint must not undo the account (it is created and signed in, and
    // codes can be generated in Settings), so it is logged and reported as
    // `recoveryCodes: null`, as the account-setup page does.
    const account = { created: false, required: false, loginInForce: false, username: null, recoveryCodes: null };
    if (adminProvided && config.authEnabled === true) {
      const adminUser = body.adminUser.trim();
      try {
        const user = store.users.createFirst(adminUser, body.adminPassword);
        _signIn(req, res, user);
        account.created = true;
        account.username = user.username;
        try {
          account.recoveryCodes = store.recoveryCodes.replaceForUser(user.id).map(recoveryCodes.formatCode);
        } catch (err) { // prawduct:allow prawduct/broad-except -- the account already exists; any failure is logged and reported as no codes
          log.error('Could not generate recovery codes for the account setup created', {
            username: user.username, error: err.message
          });
        }
      } catch (err) {
        if (err.code !== 'ACCOUNT_EXISTS') throw err;
        log.info('Setup kept the existing TangleClaw account rather than creating one');
      }
    }
    // Setup that finishes with the gate on and still no account — the adopt path,
    // whose credential came from a Caddyfile and so has no plaintext — leaves the
    // install `account-required`. The wizard reads this and sends the operator to
    // the account page rather than into a dashboard that would refuse it.
    // Asked of the gate's own classifier against the config about to be saved,
    // not re-derived here — one owner of what `account-required` means.
    const setupGateState = authGate.resolveGateState(() => config, store.authSessions, _gateIngress);
    // A gate that cannot read its own store cannot say whether an account exists,
    // and "no account required" would send the wizard on into a dashboard that
    // refuses it. Refused BEFORE the save, so setup stays unfinished and can be
    // retried; the gate itself still enforces, so nothing is exposed meanwhile.
    if (setupGateState === authGate.GATE_STATES.UNREADABLE) {
      return errorResponse(res, 503,
        'TangleClaw could not read its account store, so it cannot tell whether setup left you an account. '
        + 'Setup did not finish (an account you entered may already exist, and trying again keeps it); '
        + 'try again, and check the server log if it persists.',
        'GATE_UNREADABLE');
    }
    account.required = setupGateState === authGate.GATE_STATES.ACCOUNT_REQUIRED;
    // Whether TangleClaw's own login asks for a password once this saves, with or
    // without Caddy in front. The wizard's screens say whether a password is asked
    // from this, not from how a cutover ended: a cutover that fails leaves the
    // account armed, and "nothing is asking for a password" would then be false.
    account.loginInForce = authGate.guardsTheDoor(setupGateState);

    // Mark setup as complete
    config.setupComplete = true;
    store.config.save(config);
    if (masterModeReset) {
      log.info('Master launch mode reset to default: setup changed the default engine the Master follows and the mode was chosen for the previous one', {
        fromEngine: masterModeReset.fromEngine, toEngine: masterModeReset.toEngine,
        fromMode: masterModeReset.mode, toMode: 'default'
      });
    }
    if (optedOut) {
      log.warn('Setup finished without a login, as the operator chose', { ingressMode: config.ingressMode });
    }

    // Attach selected projects
    const attached = [];
    // Resolved once for the whole batch. `resolveDefaultEngine` runs
    // `listWithAvailability()`, which shells out a detection probe per engine
    // profile, so resolving per item multiplied that across the request — and a
    // mid-batch change in what is installed would register different projects
    // against different engines, which is worse than being slow.
    const batchDefaultEngine = engines.resolveDefaultEngine(config)
      || config.defaultEngine
      || store.DEFAULT_CONFIG.defaultEngine;
    if (Array.isArray(body.projects)) {
      for (const proj of body.projects) {
        if (!proj || !proj.name || !proj.path) continue;

        // Validate path exists and is a directory before registering
        if (!fs.existsSync(proj.path) || !fs.statSync(proj.path).isDirectory()) {
          warnings.push(`Skipped "${proj.name}": path does not exist or is not a directory`);
          continue;
        }

        // Skip if already registered — case-insensitive identity check (#221)
        // so the startup-sync doesn't silently double-register a case-collision.
        const existing = store.projects.getByNameCaseInsensitive(proj.name);
        if (existing) {
          const msg = existing.name === proj.name
            ? `Project "${proj.name}" already registered, skipped`
            : `Project "${proj.name}" already registered as "${existing.name}" (case-insensitive match), skipped`;
          warnings.push(msg);
          continue;
        }

        // Register in SQLite
        try {
          // Resolve against installed engines — the wizard's own engine step shows
          // what's available, so attaching against an uninstalled default would
          // contradict the screen the operator just used. Falls back to the
          // configured intent when nothing is installed (attaching is bookkeeping;
          // it doesn't run an engine).
          const engineId = batchDefaultEngine;

          store.projects.create({
            name: proj.name,
            path: proj.path,
            engine: engineId,
            tags: [],
            ports: {}
          });

          // Write per-project config if none exists
          const projConfigPath = path.join(proj.path, '.tangleclaw', 'project.json');
          if (!fs.existsSync(projConfigPath)) {
            const projConfig = JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG));
            projConfig.engine = engineId;
            store.projectConfig.save(proj.path, projConfig);
          }

          attached.push(proj.name);
        } catch (err) {
          warnings.push(`Failed to attach "${proj.name}": ${err.message}`);
        }
      }
    }

    // ── Put the login in force (or say honestly that none is) ──
    //
    // Deliberately the LAST thing before the response. The cutover child's final
    // act is `launchctl kickstart -k` on this server, so anything still to do here
    // — attaching projects above, writing the response below — must already be
    // done or in flight. Spawning earlier would race a restart against the work.
    const hostHeader = (req.headers && req.headers.host) ? String(req.headers.host) : '';
    // Validated, not merely split. This value is echoed back into a URL the wizard
    // renders into markup, and a `Host` header is caller-supplied — so anything
    // outside a hostname's own alphabet is discarded rather than escaped. Escaping
    // is the wrong tool here: HTML-entity-encoding a quote inside an inline event
    // handler decodes back to a quote before the script sees it, which reopens the
    // hole it was supposed to close. Same alphabet the mkcert host check uses.
    const rawHostname = hostHeader.split(':')[0];
    const requestHostname = (rawHostname && HOST_RE.test(rawHostname)) ? rawHostname : 'localhost';
    const ingress = {
      action: ingressPlan.action,
      provisioning: false,
      // Sent with the completion, not only from the poll, because the poll is
      // exactly what may never answer: the cutover restarts the server and closes
      // the address this page was served from, and for a remote operator that is
      // the COMMON case. The wizard then ends on a screen that knows least about
      // what happened and most needs to say where the rest is written. Delivering
      // it here means it arrives before the origin can close. Relative on purpose —
      // the resolved path names the OS account.
      logLocation: ingressProvision.CUTOVER_LOG_RELATIVE,
      // 'pending' only ever means "a cutover is running and the answer is not in
      // yet"; the wizard resolves it by polling /api/setup/provision-status.
      protection: 'none',
      // Whenever this ends with no login in force, the explanation goes into BOTH
      // `reason` and `warnings`. `warnings` is the complete machine-readable list,
      // because a client that reads only that field must still learn the install is
      // ungated; `reason` is the wizard's prose copy. They overlap by design.
      //
      // The push happens once, after the whole if/else chain below — not per-arm. An
      // outcome can reach no arm at all, and per-arm pushes left that case reporting
      // nothing. De-duplicating belongs at the point of RENDER: `_warningsBlock` in
      // public/setup.js drops any warning the screen has already printed. Suppressing
      // the push instead silently narrows the API for every non-wizard consumer.
      reason: ingressPlan.reason || null,
      remedy: ingressPlan.remedy || null,
      user: null,
      url: null,
      // Whether the network can reach this server, read from the one classification
      // rather than assumed. "Ungated but loopback-only" and "ungated and reachable"
      // are different situations, and the wizard must not tell an install held wide
      // in the legacy grace state that it is reachable from this machine only —
      // that is the operator most at risk of believing a false reassurance.
      networkExposed: bindPolicy.describeBindState(config).wide === true
    };

    if (optedOut) {
      // The operator chose no login. A cutover would put Caddy in front to carry a
      // gate that was declined, so none is started; the install stays as it is.
      ingress.reason = 'Setup finished without a login, as you chose. Anyone who can reach this address '
        + 'can use TangleClaw, including its terminals.';
      ingress.remedy = 'Add a login later from global settings.';
    } else if (ingressPlan.action === 'provision') {
      // spawnCutover clears any previous outcome itself, so the poller cannot read
      // an earlier run's result as this one's.
      const started = _spawnCutover({ target: 'caddy' });
      if (started.ok) {
        ingress.provisioning = true;
        ingress.protection = 'pending';
        ingress.user = config.basicAuthUser || null;
        // Where the gate is about to listen. Asked of the config this cutover is
        // MOVING to, not the one on disk — `ingressMode` is still whatever it was
        // until the cutover writes it, and the question here is where the operator
        // goes once this lands. One derivation, shared with the restart redirect
        // below, so the two answers to "where do I go now" cannot drift.
        ingress.url = httpsSetup.effectiveOperatorOrigin(
          { ...config, ingressMode: 'caddy' }, requestHostname);
        // The whole address, not just the host: scheme and port are the two halves
        // this derivation exists to get right, and the operator is almost never at
        // this machine to read the browser that was told them.
        log.info('Setup started the ingress cutover',
          { pid: started.pid, host: requestHostname, operatorUrl: ingress.url });
      } else {
        // Caddy was not put in front. Whether a password is asked anyway is the gate
        // state's answer, read after this chain: the account created above is
        // TangleClaw's own login and enforces without Caddy. The reason says only
        // what failed, and reaches `warnings` whether or not the login is in force.
        ingress.reason = `TangleClaw could not start the ingress cutover: ${started.error}. `
          + 'Caddy was not put in front of TangleClaw.';
        ingress.remedy = 'Run `node scripts/ingress-cutover.js --to caddy` at a terminal.';
        warnings.push(ingress.reason);
        log.error('Setup could not start the ingress cutover', { error: started.error });
      }
    } else if (ingressPlan.action === 'adopt') {
      // Adoption already ran, above the credential gates. Report what it answered.
      const after = config;
      if (adminProvided) {
        // The operator typed a credential on a machine whose plan was to ADOPT one.
        // Reachable from any client that sends one on an adopt plan (the wizard's own
        // step is not shown there, but the route authenticates nobody). Adoption ran first,
        // then the typed credential overwrote it in config — so config now holds what
        // they typed while the untouched hand-maintained Caddyfile still enforces what
        // was adopted. Their new password will not work and the old one will.
        //
        // Reporting `existing` here (naming the ADOPTED user, which is what the code
        // did) tells them their existing login was kept when in fact two credentials
        // now disagree. Name the mismatch instead, and name the account THEY set.
        ingress.protection = 'existing-unverified';
        ingress.user = after.basicAuthUser || null;
        ingress.reason = 'The login you just set has been saved, but the Caddy config in front of '
          + 'TangleClaw is maintained by hand and was not changed — so it is still enforcing the '
          + 'credential it already had, not the new one.';
        ingress.remedy = 'Set both from one place with `node scripts/reset-admin.js`, which rewrites '
          + 'the credential in the live Caddy config as well.';
        // `reason` reaches `warnings` from the single push after this chain — see the
        // note on `reason` above. The screen still shows it once because the render
        // de-duplicates, not because any arm withholds it.
        log.warn('Setup saved a credential the live Caddy config does not enforce', {
          user: after.basicAuthUser || null
        });
      } else if (adoption && adoption.adopted) {
        ingress.protection = 'existing';
        ingress.user = adoption.user || after.basicAuthUser || null;
      } else if (after.authEnabled && after.basicAuthUser && after.basicAuthHash) {
        // Config already carried a credential, so adoption deliberately no-opped
        // rather than overwriting it. The live Caddyfile may enforce a DIFFERENT
        // one, and nothing here can tell — so this is not "your existing login was
        // kept". Reporting it as such is how a config-vs-live mismatch becomes
        // invisible, which this repo already ships an auth-drift warning for.
        ingress.protection = 'existing-unverified';
        ingress.user = after.basicAuthUser;
        ingress.reason = 'A login is already configured and a hand-maintained Caddy config is in front '
          + 'of TangleClaw. TangleClaw did not change either, and cannot tell whether they carry the '
          + 'same credential.';
        ingress.remedy = 'If your saved login does not work, set both from one place with '
          + '`node scripts/reset-admin.js`.';
      } else {
        ingress.reason = 'An existing Caddy login was found but could not be adopted'
          + `${adoption && adoption.reason ? ` (${adoption.reason})` : ''}, so TangleClaw cannot confirm a login is in force.`;
        ingress.remedy = 'Set the credential explicitly with `node scripts/reset-admin.js`.';
        // Unreachable by construction, kept as the honest fallback if that ever changes.
        // A declined adoption supplies no login, so the credential decision above refuses
        // the request before this block runs unless one is already in hand — and the
        // choice of no login is refused too, because the Caddyfile being adopted carries
        // one. Pinned by "refuses outright when adoption declines and no credential is
        // configured".
        log.warn('Setup could not adopt the existing Caddy login', {
          reason: (adoption && adoption.reason) || null
        });
      }
    } else if (adminConfigured && !authGate.guardsTheDoor(setupGateState)) {
      // Refused, but a credential IS configured (an install already in caddy mode,
      // or one the operator set earlier). It is stored, and the live Caddyfile will
      // not be regenerated from here — so nothing at this point can confirm the
      // credential is enforced. Deliberately NOT "as active as that file makes it":
      // two states reaching this arm have nothing serving that file at all, and the
      // warning below exists precisely because naming the Caddyfile as what governs
      // protection is a false reassurance. Activating belongs at a terminal, where
      // the cutover's backup and rollback exist.
      ingress.protection = 'unchanged';
      ingress.user = config.basicAuthUser || null;
      // States the situation and names no command. Every path here is refuse +
      // adminConfigured, and in almost all of them the live Caddyfile is hand-edited —
      // so a bare `--to caddy` is the form the cutover's own guard REFUSES, and for an
      // unreadable file `--force` is not honored at all. The plan's `remedy` is the
      // state-specific answer and renders on this same screen; a fixed command here
      // put the failing form under "Also worth knowing" beside the working one.
      //
      // It also must not name the Caddyfile as what determines whether the login is
      // active. In two states nothing is serving that file at all — no Caddy binary, or
      // an adoptable config while the install runs in direct mode — and claiming the file
      // governs protection is the false-reassurance this endpoint exists to avoid. Say
      // only what is true everywhere: the live ingress was not changed, so nothing here
      // can confirm the login is enforced.
      warnings.push('Admin credential saved, but TangleClaw did not change the live ingress '
        + 'config — so it cannot confirm anything is enforcing this login.');
      // A completed install re-POSTing here gets a plan built without `decideProvisioning`,
      // whose `remedy` is null — so removing the command from the warning above left that
      // path with no next step whatsoever. The dry-run is the one instruction that is both
      // safe and honest in every state: it writes nothing, and it reports the situation it
      // finds rather than assuming a gate can be activated.
      if (!ingress.remedy) {
        ingress.remedy = 'Run `node scripts/ingress-cutover.js --to caddy --dry-run` at a '
          + 'terminal to see what activating the login gate would do.';
      }
    }

    // THE derivation of what `protection` MEANS, in one place, next to where the value
    // is produced (#861). Before this, the same judgement was re-made by comparing the
    // enum against a literal list in three places — once here and TWICE in
    // `public/setup.js` — so the browser was a second source of truth for a security
    // decision. There is no build step, so a shared constant module is not importable by
    // `public/`; deriving server-side and shipping the ANSWER is the available correct
    // form, and it is the same one `decideProvisioning` already uses for the
    // provisioning table.
    //
    // Stated as an ALLOWLIST, and that inversion is the substance of the fix rather than
    // a stylistic preference. The old lists enumerated the states meaning "not protected",
    // so an unrecognised sixth value matched none of them and fell through to the path
    // that DISMISSES the warning — a new state would silently stop telling the operator
    // nothing is enforcing a login, which is the precise false-reassurance the v5 Secure
    // Baseline exists to eliminate. Naming the states that mean "confirmed" instead
    // makes an unknown value fail safe: not confirmed, so the operator is told.
    //
    // Which states produce which SCREEN is unchanged, deliberately: this change is a
    // de-duplication, and these are the least-verified screens in the release (#802),
    // so what is decided must not move in the same commit that moves WHO decides it.
    // `credentialStored` is a wider set than the pair `public/setup.js` used to test —
    // it includes the confirmed state, because the field is named for a fact and must
    // report it — but that value is unreachable by the only consumer, which reads it
    // solely inside the not-confirmed branch. Wider field, identical screens.
    //
    // TangleClaw's own login is in force whenever the gate guards the door, with
    // or without Caddy — so a setup that did not (or could not) touch Caddy but left
    // an armed account is protected, and saying "no login" there would be false.
    // Not while a cutover is pending (its poll reports the outcome), and not over
    // an adopt arm, whose Caddy login and a typed account may disagree and whose
    // wording already says so.
    if (!ingress.provisioning && ingressPlan.action !== 'adopt' && authGate.guardsTheDoor(setupGateState)) {
      ingress.protection = 'account';
      // The account that signs in. When setup kept an existing account, the name
      // typed here may not be its name, so none is claimed.
      ingress.user = account.username || (adminProvided ? null : config.basicAuthUser) || null;
      // A refusing plan's reason is about Caddy ("cannot put a login in front of
      // itself yet"), which stops being true of the install once its own login
      // guards the door. A failed cutover's reason is kept: it names what failed.
      if (ingressPlan.action === 'refuse') {
        ingress.reason = null;
        ingress.remedy = null;
      }
    }
    Object.assign(ingress, ingressProvision.deriveProtectionFlags(ingress.protection));

    // One place, after every branch, so the guarantee holds for outcomes that reach no
    // branch at all — `refuse` with no credential anywhere (no Caddy installed, or a
    // Caddyfile too ambiguous to adopt) sets `reason` from the plan and enters nothing
    // below. Doing this per-arm left exactly that case — the plainest ungated install
    // there is — telling a warnings-only client nothing.
    //
    // Only the states that mean "no login is in force" qualify. 'existing' is excluded
    // because its `reason` describes a gate that IS in force ("will be kept rather than
    // replaced") — restating that as a warning invents a problem. 'pending' is excluded
    // too, but is inert rather than dangerous: `decideProvisioning` returns an empty
    // reason for `provision`, so there is nothing to push in that state either way. Both
    // exclusions now read off the derived answers rather than re-listing the enum:
    // `provisioning` is set in the same block as 'pending' and is its only producer.
    //
    // The `includes` check is a forward interlock, not a live de-duplicator: no arm above
    // pushes this exact string today, so it never fires. It is here so that adding an arm
    // that does push `reason` cannot silently double it.
    if (ingress.reason
        && !ingress.confirmedProtection
        && !ingress.provisioning
        && !warnings.includes(ingress.reason)) {
      warnings.push(ingress.reason);
    }

    // Whether setup ended with a login in force is the outcome this endpoint exists to
    // get right, and until now only the unhappy arms left a trace: the confirmed arm
    // dismissed into the dashboard silently, so a support question about an install
    // that "says it is protected" had nothing on the server to read back. Logged at
    // both outcomes so the record is symmetric — an absent line means the request never
    // reached here, rather than meaning everything was fine.
    log.info('Setup reported its protection verdict', {
      protection: ingress.protection,
      confirmedProtection: ingress.confirmedProtection,
      credentialStored: ingress.credentialStored,
      provisioning: ingress.provisioning === true
    });

    // Decide whether to schedule a restart so the server re-binds with the new protocol
    const prevWillServeHttps = !!(prevHttps.enabled && prevHttps.certPath && prevHttps.keyPath);
    const willServeHttps = !!(config.httpsEnabled && config.httpsCertPath && config.httpsKeyPath);
    const httpsChanged = prevHttps.enabled !== !!config.httpsEnabled
      || prevHttps.certPath !== (config.httpsCertPath || null)
      || prevHttps.keyPath !== (config.httpsKeyPath || null);
    // A running cutover restarts the server itself, as its last launchctl step. A
    // second restart scheduled here would race it — and in caddy mode the HTTPS
    // config it exists to apply is not what the listener uses anyway (Caddy
    // terminates TLS; `effectiveServerProtocol` returns http). The cert the wizard
    // generated is still used — by Caddy, via the cutover.
    const shouldRestart = !ingress.provisioning
      && httpsChanged && (willServeHttps || prevWillServeHttps);

    let redirectUrl = null;
    let redirectVia = null;
    if (shouldRestart) {
      // The same derivation the provisioning arm uses. It used to compose the
      // scheme from `willServeHttps` and the port from TC's own listener, which is
      // right in direct mode and wrong in caddy mode — where TC serves plain HTTP
      // on the loopback and the front door is Caddy's HTTPS port. That case is
      // reachable: a caddy-mode install whose operator changes a cert path in the
      // wizard satisfies `shouldRestart`, and the old expression sent them to a
      // port nothing answers on.
      const frontDoor = httpsSetup.effectiveOperatorFrontDoor(config, requestHostname);
      redirectUrl = frontDoor.origin;
      // Who answers there, so the wizard does not read a response as proof the
      // server is back. Behind Caddy it is not: Caddy stays up across TC's restart
      // and answers immediately — with a 502, which an opaque `no-cors` probe
      // cannot tell from success.
      redirectVia = frontDoor.via;
      log.info('Setup will restart; operator front door computed',
        { redirectUrl, via: redirectVia });
      _scheduleRestart();
    }

    if (warnings.length > 0) {
      // A skipped project vanished silently before: the wizard never read
      // `warnings`, so the operator finished setup believing every directory they
      // ticked had been attached. Log it regardless of what the client does.
      log.warn('Setup completed with skipped projects', { count: warnings.length, warnings });
    }

    jsonResponse(res, 200, {
      ok: true,
      setupComplete: true,
      attached,
      warnings,
      restart: shouldRestart,
      redirectUrl,
      redirectVia,
      ingress,
      account
    });
  });
}

module.exports = { register, _setRestartScheduler, _setCutoverSpawner };

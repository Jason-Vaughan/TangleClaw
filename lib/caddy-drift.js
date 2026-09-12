'use strict';

/**
 * Caddyfile security divergence check (#1394).
 *
 * TangleClaw generates the Caddyfile and then never looks at it again. The live
 * file is hand-edited and load-bearing, and six recorded incidents of generator
 * drift went unnoticed because nothing compared what is running against what
 * the generator would produce. The most recent one put an unauthenticated
 * reverse proxy on a reachable port.
 *
 * Three things about the shape of this module are not stylistic:
 *
 * **Caddy's parser is the only parser.** Both the live file and the generated
 * baseline go through `caddy adapt`, and every property is read off the
 * resulting JSON. A text walker over Caddyfile syntax would be a seventh way to
 * misread the file.
 *
 * **Properties are diffed, never documents.** Two Caddyfiles that gate
 * identically adapt to structurally different JSON. The live file's gate is one
 * route holding `[authentication, reverse_proxy]`; the generator emits two
 * SIBLING routes, an `authentication` behind a `not path_regexp` matcher
 * followed by an unmatched `reverse_proxy`. Both are correct gates. A
 * whole-document diff calls that drift, and - worse - a naive "is there an auth
 * handler before the proxy in this handler chain" walk reports the GENERATOR'S
 * OWN OUTPUT as ungated, because there the proxy's chain genuinely contains no
 * authentication handler.
 *
 * **An unrun check is never clean.** Every property answers `holds`,
 * `diverged`, or `not-measured`, and the absence of `caddy`, of the Caddyfile,
 * or of a PortHub lease produces the third. A check that cannot run must not be
 * indistinguishable from one that passed.
 *
 * Nothing here blocks, refuses, or rewrites. The operator hand-edits
 * deliberately; a finding names the missing property and stops.
 *
 * @module lib/caddy-drift
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const caddy = require('./caddy');
const { LEASE_REACHES } = require('./store');
const { createLogger } = require('./logger');

const log = createLogger('caddy-drift');

const ADAPT_TIMEOUT_MS = 10000;

/** Property verdicts. */
const HOLDS = 'holds';
const DIVERGED = 'diverged';
const NOT_MEASURED = 'not-measured';

/**
 * How far something reaches, weakest first. Imported rather than restated:
 * a second copy here would keep answering for a vocabulary the store had
 * widened, and P4 would silently stop recognising the new value instead of
 * failing. Caddy binds every interface unless a host is written into the listen
 * address, so any site Caddy serves reaches at least the tailnet.
 */
const REACH_ORDER = LEASE_REACHES;

/**
 * Run `caddy adapt` over a Caddyfile and return the JSON config Caddy itself
 * would load.
 *
 * @param {string} caddyfilePath - Absolute path to a Caddyfile.
 * @returns {{ ok: boolean, config: object|null, reason: string|null }} `reason`
 *   is set only when `ok` is false, and is already redacted: `caddy adapt`
 *   quotes the offending line on a parse error, and for this project's config
 *   that line can be `basic_auth <user> <hash>`.
 */
function adaptCaddyfile(caddyfilePath) {
  if (!caddyfilePath || !fs.existsSync(caddyfilePath)) {
    return { ok: false, config: null, reason: `Caddyfile not found: ${caddyfilePath}` };
  }
  const detection = caddy.detectCaddy();
  if (!detection.available) {
    return {
      ok: false,
      config: null,
      reason: `caddy is not available: ${detection.error || 'unknown'}`
    };
  }
  try {
    // `caddy adapt` writes warnings to stderr and the config to stdout; only
    // stdout is parsed, so a warning never corrupts the result.
    const out = execFileSync('caddy', ['adapt', '--config', caddyfilePath], {
      encoding: 'utf8',
      timeout: ADAPT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true, config: JSON.parse(out), reason: null };
  } catch (err) {
    const detail = (err.stderr && err.stderr.toString().trim()) || err.message;
    return { ok: false, config: null, reason: caddy.redactHashes(detail) };
  }
}

/**
 * Adapt Caddyfile TEXT by writing it to a private temp file first.
 *
 * `caddy adapt` reads a path, not stdin, and the text handed to this function
 * carries the bcrypt hash - so the file is created 0600 inside a 0700 directory
 * and removed in a `finally`, rather than written to a predictable path under
 * the system temp root.
 *
 * @param {string} content - Caddyfile text.
 * @returns {{ ok: boolean, config: object|null, reason: string|null }}
 */
function adaptCaddyfileContent(content) {
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-caddy-baseline-'), { mode: 0o700 });
    const file = path.join(dir, 'Caddyfile');
    fs.writeFileSync(file, content, { mode: 0o600 });
    return adaptCaddyfile(file);
  } catch (err) {
    return { ok: false, config: null, reason: caddy.redactHashes(err.message) };
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        log.warn('Could not remove baseline temp dir', { dir, error: err.message });
      }
    }
  }
}

/**
 * Stable string form of a Caddy matcher set, so two matchers compare equal
 * regardless of key order.
 *
 * @param {Array|undefined} match - A route's `match` array.
 * @returns {string} `'*'` for a route with no matcher, which matches everything.
 */
function matcherSignature(match) {
  if (!Array.isArray(match) || match.length === 0) return '*';
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((acc, key) => {
        acc[key] = canonical(value[key]);
        return acc;
      }, {});
    }
    return value;
  };
  return JSON.stringify(canonical(match));
}

/**
 * Collect every proxy target and every gate found under a route list.
 *
 * A gate is recorded as the matcher of whichever route carries the
 * `authentication` handler, NOT as a property of the proxy route, because in
 * Caddy a gate and the proxy it protects are routinely SIBLING routes evaluated
 * in order - which is exactly the shape TangleClaw's own generator emits.
 * Asking "was this proxy's own handler chain gated" answers a different
 * question and calls a correctly gated site open.
 *
 * @param {Array} routes - Caddy JSON routes.
 * @param {{ proxies: string[], gates: string[] }} acc - Mutated in place.
 */
function collectRoutes(routes, acc) {
  if (!Array.isArray(routes)) return;
  for (const route of routes) {
    const handlers = Array.isArray(route.handle) ? route.handle : [];
    if (handlers.some((h) => h && h.handler === 'authentication')) {
      acc.gates.push(matcherSignature(route.match));
    }
    for (const handler of handlers) {
      if (!handler) continue;
      if (handler.handler === 'reverse_proxy') {
        for (const upstream of handler.upstreams || []) {
          if (upstream && upstream.dial) acc.proxies.push(upstream.dial);
        }
      } else if (handler.handler === 'subroute') {
        collectRoutes(handler.routes, acc);
      }
    }
  }
}

/**
 * Reduce an adapted config to the sites it serves and the sockets it listens
 * on, keyed by the server's whole (sorted) listen list and the route's hosts —
 * not by a single address, since one Caddy server may hold several.
 *
 * The key deliberately excludes the server NAME. Caddy assigns `srv0`, `srv1`,
 * ... in file order, so one hand-written block added at the top of the live
 * Caddyfile renamed every server below it; an assertion keyed to a name would
 * have moved silently onto a different server.
 *
 * @param {object} adapted - `caddy adapt` JSON.
 * @returns {{ sites: Map<string, object>, listeners: Map<string, object> }}
 */
function summarizeConfig(adapted) {
  const sites = new Map();
  const listeners = new Map();
  const servers = (adapted && adapted.apps && adapted.apps.http && adapted.apps.http.servers) || {};

  for (const server of Object.values(servers)) {
    const listen = Array.isArray(server.listen) ? [...server.listen].sort() : [];
    for (const address of listen) {
      listeners.set(address, {
        address,
        protocols: Array.isArray(server.protocols) ? [...server.protocols] : null
      });
    }
    const listenKey = listen.join(',');

    for (const route of server.routes || []) {
      const hosts = [];
      for (const matcher of route.match || []) {
        for (const host of (matcher && matcher.host) || []) hosts.push(host);
      }
      hosts.sort();
      const acc = { proxies: [], gates: [] };
      collectRoutes([route], acc);
      // A site that proxies nothing - a pure redirect block - holds no gate
      // property, because there is nothing behind it to reach.
      if (acc.proxies.length === 0) continue;

      const key = `${listenKey}|${hosts.join(',') || '*'}`;
      const existing = sites.get(key);
      if (existing) {
        existing.proxies.push(...acc.proxies);
        existing.gates.push(...acc.gates);
      } else {
        sites.set(key, { key, listen: listenKey, hosts, proxies: acc.proxies, gates: acc.gates });
      }
    }
  }

  for (const site of sites.values()) {
    site.proxies = [...new Set(site.proxies)].sort();
    site.gates = [...new Set(site.gates)].sort();
  }
  return { sites, listeners };
}

/**
 * Every upstream any site dials, across a whole adapted config.
 * @param {Map<string, object>} sites - From `summarizeConfig`.
 * @returns {Set<string>} Dial strings, e.g. `127.0.0.1:3102`.
 */
function upstreamsOf(sites) {
  const all = new Set();
  for (const site of sites.values()) {
    for (const dial of site.proxies) all.add(dial);
  }
  return all;
}

/**
 * Split a dial target into host and port, or null when it is not a shape this
 * check can reason about (a unix socket, a named upstream).
 * @param {string} dial - e.g. `127.0.0.1:3250`.
 * @returns {{ host: string, port: number }|null}
 */
function parseDial(dial) {
  const m = /^([^\s/]+):(\d+)$/.exec(String(dial || ''));
  if (!m) return null;
  return { host: m[1], port: Number(m[2]) };
}

/**
 * Whether a dial host names this machine's own loopback interface.
 * @param {string} host - Dial host.
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * Whether a lease row describes a service on THIS machine.
 *
 * `port_leases.host` defaults to the literal `'localhost'`, which is the
 * registry's name for "here" rather than a resolvable address, so it is
 * accepted alongside the loopback spellings. A row naming another machine
 * describes a different port and must not answer for this one.
 *
 * @param {string|undefined} host - A lease row's host column.
 * @returns {boolean}
 */
function isLocalLeaseHost(host) {
  return host == null || host === 'localhost' || isLoopbackHost(host);
}

/**
 * P1 - no site reverse-proxies without a gate.
 *
 * Gate PRESENCE only, deliberately. An earlier revision also compared the live
 * gate's matcher against the baseline's and reported any difference as drift;
 * against the real live Caddyfile that fired on all three correctly gated
 * sites. The two files express the same gate in genuinely different shapes -
 * one route holding `[authentication, reverse_proxy]` versus a `not
 * path_regexp` gate route followed by an unmatched proxy route - and deciding
 * which of two matcher sets admits more requests means reimplementing Caddy's
 * matcher algebra. That is the false-positive class this check is required to
 * avoid, so the comparison is gate presence, which is unambiguous in both
 * shapes.
 *
 * Two limits follow, both tracked rather than approximated (see
 * `docs/caddy-drift-check.md`): drift in the BREADTH of a gate (a hand-widened
 * bypass) is not covered, and neither is an ungated path-scoped block sitting
 * beside a real gate on the same site — `summarizeConfig` merges a site's routes,
 * so one gate anywhere in it satisfies this property for all of it. That merge is
 * what lets the generator's own bypass routes pass, so it is the design, not an
 * oversight; what it costs is stated here rather than left to be discovered.
 *
 * Still a diff and not an absolute: a site the baseline also leaves ungated is
 * not the live file's divergence, and a config that generates no gate at all
 * leaves nothing to compare against.
 *
 * @param {Map<string, object>} live - Live sites.
 * @param {Map<string, object>} baseline - Baseline sites.
 * @returns {{ status: string, findings: string[] }}
 */
function checkGates(live, baseline) {
  const baselineGates = [...baseline.values()].some((site) => site.gates.length > 0);
  if (!baselineGates) {
    return {
      status: NOT_MEASURED,
      findings: [
        'TangleClaw is configured to generate an UNGATED ingress, so there is no gate '
        + 'property for the live Caddyfile to diverge from'
      ]
    };
  }
  const findings = [];
  for (const site of live.values()) {
    if (site.gates.length > 0) continue;
    const twin = baseline.get(site.key);
    if (twin && twin.gates.length === 0) continue;
    const where = site.hosts.length ? site.hosts.join(', ') : 'any host';
    findings.push(
      `the site on ${site.listen} for ${where} proxies to ${site.proxies.join(', ')} with no gate`
    );
  }
  return { status: findings.length ? DIVERGED : HOLDS, findings };
}

/**
 * P2 - the HTTPS listener negotiates HTTP/1.1 only.
 *
 * Chrome aborts terminal WebSockets client-side (1006) when the origin
 * negotiates h2/h3, so the generator pins `protocols h1` unconditionally. Keyed
 * by listen address; `summarizeConfig` records why a server name cannot be.
 *
 * @param {Map<string, object>} live - Live listeners.
 * @param {Map<string, object>} baseline - Baseline listeners.
 * @param {number} httpsPort - The configured HTTPS port.
 * @returns {{ status: string, findings: string[] }}
 */
function checkHttpsProtocols(live, baseline, httpsPort) {
  const address = `:${httpsPort}`;
  const expected = baseline.get(address);
  if (!expected) {
    return {
      status: NOT_MEASURED,
      findings: [`TangleClaw generates no HTTPS listener on ${address} to compare against`]
    };
  }
  const actual = live.get(address);
  if (!actual) {
    return { status: DIVERGED, findings: [`the live Caddyfile has no listener on ${address}`] };
  }
  if (JSON.stringify(actual.protocols) === JSON.stringify(expected.protocols)) {
    return { status: HOLDS, findings: [] };
  }
  const negotiates = actual.protocols ? actual.protocols.join(', ') : "Caddy's defaults";
  return {
    status: DIVERGED,
    findings: [
      `the listener on ${address} negotiates ${negotiates} `
      + `rather than ${expected.protocols.join(', ')}`
    ]
  };
}

/**
 * P3 - no site proxies to an upstream the generated config does not dial.
 * @param {Set<string>} live - Live upstreams.
 * @param {Set<string>} baseline - Baseline upstreams.
 * @returns {{ status: string, findings: string[], unknown: string[] }}
 */
function checkUpstreams(live, baseline) {
  const unknown = [...live].filter((dial) => !baseline.has(dial)).sort();
  return {
    status: unknown.length ? DIVERGED : HOLDS,
    unknown,
    findings: unknown.map(
      (dial) => `the live Caddyfile fronts ${dial}, which TangleClaw does not generate`
    )
  };
}

/**
 * P4 - no site fronts a port whose PortHub lease declares a narrower reach than
 * the site provides.
 *
 * Scoped to the upstreams P3 already found unknown. The upstreams TangleClaw
 * generates are fronted BY DESIGN - TC's own server binds loopback precisely
 * because Caddy is the front door - so cross-referencing those would report the
 * architecture as a fault.
 *
 * @param {string[]} unknownUpstreams - From `checkUpstreams`.
 * @param {object[]|null} leases - PortHub leases, or null when unreachable.
 * @returns {{ status: string, findings: string[] }}
 */
function checkLeaseReach(unknownUpstreams, leases) {
  if (!Array.isArray(leases)) {
    return {
      status: NOT_MEASURED,
      findings: ['PortHub did not answer, so no lease could be cross-referenced']
    };
  }
  const findings = [];
  const unmeasured = [];
  // Every Caddy-served site is treated as exactly `tailnet`: Caddy binds all
  // interfaces, so the floor is right, but nothing here distinguishes a tailnet
  // from a LAN-reachable listener. The consequence is deliberate and worth
  // knowing — only a `loopback` lease can ever trip this property, and a
  // `tailnet` lease fronted on a LAN-exposed listener reads as holding.
  const siteProvides = REACH_ORDER.indexOf('tailnet');

  for (const dial of unknownUpstreams) {
    const parsed = parseDial(dial);
    if (!parsed || !isLoopbackHost(parsed.host)) {
      unmeasured.push(`${dial} is not a local port this check can attribute to a lease`);
      continue;
    }
    // Host as well as port. `port_leases` is keyed on (host, port) and `list()`
    // orders by host, so matching on the port alone lets a row for some OTHER
    // machine shadow the localhost row this dial actually refers to — a silent
    // false negative in the one property the `reach` column exists to answer.
    const lease = leases.find((l) => l && l.port === parsed.port && isLocalLeaseHost(l.host));
    if (!lease) {
      unmeasured.push(`port ${parsed.port} has no PortHub lease, so its intended reach is unknown`);
      continue;
    }
    const declared = REACH_ORDER.indexOf(lease.reach);
    if (declared === -1) {
      unmeasured.push(`port ${parsed.port} has a lease with no readable reach`);
      continue;
    }
    if (declared < siteProvides) {
      findings.push(
        `port ${parsed.port} is leased reach:${lease.reach} by "${lease.project}" `
        + `(${lease.service}), but the live Caddyfile fronts it`
      );
    }
  }
  if (findings.length) return { status: DIVERGED, findings };
  if (unmeasured.length) return { status: NOT_MEASURED, findings: unmeasured };
  return { status: HOLDS, findings: [] };
}

/**
 * Build the Caddyfile the generator WOULD write, from config.
 *
 * Deliberately sourced from config and not from the live file. The shapes that
 * matter here are exactly the ones a hand-edit can remove, so a baseline
 * recovered from the live file would agree with whatever that file says and
 * would report a deleted gate as correct. `certPath`/`keyPath` participate in
 * no measured property - they only place a `tls` line - but the generator
 * requires them, so they come from the live file when it is a shape the
 * extractor reads and from the staged certificate directory otherwise.
 *
 * @param {object} config - Loaded TangleClaw config.
 * @param {string|null} liveContent - The live Caddyfile text, if readable.
 * @returns {{ ok: boolean, content: string|null, reason: string|null }}
 */
function buildBaseline(config, liveContent) {
  const extracted = (typeof liveContent === 'string'
    && caddy.extractGeneratedCaddyfileOptions(liveContent)) || {};
  const certsDir = caddy.getStagedCertsDir();
  try {
    const content = caddy.buildCaddyfileContent({
      serverPort: config.serverPort,
      certPath: extracted.certPath || path.join(certsDir, 'cert.pem'),
      keyPath: extracted.keyPath || path.join(certsDir, 'key.pem'),
      httpsPort: config.caddyHttpsPort || 8443,
      httpPort: config.caddyHttpPort || 8080,
      publicDomain: config.publicDomain || null,
      basicAuthUser: config.authEnabled ? config.basicAuthUser : null,
      basicAuthHash: config.authEnabled ? config.basicAuthHash : null,
      remoteHttpCatchAll: config.caddyRemoteHttp === true,
      tailnetHost: config.caddyTailnetHost || null,
      accessLogPath: config.caddyAccessLogPath || null
    });
    return { ok: true, content, reason: null };
  } catch (err) {
    return { ok: false, content: null, reason: caddy.redactHashes(err.message) };
  }
}

/**
 * Every property reporting `not-measured` for one shared reason.
 * @param {string} reason - Why nothing could be measured.
 * @returns {object} A result in the same shape a real run produces.
 */
function allNotMeasured(reason) {
  const one = () => ({ status: NOT_MEASURED, findings: [reason] });
  return {
    measured: false,
    reason,
    properties: {
      gatedProxies: one(),
      httpsProtocols: one(),
      knownUpstreams: { ...one(), unknown: [] },
      leaseReach: one()
    },
    findings: []
  };
}

/**
 * Compare the live Caddyfile against the one TangleClaw would generate, and
 * report which security properties the live file does not hold.
 *
 * @param {object} options
 * @param {object} options.config - Loaded TangleClaw config.
 * @param {string} [options.caddyfilePath] - Defaults to the live Caddyfile.
 * @param {object[]|null} [options.leases=null] - PortHub leases. Null means
 *   PortHub could not be read, which makes the fourth property `not-measured`
 *   rather than clean.
 * @returns {{ measured: boolean, reason: string|null, properties: object, findings: string[] }}
 *   `findings` is the flat, operator-facing list across every diverged property,
 *   already redacted. An empty `findings` with `measured: true` is the only
 *   clean answer this can give.
 */
function checkCaddyDrift(options = {}) {
  const config = options.config || {};
  const caddyfilePath = options.caddyfilePath || caddy.getCaddyfilePath();
  const leases = options.leases === undefined ? null : options.leases;

  let liveContent = null;
  try {
    liveContent = fs.readFileSync(caddyfilePath, 'utf8');
  } catch (err) {
    return allNotMeasured(`the live Caddyfile could not be read: ${err.message}`);
  }

  const liveAdapted = adaptCaddyfile(caddyfilePath);
  if (!liveAdapted.ok) {
    return allNotMeasured(`the live Caddyfile could not be adapted: ${liveAdapted.reason}`);
  }

  const baseline = buildBaseline(config, liveContent);
  if (!baseline.ok) {
    return allNotMeasured(
      `TangleClaw could not generate a baseline to compare against: ${baseline.reason}`
    );
  }
  const baselineAdapted = adaptCaddyfileContent(baseline.content);
  if (!baselineAdapted.ok) {
    return allNotMeasured(`the generated baseline could not be adapted: ${baselineAdapted.reason}`);
  }

  const liveSummary = summarizeConfig(liveAdapted.config);
  const baseSummary = summarizeConfig(baselineAdapted.config);

  const gatedProxies = checkGates(liveSummary.sites, baseSummary.sites);
  const httpsProtocols = checkHttpsProtocols(
    liveSummary.listeners, baseSummary.listeners, config.caddyHttpsPort || 8443
  );
  const knownUpstreams = checkUpstreams(
    upstreamsOf(liveSummary.sites), upstreamsOf(baseSummary.sites)
  );
  const leaseReach = checkLeaseReach(knownUpstreams.unknown, leases);

  const properties = { gatedProxies, httpsProtocols, knownUpstreams, leaseReach };
  const findings = [];
  for (const property of Object.values(properties)) {
    if (property.status === DIVERGED) findings.push(...property.findings);
  }

  return {
    measured: true,
    reason: null,
    properties,
    findings: findings.map((finding) => caddy.redactHashes(finding))
  };
}

/**
 * Human-readable name for each property, for the one place an operator reads
 * WHICH of them could not be checked.
 *
 * Keyed off the result object rather than a hand-kept list: a property added to
 * `checkCaddyDrift` and forgotten here still reports, under its key.
 */
const PROPERTY_LABELS = {
  gatedProxies: 'every proxying site has a gate',
  httpsProtocols: 'the HTTPS listener negotiates the pinned protocols',
  knownUpstreams: 'no site dials an upstream TangleClaw does not generate',
  leaseReach: 'no site fronts a port leased for a narrower reach'
};

/**
 * Turn a `checkCaddyDrift` result into the dashboard notice, or null when there
 * is nothing to say.
 *
 * Pure and separate from the check so the wording is testable without a `caddy`
 * binary, and so the boot path holds no copy of the phrasing.
 *
 * **Reads `properties`, not `findings`.** `findings` carries DIVERGENCES only,
 * so a result whose every property held and a result with a `not-measured`
 * property and no divergence both present an empty list. Deciding from that
 * list alone turns "TangleClaw could not check whether a site is gated" into a
 * silent clean bill — which is the exact collapse the `not-measured` verdict
 * exists to prevent, and it is reachable on an ordinary install: an ungated
 * config leaves P1 permanently unmeasurable, and a PortHub read that throws
 * leaves P4 so. Silence is reserved for the one case that earns it: the check
 * ran, and every property holds.
 *
 * Everything it emits is redacted here rather than relied on to arrive clean.
 * `result.reason` is built from `caddy adapt` stderr, which quotes the offending
 * Caddyfile line, and that line can be `basic_auth <user> <hash>`.
 *
 * @param {object} result - From `checkCaddyDrift`.
 * @returns {{setting: string, severity: string, message: string, findings: string[],
 *   unmeasured: string[]}|null} Null only when the check ran and every property holds.
 */
function describeDrift(result) {
  if (!result) return null;
  const redact = (text) => caddy.redactHashes(String(text));

  if (!result.measured) {
    return {
      setting: 'Caddyfile',
      severity: 'unknown',
      message: redact(`TangleClaw could not check the live Caddyfile for drift: ${result.reason}`),
      findings: [],
      unmeasured: []
    };
  }

  const properties = result.properties || {};
  const diverged = [];
  const unmeasured = [];
  for (const [key, property] of Object.entries(properties)) {
    if (!property) continue;
    const label = PROPERTY_LABELS[key] || key;
    if (property.status === DIVERGED) {
      diverged.push({ label, findings: (property.findings || []).map(redact) });
    } else if (property.status === NOT_MEASURED) {
      const why = (property.findings || []).map(redact).join('; ');
      unmeasured.push(why ? `${label} — ${why}` : label);
    }
  }
  if (!diverged.length && !unmeasured.length) return null;

  // Counted in PROPERTIES, because that is the noun the sentence uses. Counting
  // findings said "2 security properties" for two ungated blocks breaking one.
  const parts = [];
  if (diverged.length) {
    const total = Object.keys(properties).length;
    // The plural agrees with the TOTAL, not the count that diverged: the phrase
    // is "1 of the 4 security properties".
    parts.push(
      `The live Caddyfile does not hold ${diverged.length} of the ${total} security `
      + `${total === 1 ? 'property' : 'properties'} TangleClaw would generate.`
    );
  }
  if (unmeasured.length) {
    parts.push(
      `${unmeasured.length} ${unmeasured.length === 1 ? 'property' : 'properties'} `
      + 'could not be checked at all.'
    );
  }

  return {
    setting: 'Caddyfile',
    severity: diverged.length ? 'diverged' : 'unknown',
    // Neutral by design: the live file is hand-edited on purpose, and this
    // names what is missing rather than asserting a mistake was made.
    message: parts.join(' '),
    findings: diverged.flatMap((d) => d.findings),
    unmeasured
  };
}

module.exports = {
  checkCaddyDrift,
  describeDrift,
  adaptCaddyfile,
  adaptCaddyfileContent,
  summarizeConfig,
  matcherSignature,
  upstreamsOf,
  parseDial,
  isLoopbackHost,
  buildBaseline,
  checkGates,
  checkHttpsProtocols,
  checkUpstreams,
  checkLeaseReach,
  HOLDS,
  DIVERGED,
  NOT_MEASURED,
  REACH_ORDER
};

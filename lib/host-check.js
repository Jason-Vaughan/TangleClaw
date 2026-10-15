'use strict';

/**
 * The read-only host check (#1380, #2142): what this machine's names,
 * Caddyfile, certificates, serve routes and local trust actually say, measured
 * and compared, with nothing changed.
 *
 * It runs as its own process (`scripts/host-check.js`), so it is usable right
 * after a deploy with no server restart, and it never touches the startup path.
 *
 * What "read-only" means here, precisely:
 *   - It writes no file, opens no database and starts no file logging. Loading
 *     `lib/caddy.js`, `lib/https-setup.js` and `lib/host-inventory.js` runs
 *     nothing; of their functions it calls only the pure ones
 *     (`normalizeHostName`, `classifyCaddyfileContent`, `extractTailnetHost`,
 *     `mdnsHostFor`, `effectiveServerProtocol`) and three file reads:
 *     `certSanHosts`, `certCoversHost` and `installedServerPort`. It never calls the overlay probe, `localTrustAnchor`,
 *     `detectMkcert`, `mandatoryCertHosts`, `certHostUnion`, `store.init` or
 *     `store.config.load`: each of those either runs a command through a shell,
 *     spawns `mkcert`, or creates directories and opens (and can migrate) the
 *     database.
 *   - It runs exactly three commands, through `execFile` with no shell:
 *     `tailscale status --json`, `tailscale serve status --json` and
 *     `security verify-cert -c <root>`. Anything else is refused before it
 *     reaches the operating system.
 *   - It opens one socket of its own: a single loopback GET of `/api/ports`,
 *     with no credentials and no redirect following. Over HTTPS the server's
 *     certificate is verified as usual; one that cannot be verified makes the
 *     row `unknown`, never a read of unverified lease data.
 *   - It does NOT promise "no network": `dns.lookup` uses the system resolver,
 *     `tailscale` talks to its own daemon, and `security` may consult trust
 *     services. The output says so.
 *
 * Every row ends in one of five states (`ROW_STATES`). `unknown` is never
 * dressed up as `ok` or `drift`: a value that could not be measured says why.
 *
 * Output is redacted by default: names, addresses, paths, URLs, user and
 * project names become stable per-run tokens, and errors are reduced to codes.
 * `--reveal` shows the values for the operator's own terminal, but credentials,
 * `basic_auth` hashes, key material and query strings are never collected in
 * the first place, so no flag can print them. Neither can it print a raw value
 * read from a file or a command into a code or a reason: those are checked
 * against closed sets first, and an error's message is never kept.
 *
 * @module lib/host-check
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const childProcess = require('node:child_process');
const tangleclawHome = require('./tangleclaw-home');
const { normalizeHostName } = require('./host-inventory');
const { classifyCaddyfileContent, extractTailnetHost } = require('./caddy');
const httpsSetup = require('./https-setup');

/** The closed set of row states, in the order they are explained. */
const ROW_STATES = ['ok', 'drift', 'ambiguous', 'observed', 'unknown'];

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_DRIFT = 3;
const EXIT_UNKNOWN = 4;

const LIMITS = Object.freeze({
  commandTimeoutMs: 5000,
  commandStdoutBytes: 1024 * 1024,
  runBudgetMs: 20000,
  caddyfileBytes: 1024 * 1024,
  certificateBytes: 64 * 1024,
  configBytes: 1024 * 1024,
  portsBodyBytes: 1024 * 1024,
  portsTimeoutMs: 3000,
  lookupTimeoutMs: 3000,
  maxNames: 64
});

/**
 * The only commands this check may run. `security verify-cert` takes the root
 * certificate path as its last argument, so only its leading arguments are fixed.
 */
const COMMAND_ALLOW_LIST = Object.freeze([
  { cmd: 'tailscale', args: ['status', '--json'], exact: true },
  { cmd: 'tailscale', args: ['serve', 'status', '--json'], exact: true },
  { cmd: 'security', args: ['verify-cert', '-c'], exact: false, extra: 1 }
]);

const ADVISORY_LABEL = 'advisory: what a new certificate would likely carry; not guaranteed to match the product\'s minting';

const NETWORK_NOTE = 'Network: this check opens no socket of its own except one loopback GET of /api/ports. '
  + 'It is not network-silent: dns.lookup uses the system resolver, tailscale talks to its own daemon, '
  + 'and security may consult trust services.';

const TOPOLOGY_MARKER_RE = /^#\s*tangleclaw-topology\s+(\S+)/;

// Every value below comes from a file or a command this check reads, and is
// printed as a `code`, which the redactor shows verbatim. So each is checked
// against a closed set, and anything outside it is printed as a fixed word,
// never as itself: a hand-edited value can hold anything.

/** The ingress modes the server accepts (`server.js` refuses any other). */
const INGRESS_MODES = Object.freeze(['direct', 'caddy']);

/** The topology marker versions this check reads. */
const TOPOLOGY_VERSIONS = Object.freeze(['v1']);

/** `BackendState` values `tailscale status --json` reports (ipn.State). */
const TAILSCALE_BACKEND_STATES = Object.freeze([
  'NoState', 'InUseOtherUser', 'NeedsLogin', 'NeedsMachineAuth', 'Stopped', 'Starting', 'Running'
]);

/** Built-in error classes whose names a diagnostic may show. */
const ERROR_CLASS_NAMES = Object.freeze([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError'
]);

// The shape of a Node or errno error code (`ENOENT`, `EAI_AGAIN`,
// `ERR_INVALID_ARG_TYPE`): no lower case, spaces, paths or punctuation can
// pass it, so a code that does is safe to print.
const ERROR_CODE_RE = /^E[A-Z0-9_]{1,63}$/;

// Names that are the same on every machine, so showing them reveals nothing.
const PUBLIC_CONSTANTS = new Set(['localhost', '127.0.0.1', '::1']);

const SENSITIVE_KINDS = new Set(['host', 'ip', 'path', 'url', 'user', 'project', 'route']);

/**
 * An error's code if it has the shape of a Node or errno code, else null.
 * @param {*} err - What was thrown or reported.
 * @returns {string|null}
 */
function safeErrorCode(err) {
  const code = err && typeof err === 'object' ? err.code : undefined;
  return typeof code === 'string' && ERROR_CODE_RE.test(code) ? code : null;
}

/**
 * The ingress mode a config declares, as one of `INGRESS_MODES`, or
 * `unsupported`. An absent or empty value is the store's default, `direct`.
 * @param {object} config - Parsed config.
 * @returns {string}
 */
function ingressModeOf(config) {
  const mode = config.ingressMode;
  if (mode === undefined || mode === null || mode === '') return 'direct';
  return INGRESS_MODES.includes(mode) ? mode : 'unsupported';
}

/**
 * Whether a command and its arguments are on the allow-list.
 * @param {string} cmd - Executable name.
 * @param {string[]} args - Arguments.
 * @returns {boolean}
 */
function isAllowedCommand(cmd, args) {
  if (typeof cmd !== 'string' || !Array.isArray(args)) return false;
  return COMMAND_ALLOW_LIST.some((entry) => {
    if (entry.cmd !== cmd) return false;
    const fixedMatch = entry.args.every((a, i) => args[i] === a);
    if (!fixedMatch) return false;
    if (entry.exact) return args.length === entry.args.length;
    return args.length === entry.args.length + entry.extra
      && args.slice(entry.args.length).every((a) => typeof a === 'string' && a.length > 0);
  });
}

/**
 * Run an allow-listed command with no shell, a timeout and a stdout cap.
 *
 * Never rejects for a command failure: the result carries a `reason` code, so a
 * row reports why instead of the check aborting. It DOES throw for a command
 * that is not on the allow-list, because that is a defect in this module, not
 * a fact about the host.
 *
 * @param {object} deps - Injected dependencies (`execFile`).
 * @param {string} cmd - Executable name.
 * @param {string[]} args - Arguments.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode: number|null, reason: string|null}>}
 */
function runAllowed(deps, cmd, args) {
  if (!isAllowedCommand(cmd, args)) {
    throw new Error(`host-check: command not on the allow-list: ${cmd}`);
  }
  return new Promise((resolve) => {
    deps.execFile(cmd, args, {
      shell: false,
      timeout: LIMITS.commandTimeoutMs,
      maxBuffer: LIMITS.commandStdoutBytes,
      encoding: 'utf8',
      windowsHide: true
    }, (err, stdout, stderr) => {
      const out = typeof stdout === 'string' ? stdout : String(stdout || '');
      const errText = typeof stderr === 'string' ? stderr : String(stderr || '');
      if (!err) {
        resolve({ ok: true, stdout: out, stderr: errText, exitCode: 0, reason: null });
        return;
      }
      let reason = 'command-failed';
      if (err.code === 'ENOENT') reason = 'cli-absent';
      else if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reason = 'output-too-large';
      else if (err.killed || err.signal) reason = 'probe-timeout';
      const exitCode = typeof err.code === 'number' ? err.code : null;
      resolve({ ok: false, stdout: out, stderr: errText, exitCode, reason });
    });
  });
}

/**
 * Read a file only if it is no larger than `maxBytes`.
 * @param {object} deps - Injected dependencies (`fs`).
 * @param {string} filePath - File to read.
 * @param {number} maxBytes - Size cap.
 * @returns {{ok: boolean, content?: string, reason?: string}}
 *   `reason` is `absent`, `too-large`, `not-a-file` or `unreadable`.
 */
function readBounded(deps, filePath, maxBytes) {
  let stat;
  try {
    stat = deps.fs.statSync(filePath);
  } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
  if (stat.size > maxBytes) return { ok: false, reason: 'too-large' };
  try {
    return { ok: true, content: deps.fs.readFileSync(filePath, 'utf8') };
  } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
}

/**
 * Stable per-run tokens for sensitive values, so the default output can be
 * pasted into an issue without leaking a host's names, addresses or paths.
 */
class Redactor {
  /**
   * @param {boolean} reveal - Show values instead of tokens.
   */
  constructor(reveal) {
    this.reveal = Boolean(reveal);
    this._maps = new Map();
  }

  /**
   * Render one value of a kind.
   * @param {*} value - The value.
   * @param {string} kind - host, ip, path, url, user, project, route, code, text or number.
   * @returns {string}
   */
  render(value, kind) {
    if (value === null || value === undefined) return '-';
    let text = String(value);
    if (kind === 'url' || kind === 'route') text = sanitizeUrl(text);
    if (this.reveal || !SENSITIVE_KINDS.has(kind)) return text;
    if ((kind === 'host' || kind === 'ip') && PUBLIC_CONSTANTS.has(text.toLowerCase())) return text;
    if (!this._maps.has(kind)) this._maps.set(kind, new Map());
    const map = this._maps.get(kind);
    if (!map.has(text)) map.set(text, `<${kind}-${map.size + 1}>`);
    return map.get(text);
  }
}

/**
 * Drop the parts of a URL that can carry a credential: user info, query
 * string and fragment. Applied with `--reveal` too.
 * @param {string} value - A URL or URL-like string.
 * @returns {string}
 */
function sanitizeUrl(value) {
  const text = String(value);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return text.replace(/[?#].*$/, '');
  }
  try {
    const u = new URL(text);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return '<unparseable-url>';
  }
}

/**
 * A fact for a row: a label and a value of a kind the redactor understands.
 * @param {string} label - What the value is.
 * @param {*} value - The value.
 * @param {string} [kind] - Value kind (default `text`).
 * @returns {{label: string, value: *, kind: string}}
 */
function fact(label, value, kind = 'text') {
  return { label, value, kind };
}

/**
 * Combine states measured for parts of one row: drift and ambiguous outrank
 * unknown, which outranks ok and observed.
 * @param {string[]} states - Part states.
 * @param {string} [empty] - State when there are no parts (default `ok`).
 * @returns {string}
 */
function combineStates(states, empty = 'ok') {
  if (states.length === 0) return empty;
  if (states.includes('drift')) return 'drift';
  if (states.includes('ambiguous')) return 'ambiguous';
  if (states.includes('unknown')) return 'unknown';
  if (states.every((s) => s === 'observed')) return 'observed';
  return 'ok';
}

/**
 * Parse one site address from a Caddyfile header.
 * @param {string} token - The address token.
 * @returns {{scheme: string|null, host: string|null, port: number|null}|null}
 *   Null for a shape this parser does not support.
 */
function parseSiteAddress(token) {
  if (/[*{}$"'`]/.test(token)) return null;
  const m = token.match(/^(?:(https?):\/\/)?(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)?(?::(\d{1,5}))?(\/.*)?$/);
  if (!m || m[4]) return null;
  const host = m[2] ? m[2].replace(/^\[|\]$/g, '').toLowerCase() : null;
  if (!host && !m[1] && !m[3]) return null;
  return { scheme: m[1] || null, host, port: m[3] ? Number(m[3]) : null };
}

/**
 * Whether a host string is an IP literal.
 * @param {string} host - Host.
 * @returns {boolean}
 */
function isIpLiteral(host) {
  return /^[0-9.]+$/.test(host) || host.includes(':');
}

/**
 * The part of the Caddyfile this check reads: its sites, their tls lines and
 * redirects, and the topology marker. Shapes it does not read are listed in
 * `unsupported` so the row says `unknown` rather than guessing.
 *
 * @param {string} content - Caddyfile text.
 * @returns {{sites: object[], marker: {version: string}|null, unsupported: string[]}}
 */
function parseCaddyfile(content) {
  const sites = [];
  const unsupported = [];
  let marker = null;
  let depth = 0;
  let current = null;
  let sawGlobal = false;
  let blockIndex = 0;

  for (const rawLine of String(content).split('\n')) {
    const markerMatch = depth === 0 ? rawLine.trim().match(TOPOLOGY_MARKER_RE) : null;
    if (markerMatch) {
      if (marker) unsupported.push('topology-marker-repeated');
      // Only a version this check reads is kept; any other is recorded as
      // unsupported and never stored, so it cannot reach the output.
      const known = TOPOLOGY_VERSIONS.includes(markerMatch[1]);
      marker = { version: known ? markerMatch[1] : null };
      if (!known) unsupported.push('topology-version');
    }
    // Comments are stripped the way `lib/caddy.js#extractTailnetHost` strips
    // them, so the two readers agree on which lines are structure.
    const line = rawLine.replace(/#.*$/, '').replace(/\s+$/, '');
    const trimmed = line.trim();
    if (trimmed === '') continue;

    if (depth === 0) {
      blockIndex += 1;
      if (trimmed === '{' && blockIndex === 1 && !sawGlobal) {
        sawGlobal = true;
        current = null;
      } else {
        const header = trimmed.match(/^(.+?)\s*\{$/);
        if (!header) {
          unsupported.push('unbraced-site');
        } else if (/^\(.*\)$/.test(header[1].trim())) {
          unsupported.push('snippet');
          current = null;
        } else {
          const tokens = header[1].split(/[\s,]+/).filter(Boolean);
          const addresses = tokens.map(parseSiteAddress);
          if (addresses.some((a) => a === null)) {
            unsupported.push('address-shape');
            current = null;
          } else {
            current = { addresses, tls: null, redirect: null };
            sites.push(current);
          }
        }
      }
    } else if (current && depth === 1) {
      const tokens = trimmed.split(/\s+/);
      if (tokens[0] === 'import') unsupported.push('import');
      if (tokens[0] === 'tls') {
        if (tokens.length === 3 && tokens[1].startsWith('/') && !tokens[1].includes('{')) {
          current.tls = { form: 'files', certPath: tokens[1] };
        } else {
          current.tls = { form: 'other', certPath: null };
        }
      } else if (tokens[0] === 'redir' && tokens[1]) {
        current.redirect = tokens[1].replace(/\{uri\}$/, '');
      }
    } else if (depth > 0 && /^import\b/.test(trimmed)) {
      unsupported.push('import');
    }

    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (depth < 0) {
      unsupported.push('unbalanced-braces');
      depth = 0;
    }
    if (depth === 0) current = null;
  }
  if (depth !== 0) unsupported.push('unbalanced-braces');
  return { sites, marker, unsupported: [...new Set(unsupported)] };
}

/**
 * A single-address site headed by a bare DNS name (not localhost) that carries
 * `tls`: the shape `extractTailnetHost` treats as THE tailnet site. Two of
 * them with nothing declaring which is meant is ambiguous.
 * @param {object} site - Parsed site.
 * @returns {boolean}
 */
function isTlsFqdnSite(site) {
  if (!site.tls || site.addresses.length !== 1) return false;
  const a = site.addresses[0];
  // A port or a scheme in the header puts it outside FQDN_SITE_HEADER_RE.
  if (a.scheme || a.port !== null || !a.host || a.host === 'localhost') return false;
  return normalizeHostName(a.host) !== null;
}

/**
 * Whether a site's own certificate covers a host. Names go through the
 * product's own check, `lib/https-setup.js#certCoversHost` (RFC 6125 matching,
 * the comparison a client makes); that check matches DNS names only, so an IP
 * address is matched against the certificate's IP SANs here.
 * @param {string} certPath - The site's certificate (already size-checked).
 * @param {{x509: crypto.X509Certificate}} cert - The parsed certificate.
 * @param {string} host - Host or IP.
 * @returns {boolean}
 */
function certCovers(certPath, cert, host) {
  if (isIpLiteral(host)) return cert.x509.checkIP(host) !== undefined;
  return httpsSetup.certCoversHost(certPath, host);
}

/**
 * The host of a URL-ish config value, normalized; null when there is none.
 * @param {*} value - `https://name:port` or a bare name.
 * @returns {string|null}
 */
function hostOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim();
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return normalizeHostName(u.hostname) || null;
  } catch {
    return null;
  }
}

/**
 * Settle a promise or give up when the run's deadline passes.
 * @param {Promise<*>} promise - Work.
 * @param {number} deadline - Epoch ms.
 * @param {function(): number} now - Clock.
 * @returns {Promise<{timedOut: boolean, value?: *}>}
 */
function withDeadline(promise, deadline, now) {
  const remaining = Math.max(0, deadline - now());
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), remaining);
  });
  return Promise.race([promise.then((value) => ({ timedOut: false, value })), timeout])
    .finally(() => clearTimeout(timer));
}

/**
 * What may be said about an error a row threw: its built-in class and its
 * code, both from closed shapes. Never its message or stack, which can carry
 * paths, names or credentials, so not even `--reveal` prints them.
 * @param {*} err - What was thrown.
 * @returns {string}
 */
function diagnosticOf(err) {
  if (!(err instanceof Error)) return 'non-error-value';
  const name = ERROR_CLASS_NAMES.includes(err.name) ? err.name : 'Error';
  const code = safeErrorCode(err);
  return code ? `${name} ${code}` : name;
}

/**
 * Run one row's measurement inside the run budget. A row that does not finish
 * in time is `unknown: budget exhausted`; one that throws is `unknown` with the
 * error's code only, when it has a code's shape, never its message.
 * @param {object} ctx - Run context.
 * @param {string} id - Row id.
 * @param {string} label - Row label.
 * @param {function(): Promise<object>} fn - Returns `{state, reason?, facts?}`.
 * @returns {Promise<object>} The row.
 */
async function measure(ctx, id, label, fn) {
  let settled;
  try {
    settled = await withDeadline(Promise.resolve().then(fn), ctx.deadline, ctx.deps.now);
  } catch (err) {
    const code = safeErrorCode(err);
    return { id, label, state: 'unknown', reason: code ? `internal-error:${code}` : 'internal-error', facts: [], diagnostic: diagnosticOf(err) };
  }
  if (settled.timedOut) return { id, label, state: 'unknown', reason: 'budget exhausted', facts: [] };
  const r = settled.value || {};
  return { id, label, state: r.state, reason: r.reason || null, facts: r.facts || [], data: r.data, diagnostic: null };
}

/**
 * Row 1: the tailnet identity, from `tailscale status --json`.
 * @param {object} ctx - Run context.
 * @returns {Promise<object>}
 */
async function checkTailnet(ctx) {
  const res = await runAllowed(ctx.deps, 'tailscale', ['status', '--json']);
  if (!res.ok && res.reason !== 'command-failed') return { state: 'unknown', reason: res.reason };
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { state: 'unknown', reason: res.ok ? 'unparseable' : 'daemon-unreachable' };
  }
  const backend = parsed && typeof parsed.BackendState === 'string' ? parsed.BackendState : '';
  if (backend !== 'Running') {
    if (!backend) return { state: 'unknown', reason: 'daemon-unknown' };
    if (!TAILSCALE_BACKEND_STATES.includes(backend)) return { state: 'unknown', reason: 'daemon-unrecognized-state' };
    return { state: 'unknown', reason: `daemon-${backend.toLowerCase()}` };
  }
  const tailnet = parsed.CurrentTailnet;
  if (!tailnet || tailnet.MagicDNSEnabled !== true) {
    return { state: 'unknown', reason: 'magicdns-off' };
  }
  const name = normalizeHostName(parsed.Self && parsed.Self.DNSName);
  if (!name) return { state: 'unknown', reason: 'no-name' };
  return { state: 'ok', facts: [fact('name', name, 'host')], data: { name } };
}

/**
 * Row 2: the names the configuration declares, read straight from
 * `config.json` (never through the store, which would create directories).
 * @param {object} ctx - Run context.
 * @param {object} tailnetRow - Row 1.
 * @returns {object}
 */
function checkConfig(ctx, tailnetRow) {
  const file = path.join(ctx.baseDir, 'config.json');
  const read = readBounded(ctx.deps, file, LIMITS.configBytes);
  if (!read.ok) return { state: 'unknown', reason: `config-${read.reason}` };
  let config;
  try {
    config = JSON.parse(read.content);
  } catch {
    return { state: 'unknown', reason: 'config-unparseable' };
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { state: 'unknown', reason: 'config-unparseable' };
  }

  const ingressMode = ingressModeOf(config);
  const facts = [fact('ingressMode', ingressMode, 'code')];
  const states = [];
  if (ingressMode === 'unsupported') states.push('unknown');
  const names = [];
  const caddyTailnetHost = config.caddyTailnetHost ? normalizeHostName(config.caddyTailnetHost) : null;
  if (config.caddyTailnetHost) {
    if (caddyTailnetHost) {
      facts.push(fact('caddyTailnetHost', caddyTailnetHost, 'host'));
      names.push(caddyTailnetHost);
    } else {
      facts.push(fact('caddyTailnetHost', 'not a DNS name', 'code'));
      states.push('drift');
    }
  }
  if (config.primaryUrl) {
    const h = hostOf(config.primaryUrl);
    facts.push(fact('primaryUrl', config.primaryUrl, 'url'));
    if (h) names.push(h);
    else states.push('drift');
  }
  if (Array.isArray(config.urlAliases)) {
    for (const alias of config.urlAliases) {
      const h = hostOf(alias && typeof alias === 'object' ? alias.host : alias);
      if (h) {
        facts.push(fact('urlAlias', h, 'host'));
        names.push(h);
      } else {
        facts.push(fact('urlAlias', 'not a DNS name', 'code'));
        states.push('drift');
      }
    }
  }
  if (config.publicDomain) {
    const h = normalizeHostName(config.publicDomain);
    facts.push(fact('publicDomain', h || 'not a DNS name', h ? 'host' : 'code'));
    if (h) names.push(h);
    else states.push('drift');
  }

  const observed = tailnetRow.data && tailnetRow.data.name;
  if (caddyTailnetHost && observed && caddyTailnetHost !== observed) {
    facts.push(fact('disagrees', 'caddyTailnetHost is not the tailnet name', 'code'));
    states.push('drift');
  }
  if (names.length === 0) facts.push(fact('names', 'none declared', 'code'));
  const state = combineStates(states);
  return {
    state,
    reason: state === 'unknown' ? 'ingressMode-unsupported' : null,
    facts,
    data: { config, names: [...new Set(names)] }
  };
}

/**
 * Row 3: the Caddyfile's sites.
 * @param {object} ctx - Run context.
 * @param {object|null} config - Parsed config, or null when unreadable.
 * @returns {object}
 */
function checkCaddyfile(ctx, config) {
  const file = path.join(ctx.baseDir, 'Caddyfile');
  const read = readBounded(ctx.deps, file, LIMITS.caddyfileBytes);
  const ingressMode = config ? ingressModeOf(config) : null;
  if (!read.ok) {
    if (read.reason === 'absent') {
      if (ingressMode === 'caddy') return { state: 'drift', reason: 'absent while ingressMode is caddy', data: { absent: true } };
      if (ingressMode === 'direct') return { state: 'observed', reason: 'absent (ingressMode direct)', data: { absent: true } };
      if (ingressMode === 'unsupported') return { state: 'unknown', reason: 'absent; ingressMode unsupported', data: { absent: true } };
    }
    return { state: 'unknown', reason: `caddyfile-${read.reason}` };
  }

  const parsed = parseCaddyfile(read.content);
  const origin = classifyCaddyfileContent(read.content).state === 'generated' ? 'generated' : 'hand-edited';
  const facts = [fact('origin', origin, 'code'), fact('path', file, 'path')];
  let topology = 'no marker';
  if (parsed.marker) topology = parsed.marker.version ? `marker ${parsed.marker.version}` : 'marker of an unsupported version';
  facts.push(fact('topology', topology, 'code'));
  parsed.sites.forEach((site, i) => {
    for (const a of site.addresses) {
      const label = `site ${i + 1} address${a.scheme === 'http' ? ' (http)' : ''}`;
      if (a.host) facts.push(fact(label, a.host, isIpLiteral(a.host) ? 'ip' : 'host'));
      else facts.push(fact(label, a.port ? `:${a.port}` : 'catch-all', 'code'));
    }
    if (site.tls) facts.push(fact(`site ${i + 1} tls`, site.tls.form === 'files' ? site.tls.certPath : 'not a certificate file', site.tls.form === 'files' ? 'path' : 'code'));
    if (site.redirect) facts.push(fact(`site ${i + 1} redirects to`, site.redirect, 'url'));
  });

  if (parsed.unsupported.length > 0) {
    return { state: 'unknown', reason: `unsupported shape: ${parsed.unsupported.join(', ')}`, facts, data: { parsed, origin } };
  }
  // The product's own reader decides whether the file names one tailnet site:
  // when it finds exactly one, nothing here may call the file ambiguous.
  const candidates = new Set(parsed.sites.filter(isTlsFqdnSite).map((s) => normalizeHostName(s.addresses[0].host)));
  if (!parsed.marker && extractTailnetHost(read.content) === null && candidates.size > 1) {
    return { state: 'ambiguous', reason: `${candidates.size} tls sites each headed by one DNS name, and no topology marker says which is meant`, facts, data: { parsed, origin } };
  }
  return { state: 'ok', facts, data: { parsed, origin } };
}

/**
 * Row 4: each certificate file a site's `tls` line names, read (never the key
 * file beside it).
 * @param {object} ctx - Run context.
 * @param {object} caddyRow - Row 3.
 * @returns {object}
 */
function checkCertificates(ctx, caddyRow) {
  const parsed = caddyRow.data && caddyRow.data.parsed;
  if (!parsed) {
    return { state: caddyRow.state === 'observed' || caddyRow.state === 'drift' ? 'observed' : 'unknown', reason: 'no Caddyfile read', data: { certs: new Map() } };
  }
  const paths = [...new Set(parsed.sites.filter((s) => s.tls && s.tls.form === 'files').map((s) => s.tls.certPath))];
  const certs = new Map();
  const facts = [];
  const states = [];
  for (const certPath of paths) {
    const read = readBounded(ctx.deps, certPath, LIMITS.certificateBytes);
    if (!read.ok) {
      certs.set(certPath, null);
      facts.push(fact('certificate', certPath, 'path'), fact('unreadable', read.reason, 'code'));
      states.push('unknown');
      continue;
    }
    let x509;
    try {
      x509 = new crypto.X509Certificate(read.content);
    } catch {
      certs.set(certPath, null);
      facts.push(fact('certificate', certPath, 'path'), fact('unreadable', 'not a certificate', 'code'));
      states.push('unknown');
      continue;
    }
    // Parsed once above, so certSanHosts' failure path (which logs the path)
    // is reached only if the file changes between the two reads.
    const sans = httpsSetup.certSanHosts(certPath);
    const expires = new Date(x509.validTo);
    const expired = expires.getTime() <= ctx.deps.now();
    certs.set(certPath, { x509, sans });
    facts.push(fact('certificate', certPath, 'path'));
    for (const san of sans) facts.push(fact('  carries', san, isIpLiteral(san) ? 'ip' : 'host'));
    facts.push(fact('  expires', expires.toISOString(), 'text'));
    states.push(expired ? 'drift' : 'ok');
    if (expired) facts.push(fact('  expired', 'yes', 'code'));
  }
  if (paths.length === 0) return { state: 'observed', reason: 'no site names a certificate file', data: { certs } };
  return { state: combineStates(states), facts, data: { certs } };
}

/**
 * Row 5: H's own restatement of the names a newly minted certificate would
 * likely carry. Advisory only: it is not the product's minting code, which
 * this check must not call.
 * @param {object} ctx - Run context.
 * @param {object} rows - Earlier rows by id.
 * @returns {object}
 */
function checkProposedNames(ctx, rows) {
  const names = new Set(httpsSetup.MKCERT_HOSTS_DEFAULT);
  const certs = rows.certificates.data && rows.certificates.data.certs;
  if (certs) {
    for (const entry of certs.values()) if (entry) entry.sans.forEach((s) => names.add(s));
  }
  const standard = path.join(ctx.baseDir, 'certs', 'cert.pem');
  if (!certs || !certs.has(standard)) {
    const read = readBounded(ctx.deps, standard, LIMITS.certificateBytes);
    if (read.ok) {
      try {
        new crypto.X509Certificate(read.content);
        httpsSetup.certSanHosts(standard).forEach((s) => names.add(s));
      } catch {
        // An unreadable standard cert adds nothing; the advisory list is still useful.
      }
    }
  }
  const mdns = httpsSetup.mdnsHostFor(ctx.deps.hostname());
  if (mdns) names.add(mdns.toLowerCase());
  const config = rows.config.data && rows.config.data.config;
  const tailnet = (config && normalizeHostName(config.caddyTailnetHost)) || (rows.tailnet.data && rows.tailnet.data.name);
  if (tailnet) names.add(tailnet);
  if (config && normalizeHostName(config.publicDomain)) names.add(normalizeHostName(config.publicDomain));
  const facts = [fact('label', ADVISORY_LABEL, 'text')];
  for (const n of names) facts.push(fact('name', n, isIpLiteral(n) ? 'ip' : 'host'));
  return { state: 'observed', facts };
}

/**
 * Row 6: per-site certificate coverage, and whether each declared name is
 * answered by some site.
 * @param {object} ctx - Run context.
 * @param {object} rows - Earlier rows by id.
 * @param {string[]} names - The capped name list.
 * @returns {object}
 */
function checkCoverage(ctx, rows, names) {
  const caddy = rows.caddyfile;
  if (caddy.data && caddy.data.absent) return { state: 'observed', reason: 'no Caddyfile, so no Caddy site to check' };
  if (!caddy.data || !caddy.data.parsed || caddy.state === 'unknown') return { state: 'unknown', reason: 'Caddyfile not measured' };
  const parsed = caddy.data.parsed;
  const certs = (rows.certificates.data && rows.certificates.data.certs) || new Map();
  const facts = [];
  const states = [];

  parsed.sites.forEach((site, i) => {
    if (!site.tls) return;
    if (site.tls.form !== 'files') {
      facts.push(fact(`site ${i + 1}`, 'tls is not a certificate file', 'code'));
      states.push('unknown');
      return;
    }
    const cert = certs.get(site.tls.certPath);
    for (const a of site.addresses) {
      if (!a.host || a.scheme === 'http') continue;
      if (!cert) {
        facts.push(fact(`site ${i + 1}`, a.host, 'host'), fact('  its certificate', 'unreadable', 'code'));
        states.push('unknown');
      } else if (certCovers(site.tls.certPath, cert, a.host)) {
        facts.push(fact(`site ${i + 1} covered`, a.host, isIpLiteral(a.host) ? 'ip' : 'host'));
        states.push('ok');
      } else {
        facts.push(fact(`site ${i + 1} NOT covered by its own certificate`, a.host, isIpLiteral(a.host) ? 'ip' : 'host'));
        states.push('drift');
      }
    }
  });

  const answered = new Set(parsed.sites.flatMap((s) => s.addresses.map((a) => a.host).filter(Boolean)));
  const declared = new Set((rows.config.data && rows.config.data.names) || []);
  const tailnetName = rows.tailnet.data && rows.tailnet.data.name;
  for (const name of names) {
    if (!declared.has(name) && name !== tailnetName) continue;
    if (answered.has(name)) {
      facts.push(fact('answered by a site', name, 'host'));
      states.push('ok');
    } else if (declared.has(name)) {
      facts.push(fact('declared but answered by no site', name, 'host'));
      states.push('drift');
    } else {
      // Not declared in config, so nothing requires a Caddy site for it. Its
      // absence is recorded as a fact; whether something else (Tailscale Serve,
      // say) answers this name is NOT checked here.
      facts.push(fact('undeclared tailnet name: no Caddy site answers it (not checked elsewhere)', name, 'host'));
      states.push('observed');
    }
  }
  return { state: combineStates(states, 'observed'), facts };
}

/**
 * GET `/api/ports` from the running server over loopback: one request, a
 * timeout and a size cap, no redirect following, and no credentials of any
 * kind (no cookie, no service token, no launch headers).
 * @param {object} ctx - Run context.
 * @param {object|null} config - Parsed config.
 * @returns {Promise<{ok: boolean, leases?: object[], reason?: string}>}
 */
function fetchLeases(ctx, config) {
  const protocol = httpsSetup.effectiveServerProtocol(config || {});
  // The port the installed server was launched with (its launchd plist), then
  // config. Not effectiveServerPort: that reads THIS process's TANGLECLAW_PORT,
  // which a terminal running this script does not have.
  const port = httpsSetup.installedServerPort(ctx.deps.serverPlistPath, config || {});
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const options = {
      host: '127.0.0.1',
      port,
      path: '/api/ports',
      method: 'GET',
      headers: { accept: 'application/json' },
      agent: false,
      timeout: LIMITS.portsTimeoutMs
    };
    let req;
    try {
      req = (protocol === 'https' ? ctx.deps.https : ctx.deps.http).request(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); finish({ ok: false, reason: 'redirect' }); return; }
        if (res.statusCode === 401 || res.statusCode === 403) { res.resume(); finish({ ok: false, reason: `refused-${res.statusCode}` }); return; }
        if (res.statusCode !== 200) { res.resume(); finish({ ok: false, reason: `status-${Number.isInteger(res.statusCode) ? res.statusCode : 'other'}` }); return; }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > LIMITS.portsBodyBytes) { req.destroy(); finish({ ok: false, reason: 'output-too-large' }); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(Array.isArray(body.leases) ? { ok: true, leases: body.leases } : { ok: false, reason: 'unparseable' });
          } catch {
            finish({ ok: false, reason: 'unparseable' });
          }
        });
        res.on('error', () => finish({ ok: false, reason: 'server-unreachable' }));
      });
    } catch {
      finish({ ok: false, reason: 'server-unreachable' });
      return;
    }
    req.on('timeout', () => { req.destroy(); finish({ ok: false, reason: 'server-timeout' }); });
    // TLS verification stays on. A certificate that cannot be verified for
    // 127.0.0.1 is a reason to say `unknown`, never to read the leases anyway,
    // and there is no second, insecure attempt.
    req.on('error', (err) => finish({ ok: false, reason: isTlsError(err) ? 'tls-unverified' : 'server-unreachable' }));
    req.end();
  });
}

/**
 * Whether a request error is a TLS verification failure.
 * @param {*} err - The error.
 * @returns {boolean}
 */
function isTlsError(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  return code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || /CERT|SELF_SIGNED|UNABLE_TO_|HOSTNAME|ALTNAME/.test(code);
}

/**
 * The local port a serve handler's proxy target points at, if it is local.
 * @param {string} target - e.g. `http://127.0.0.1:3101` or `3101`.
 * @returns {number|null}
 */
function localTargetPort(target) {
  const text = String(target || '').trim();
  if (/^\d{1,5}$/.test(text)) return Number(text);
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname)) return null;
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * Row 7: routes `tailscale serve` exposes, compared with PortHub's leases.
 * Every route is `observed`; an unleased one is a fact, not a failure.
 * @param {object} ctx - Run context.
 * @param {object} rows - Earlier rows by id.
 * @returns {Promise<object>}
 */
async function checkRoutes(ctx, rows) {
  const config = rows.config.data && rows.config.data.config;
  const [serve, leases] = await Promise.all([
    runAllowed(ctx.deps, 'tailscale', ['serve', 'status', '--json']),
    fetchLeases(ctx, config)
  ]);
  if (!serve.ok) return { state: 'unknown', reason: serve.reason === 'command-failed' ? 'serve-status-failed' : serve.reason };
  let parsed;
  try {
    parsed = JSON.parse(serve.stdout || '{}');
  } catch {
    return { state: 'unknown', reason: 'unparseable' };
  }
  const routes = [];
  for (const [hostPort, web] of Object.entries((parsed && parsed.Web) || {})) {
    for (const [mount, handler] of Object.entries((web && web.Handlers) || {})) {
      if (handler && handler.Proxy) routes.push({ front: hostPort, mount, kind: 'proxy', target: handler.Proxy });
      else if (handler && handler.Path) routes.push({ front: hostPort, mount, kind: 'files', target: null });
      else routes.push({ front: hostPort, mount, kind: 'text', target: null });
    }
  }
  for (const [port, tcp] of Object.entries((parsed && parsed.TCP) || {})) {
    if (tcp && tcp.TCPForward) routes.push({ front: `:${port}`, mount: null, kind: 'tcp', target: tcp.TCPForward });
  }
  const facts = [];
  if (!leases.ok) facts.push(fact('lease comparison', leases.reason, 'code'));
  for (const r of routes) {
    facts.push(fact('route', `${r.front}${r.mount && r.mount !== '/' ? r.mount : ''}`, 'route'));
    if (r.target) facts.push(fact('  forwards to', r.target, 'route'));
    else facts.push(fact('  serves', r.kind, 'code'));
    const port = r.target ? localTargetPort(r.target) : null;
    if (!leases.ok || port === null) continue;
    const lease = leases.leases.find((l) => l && l.port === port && (l.host || 'localhost') === 'localhost');
    if (lease) facts.push(fact('  leased by', lease.project, 'project'));
    else facts.push(fact('  lease', 'unleased', 'code'));
  }
  if (parsed && parsed.AllowFunnel && Object.values(parsed.AllowFunnel).some(Boolean)) facts.push(fact('funnel', 'on for at least one route', 'code'));
  if (routes.length === 0) facts.push(fact('routes', 'none', 'code'));
  if (!leases.ok) return { state: 'unknown', reason: `lease comparison: ${leases.reason}`, facts };
  return { state: 'observed', facts };
}

/**
 * Row 8: whether the local mkcert root issued the certificates, and whether
 * this machine trusts it. The root is looked up only in `$CAROOT` or mkcert's
 * default directory; `mkcert` is never run.
 * @param {object} ctx - Run context.
 * @param {object} rows - Earlier rows by id.
 * @returns {Promise<object>}
 */
async function checkTrust(ctx, rows) {
  const certs = (rows.certificates.data && rows.certificates.data.certs) || new Map();
  const leaves = [...certs.entries()].filter(([, v]) => v);
  if (leaves.length === 0) return { state: 'observed', reason: 'no certificate to check' };
  const caroot = ctx.deps.env.CAROOT || defaultCaroot(ctx.deps);
  if (!caroot) return { state: 'unknown', reason: 'no mkcert root directory on this platform' };
  const rootPath = path.join(caroot, 'rootCA.pem');
  const read = readBounded(ctx.deps, rootPath, LIMITS.certificateBytes);
  if (!read.ok) return { state: 'unknown', reason: `root-${read.reason}` };
  let root;
  try {
    root = new crypto.X509Certificate(read.content);
  } catch {
    return { state: 'unknown', reason: 'root-not-a-certificate' };
  }
  const facts = [fact('root', rootPath, 'path')];
  const states = [];
  let anyIssued = false;
  for (const [certPath, { x509 }] of leaves) {
    let issued = false;
    try {
      issued = x509.checkIssued(root) && x509.verify(root.publicKey);
    } catch {
      issued = false;
    }
    facts.push(fact(issued ? 'issued by the local root' : 'NOT issued by the local root', certPath, 'path'));
    if (issued) anyIssued = true;
    else states.push('unknown');
  }
  if (!anyIssued) return { state: 'unknown', reason: 'no certificate was issued by the local root', facts };
  if (ctx.deps.platform !== 'darwin') {
    facts.push(fact('trusted', 'not measurable on this platform', 'code'));
    return { state: 'unknown', reason: 'trust check is macOS only', facts };
  }
  const verify = await runAllowed(ctx.deps, 'security', ['verify-cert', '-c', rootPath]);
  if (verify.ok) {
    facts.push(fact('trusted', 'yes', 'code'));
    states.push('ok');
  } else if (/CSSMERR_TP_NOT_TRUSTED/.test(`${verify.stdout}\n${verify.stderr}`)) {
    facts.push(fact('trusted', 'no (CSSMERR_TP_NOT_TRUSTED)', 'code'));
    states.push('drift');
  } else {
    facts.push(fact('trusted', verify.reason || 'verify-failed', 'code'));
    states.push('unknown');
  }
  return { state: combineStates(states), facts };
}

/**
 * mkcert's own per-platform default root directory. The same rule as
 * `lib/https-setup.js#_defaultCaroot`, which is private and reads the
 * process's own platform and home; restated so the platform is injectable
 * and each platform's branch can be tested.
 * @param {object} deps - Injected dependencies.
 * @returns {string|null}
 */
function defaultCaroot(deps) {
  const home = deps.homedir();
  if (deps.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'mkcert');
  if (deps.platform === 'win32') return deps.env.LOCALAPPDATA ? path.join(deps.env.LOCALAPPDATA, 'mkcert') : null;
  return path.join(deps.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'mkcert');
}

/**
 * Row 9: whether each name resolves on THIS machine. Local evidence only: it
 * proves nothing about what another device resolves.
 * @param {object} ctx - Run context.
 * @param {string[]} names - The capped name list.
 * @returns {Promise<object>}
 */
async function checkResolution(ctx, names) {
  const lookups = names.filter((n) => !isIpLiteral(n)).map((name) => new Promise((resolve) => {
    let timer = setTimeout(() => { timer = null; resolve({ name, state: 'unknown', reason: 'lookup-timeout' }); }, LIMITS.lookupTimeoutMs);
    ctx.deps.dnsLookup(name, { all: true }, (err, addresses) => {
      if (timer === null) return;
      clearTimeout(timer);
      if (!err) resolve({ name, state: 'ok', addresses: (addresses || []).map((a) => a.address) });
      else if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') resolve({ name, state: 'drift', reason: 'does not resolve' });
      else resolve({ name, state: 'unknown', reason: safeErrorCode(err) || 'lookup-failed' });
    });
  }));
  const results = await Promise.all(lookups);
  const facts = [fact('scope', 'local-only: proves nothing for other devices', 'text')];
  for (const r of results) {
    facts.push(fact('name', r.name, 'host'));
    if (r.state === 'ok') for (const a of r.addresses) facts.push(fact('  resolves to', a, 'ip'));
    else facts.push(fact('  result', r.reason, 'code'));
  }
  return { state: combineStates(results.map((r) => r.state), 'observed'), facts };
}

/**
 * Row 10: a pending ingress transaction journal. This version has no journal
 * format to inspect, so the row looks at nothing and says so, rather than
 * claiming the absence of a file it never checked for.
 * @returns {object}
 */
function checkJournal() {
  return { state: 'observed', reason: 'journal inspection unsupported in this version; not checked' };
}

/**
 * Every distinct name the run measures, capped.
 * @param {object} rows - Rows 1-3 by id.
 * @returns {{names: string[], truncated: number}}
 */
function collectNames(rows) {
  const all = new Set();
  if (rows.tailnet.data && rows.tailnet.data.name) all.add(rows.tailnet.data.name);
  for (const n of (rows.config.data && rows.config.data.names) || []) all.add(n);
  const parsed = rows.caddyfile.data && rows.caddyfile.data.parsed;
  if (parsed) {
    for (const s of parsed.sites) {
      for (const a of s.addresses) {
        if (a.host && a.host !== 'localhost' && !isIpLiteral(a.host) && normalizeHostName(a.host)) all.add(normalizeHostName(a.host));
      }
    }
  }
  const names = [...all];
  return { names: names.slice(0, LIMITS.maxNames), truncated: Math.max(0, names.length - LIMITS.maxNames) };
}

/**
 * The real dependencies. Tests replace any of them.
 * @returns {object}
 */
function defaultDeps() {
  return {
    execFile: childProcess.execFile,
    fs,
    http,
    https,
    dnsLookup: dns.lookup,
    env: process.env,
    platform: process.platform,
    homedir: os.homedir,
    hostname: os.hostname,
    now: Date.now,
    serverPlistPath: undefined
  };
}

/**
 * Run the whole check.
 * @param {object} [options]
 * @param {string} [options.baseDir] - TangleClaw's base directory (default: `TANGLECLAW_HOME` or `~/.tangleclaw`).
 * @param {number} [options.budgetMs] - Whole-run budget (default 20 s).
 * @param {object} [options.deps] - Dependency overrides.
 * @returns {Promise<{rows: object[], exitCode: number}>}
 */
async function runHostCheck(options = {}) {
  const deps = { ...defaultDeps(), ...(options.deps || {}) };
  const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : LIMITS.runBudgetMs;
  const ctx = {
    deps,
    baseDir: options.baseDir || tangleclawHome.baseDir(),
    deadline: deps.now() + budgetMs
  };
  const rows = {};
  rows.tailnet = await measure(ctx, 'tailnet', 'Tailnet identity', () => checkTailnet(ctx));
  rows.config = await measure(ctx, 'config', 'Configured names', () => checkConfig(ctx, rows.tailnet));
  const config = rows.config.data && rows.config.data.config;
  rows.caddyfile = await measure(ctx, 'caddyfile', 'Caddyfile sites', () => checkCaddyfile(ctx, config || null));
  rows.certificates = await measure(ctx, 'certificates', 'Certificates, actual', () => checkCertificates(ctx, rows.caddyfile));
  rows.proposed = await measure(ctx, 'proposed', 'Certificate names, proposed', () => checkProposedNames(ctx, rows));
  const { names, truncated } = collectNames(rows);
  rows.coverage = await measure(ctx, 'coverage', 'Coverage, per site', () => checkCoverage(ctx, rows, names));
  const [routes, trust, resolution] = await Promise.all([
    measure(ctx, 'routes', 'Observed routes', () => checkRoutes(ctx, rows)),
    measure(ctx, 'trust', 'Local trust', () => checkTrust(ctx, rows)),
    measure(ctx, 'resolution', 'Local resolution (local-only)', () => checkResolution(ctx, names))
  ]);
  rows.routes = routes;
  rows.trust = trust;
  rows.resolution = resolution;
  rows.journal = await measure(ctx, 'journal', 'Ingress transaction journal', () => checkJournal());

  const ordered = ['tailnet', 'config', 'caddyfile', 'certificates', 'proposed', 'coverage', 'routes', 'trust', 'resolution', 'journal']
    .map((id) => rows[id]);
  if (truncated > 0) {
    ordered.push({ id: 'names', label: 'Names', state: 'unknown', reason: `truncated (${truncated} not checked)`, facts: [] });
  }
  return { rows: ordered, exitCode: exitCodeFor(ordered) };
}

/**
 * The exit code for a set of rows: 3 for any drift or ambiguity, else 4 for
 * any unknown, else 0.
 * @param {object[]} rows - Rows.
 * @returns {number}
 */
function exitCodeFor(rows) {
  const states = rows.map((r) => r.state);
  if (states.includes('drift') || states.includes('ambiguous')) return EXIT_DRIFT;
  if (states.includes('unknown')) return EXIT_UNKNOWN;
  return EXIT_OK;
}

/**
 * Render a run as text.
 * @param {{rows: object[], exitCode: number}} result - The run.
 * @param {{reveal?: boolean}} [options]
 * @returns {string}
 */
function formatReport(result, options = {}) {
  const redactor = new Redactor(options.reveal);
  const lines = [];
  if (options.reveal) {
    lines.push('PRIVATE: this output shows host names, addresses, paths and URLs from this machine. Do not paste it publicly.');
  }
  lines.push('TangleClaw host check (read-only)');
  lines.push(NETWORK_NOTE);
  if (!options.reveal) lines.push('Redacted: names, addresses, paths, URLs and project names are replaced with tokens. --reveal shows them.');
  lines.push('');
  for (const row of result.rows) {
    const reason = row.reason ? `: ${row.reason}` : '';
    lines.push(`[${row.state}] ${row.label}${reason}`);
    for (const f of row.facts) lines.push(`    ${f.label}: ${redactor.render(f.value, f.kind)}`);
    if (row.diagnostic && options.reveal) lines.push(`    diagnostic: ${row.diagnostic}`);
  }
  lines.push('');
  const meaning = {
    [EXIT_OK]: 'every row is ok or observed',
    [EXIT_DRIFT]: 'at least one row is drift or ambiguous',
    [EXIT_UNKNOWN]: 'at least one row could not be measured'
  }[result.exitCode];
  lines.push(`Exit ${result.exitCode}: ${meaning}.`);
  return `${lines.join('\n')}\n`;
}

module.exports = {
  runHostCheck,
  formatReport,
  exitCodeFor,
  parseCaddyfile,
  isAllowedCommand,
  runAllowed,
  sanitizeUrl,
  safeErrorCode,
  Redactor,
  ROW_STATES,
  LIMITS,
  ADVISORY_LABEL,
  NETWORK_NOTE,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_DRIFT,
  EXIT_UNKNOWN
};

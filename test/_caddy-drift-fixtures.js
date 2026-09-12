'use strict';

// The Caddyfiles behind the `caddy adapt` fixtures used by
// `test/caddy-drift.test.js`, and the config that generates them.
//
// Shared between the suite and `scripts/regen-caddy-adapt-fixtures.js` so the
// committed JSON and the text it came from can never describe different files.
// One owner: the suite re-derives the JSON whenever `caddy` is on PATH and
// compares it to the committed copy, so a Caddy release that changes the JSON
// shape surfaces as a failing test rather than as a check that quietly stops
// matching reality.
//
// Deliberately NOT named `*.test.js`: the suite command is
// `node --test 'test/*.test.js'`, and a helper collected as a test file would
// report as an empty suite.

const caddy = require('../lib/caddy');

// A throwaway bcrypt hash generated for these fixtures. No live credential is
// ever written into the committed JSON — `caddy adapt` embeds the hash verbatim
// in its output, which is also why the drift check redacts before reporting.
const FIXTURE_HASH = '$2a$14$abcdefghijklmnopqrstuv0123456789ABCDEFGHIJKLMNOPQRSTU';

const FIXTURE_TAILNET_HOST = 'fixture-box.tailnet-example.ts.net';
const FIXTURE_SERVER_PORT = 3102;
const FIXTURE_HTTPS_PORT = 8443;
const FIXTURE_HTTP_PORT = 8080;

/** The port the hand-added block fronts — the shape of the 2026 incident. */
const FIXTURE_STRAY_PORT = 3250;

/**
 * The config a generated fixture corresponds to, so a test can hand the same
 * values to `checkCaddyDrift` that produced the baseline.
 * @param {object} [overrides] - Fields to replace.
 * @returns {object} A TangleClaw-shaped config object.
 */
function fixtureConfig(overrides = {}) {
  return {
    serverPort: FIXTURE_SERVER_PORT,
    caddyHttpsPort: FIXTURE_HTTPS_PORT,
    caddyHttpPort: FIXTURE_HTTP_PORT,
    authEnabled: true,
    basicAuthUser: 'fixture',
    basicAuthHash: FIXTURE_HASH,
    caddyTailnetHost: FIXTURE_TAILNET_HOST,
    caddyRemoteHttp: false,
    caddyAccessLogPath: null,
    publicDomain: null,
    ...overrides
  };
}

/**
 * Build a generated Caddyfile from a fixture config, through the real
 * generator — never a hand-written imitation of its output.
 * @param {object} [configOverrides] - Passed to `fixtureConfig`.
 * @returns {string} Caddyfile text.
 */
function generatedCaddyfile(configOverrides = {}) {
  const config = fixtureConfig(configOverrides);
  return caddy.buildCaddyfileContent({
    serverPort: config.serverPort,
    certPath: '/fixtures/cert.pem',
    keyPath: '/fixtures/key.pem',
    httpsPort: config.caddyHttpsPort,
    httpPort: config.caddyHttpPort,
    publicDomain: config.publicDomain,
    basicAuthUser: config.authEnabled ? config.basicAuthUser : null,
    basicAuthHash: config.authEnabled ? config.basicAuthHash : null,
    remoteHttpCatchAll: config.caddyRemoteHttp === true,
    tailnetHost: config.caddyTailnetHost,
    accessLogPath: config.caddyAccessLogPath
  });
}

// The hand-added block, transcribed from the shape of the real incident: a bare
// `<host>:<port>` site that reverse-proxies straight to a project's own port,
// with no gate and no `tls` of its own.
//
// Appended, not prepended — Caddy requires the keyless global options block to
// come first, and a fixture that cannot be adapted proves nothing. Position in
// the file does not matter to what this fixture is for: adding this block moves
// the HTTPS listener off whichever `srvN` name it had, which is the observed
// fact that makes server names unusable as a key.
const HAND_ADDED_BLOCK = `
${FIXTURE_TAILNET_HOST}:${FIXTURE_STRAY_PORT} {
\treverse_proxy 127.0.0.1:${FIXTURE_STRAY_PORT}
}
`;

const FIXTURE_CADDYFILES = {
  // What TangleClaw generates today: gated tailnet + localhost sites, an h1-pinned
  // HTTPS listener, an http->https redirect, one upstream.
  generated: generatedCaddyfile(),

  // The same file with the incident's hand-added block on top. Gate, h1 pin and
  // known upstream all still correct for the sites TC owns.
  'hand-edited': generatedCaddyfile() + HAND_ADDED_BLOCK,

  // A config with no credential: the generator emits ungated sites, which is a
  // real product state (direct-mode installs, pre-cutover boxes) and must read
  // as "no gate property to diverge from", not as drift.
  ungated: generatedCaddyfile({ authEnabled: false, caddyTailnetHost: null }),

  // The generated file with the `protocols h1` pin stripped from the HTTPS
  // listener — the h2/h3 regression that breaks terminal WebSockets in Chrome.
  'no-h1': (() => {
    const pinned = `\n\tservers :${FIXTURE_HTTPS_PORT} {\n\t\tprotocols h1\n\t}`;
    const text = generatedCaddyfile();
    if (!text.includes(pinned)) {
      throw new Error('the generator no longer emits the h1 pin this fixture strips');
    }
    return text.replace(pinned, '');
  })()
};

module.exports = {
  FIXTURE_CADDYFILES,
  fixtureConfig,
  generatedCaddyfile,
  FIXTURE_HASH,
  FIXTURE_TAILNET_HOST,
  FIXTURE_SERVER_PORT,
  FIXTURE_HTTPS_PORT,
  FIXTURE_HTTP_PORT,
  FIXTURE_STRAY_PORT,
  HAND_ADDED_BLOCK
};

'use strict';

/**
 * The callers the shared-docs and groups routes tell apart, as request
 * headers a test can send. Those routes refuse a caller with no binding, so a
 * test has to say which caller it is playing.
 *
 * Not a test file: the leading underscore keeps it out of the suite glob.
 * @module test/_shared-docs-callers
 */

const http = require('node:http');
const authSession = require('../lib/auth-session');
const store = require('../lib/store');
const launchSequence = require('../lib/launch-sequence');

/**
 * Headers that make a request the operator's dashboard on a scratch store,
 * where no admin account exists and the gate stands down: a same-origin
 * browser request.
 * @param {import('node:http').Server} server - The listening test server
 * @returns {Record<string, string>}
 */
function operatorHeaders(server) {
  const { port } = server.address();
  return { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' };
}

/**
 * Start a session for a project with a launch binding, as a real launch does,
 * without starting a pane.
 * @param {{id: number}} project - Project record
 * @returns {{launchId: string, sessionId: number, headers: Record<string, string>}}
 *   `headers` are the two a project pane sends, per the shared-docs guide.
 */
function bindProject(project) {
  const launchId = launchSequence.mintLaunchId();
  const snapshot = launchSequence.buildSnapshot({
    launchId,
    project,
    engineProfile: store.engines.get('claude'),
    applicability: { applicable: false, reason: 'test binding' },
    rendered: null,
    rules: []
  });
  const session = store.sessions.start({ projectId: project.id, engineId: 'claude', launchSequence: snapshot });
  return {
    launchId,
    sessionId: session.id,
    headers: {
      'x-tangleclaw-project-id': String(project.id),
      'x-tangleclaw-launch-id': launchId
    }
  };
}

/**
 * The account {@link signInOperator} creates or signs in to when a test names
 * none. The password meets `caddy.validateAdminPassword`.
 * @type {Readonly<{username: string, password: string}>}
 */
const DEFAULT_OPERATOR = Object.freeze({ username: 'operator', password: 'Fixture-Passphrase-2233' });

/**
 * Send one JSON request to the test server with exactly the identity given:
 * no headers is a bare request on the loopback listener, which is what a local
 * tool that is not a TangleClaw session sends.
 * @param {import('node:http').Server} server - The listening test server
 * @param {string} method - HTTP method
 * @param {string} urlPath - Request path
 * @param {object} [body] - JSON body
 * @param {Record<string, string>} [headers] - The caller's headers
 * @returns {Promise<{status: number, headers: object, data: any}>}
 */
function sendAs(server, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: urlPath,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Send one browser-shaped JSON request to the test server.
 * @param {import('node:http').Server} server - The listening test server
 * @param {string} method - HTTP method
 * @param {string} urlPath - Request path
 * @param {object} [body] - JSON body
 * @param {Record<string, string>} [headers] - Extra headers
 * @returns {Promise<{status: number, headers: object, data: any}>}
 */
function _browserRequest(server, method, urlPath, body, headers = {}) {
  return sendAs(server, method, urlPath, body, { ...operatorHeaders(server), ...headers });
}

/**
 * Attempt one write as each of the two callers who are not the operator on an
 * install whose gate enforces: a browser holding no session, and a bare
 * request on the loopback listener. The caller asserts what came back and
 * that nothing changed; this only sends, so it cannot make a test pass.
 *
 * What the server answers them (#2233): the gate challenges the browser with
 * 401, and the launch binding guard refuses the bare request with 403
 * `LAUNCH_BINDING_REQUIRED`, because the gate's machine carve-out lets it past
 * the login and nothing says who it is.
 *
 * @param {import('node:http').Server} server - The listening test server
 * @param {string} method - HTTP method
 * @param {string} urlPath - Request path
 * @param {object} [body] - JSON body
 * @returns {Promise<{browser: {status: number, data: any}, machine: {status: number, data: any}}>}
 */
async function attemptUnidentified(server, method, urlPath, body) {
  const browser = await _browserRequest(server, method, urlPath, body);
  const machine = await sendAs(server, method, urlPath, body);
  return { browser, machine };
}

/**
 * Sign the operator in the way a browser does, and return the headers that
 * browser then sends on a write: the session and CSRF cookies, the CSRF token
 * in the header the gate compares it with, and the same-origin browser shape.
 *
 * Nothing is seeded behind the server's back. While the install has no account
 * (`account-required`) the first one is created through the one route that
 * state leaves open, `POST /api/auth/set-password`; then, in every case, the
 * session is taken from `POST /api/auth/login`. The install's gate must be
 * enforcing: on an open install there is nothing to sign in to, and
 * {@link operatorHeaders} is the operator there.
 *
 * The session lives in the store the server is using, so it ends when a test
 * replaces that store or the account. Sign in again after either.
 *
 * @param {import('node:http').Server} server - The listening test server
 * @param {{username?: string, password?: string}} [account] - The account to
 *   create or sign in to; defaults to {@link DEFAULT_OPERATOR}
 * @returns {Promise<Record<string, string>>} Headers for a signed-in write
 * @throws {Error} When the account cannot be created or the sign-in is refused,
 *   naming the status and code the server answered
 */
async function signInOperator(server, account = {}) {
  const username = account.username || DEFAULT_OPERATOR.username;
  const password = account.password || DEFAULT_OPERATOR.password;

  const me = await _browserRequest(server, 'GET', '/api/auth/me');
  if (me.status !== 200) {
    throw new Error(`signInOperator: GET /api/auth/me answered ${me.status}`);
  }
  if (me.data.gateState === 'account-required') {
    const created = await _browserRequest(server, 'POST', '/api/auth/set-password', { username, password });
    if (created.status !== 200) {
      throw new Error(`signInOperator: the first account was refused (${created.status} ${created.data && created.data.code})`);
    }
  }

  const login = await _browserRequest(server, 'POST', '/api/auth/login', { username, password });
  if (login.status !== 200) {
    throw new Error(`signInOperator: the sign-in was refused (${login.status} ${login.data && login.data.code}) `
      + `while the gate was "${me.data.gateState}"`);
  }
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  return {
    ...operatorHeaders(server),
    Cookie: cookie,
    [authSession.CSRF_HEADER]: login.data.csrfToken
  };
}

/**
 * Build the operator of one test server: a function answering the headers the
 * operator's browser sends on a write, for whatever state the install is in
 * when it is asked.
 *
 * - While the gate stands down (`open`, `fallback`) the dashboard itself is the
 *   operator, so the answer is {@link operatorHeaders}.
 * - While it enforces, the operator is a signed-in account, so the answer is
 *   {@link signInOperator}'s. The session is kept and reused for as long as the
 *   server still honours it, and taken again when a test has replaced the
 *   store, the account or the session.
 *
 * It grants nothing: every request it describes passes the gate and the launch
 * binding guard on the same evidence a real browser presents. In a state where
 * nobody can sign in (`locked`, `unreadable`) it throws, as `signInOperator`
 * does.
 *
 * @param {import('node:http').Server|function(): import('node:http').Server} server -
 *   The listening test server, or a function returning it for suites that
 *   assign it in a `before` hook
 * @param {{username?: string, password?: string}} [account] - Passed to
 *   {@link signInOperator}
 * @returns {function(): Promise<Record<string, string>>}
 */
function operatorOf(server, account = {}) {
  let session = null;
  return async function writeHeaders() {
    const live = typeof server === 'function' ? server() : server;
    const me = await _browserRequest(live, 'GET', '/api/auth/me');
    if (me.status === 200 && me.data.gateActive === false) return operatorHeaders(live);
    if (session) {
      const mine = await _browserRequest(live, 'GET', '/api/auth/me', undefined, { Cookie: session.Cookie });
      if (mine.status === 200 && mine.data.authenticated === true) return session;
    }
    session = await signInOperator(live, account);
    return session;
  };
}

module.exports = {
  operatorHeaders,
  bindProject,
  signInOperator,
  operatorOf,
  sendAs,
  attemptUnidentified,
  DEFAULT_OPERATOR
};

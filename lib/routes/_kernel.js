'use strict';

/**
 * The HTTP kernel every route module shares: the route table and its matcher,
 * the JSON and error responders, the body parser with its size refusal, the
 * request-URL and query helpers, and the two body-size constants.
 *
 * `server.js` is the entry point: it requires this module, registers each area's
 * routes from `lib/routes/<area>.js` at the position those routes held, and
 * re-exports every name here that it exported before the split, so nothing that
 * requires the server changes. A route module requires this kernel directly and
 * receives only the not-yet-moved server helpers it needs through its
 * `register` call.
 *
 * Everything below is moved from `server.js` unchanged (#2248); the one
 * thing this file adds is the export list.
 *
 * @module lib/routes/_kernel
 */

const MAX_BODY_SIZE = 10 * 1024; // 10 KB

// The body cap for the routes that carry a message a person or agent wrote — the
// switchboard send / loop / continue family (both mounts) and the session command
// route. 10 KB turned an ordinary multi-paragraph hand-off into a refusal (#1514).
// This is the ONE place the number lives: the switchboard status response serves
// it to the browser, and every 413 carries it back as `limitBytes`, so the UI and
// `tc` render the limit they were actually held to rather than a copy of it.
const MESSAGE_BODY_LIMIT_BYTES = 64 * 1024;

// ── Route Table ──

const routes = [];

/**
 * Register a route handler.
 * @param {string} method - HTTP method
 * @param {string} pattern - URL pattern (supports :param segments)
 * @param {Function} handler - (req, res, params, body) => void
 * @param {object} [options] - Optional route config
 * @param {number} [options.maxBodySize] - Override MAX_BODY_SIZE for this route
 * @param {{action: string, logLine?: string, refusal?: string}} [options.signedInOperator] - The route
 *   grants or approves authority over sessions, so the operator must be signed in: the dispatcher
 *   refuses an operator admitted by shape alone before the handler runs (`_requireSignedInOperator`)
 */
function route(method, pattern, handler, options) {
  const paramNames = [];
  const regexStr = pattern.replace(/:([^/]+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  routes.push({
    method: method.toUpperCase(),
    pattern,
    regex: new RegExp(`^${regexStr}$`),
    paramNames,
    handler,
    options: options || {}
  });
}

/**
 * Match a request to a route.
 * @param {string} method - HTTP method
 * @param {string} pathname - URL path
 * @returns {{ handler: Function, params: object, options: object, method: string, pattern: string }|null}
 *   `method` and `pattern` are the route's own, as registered: what the
 *   launch-binding guard keys its exception list on.
 */
function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const match = pathname.match(r.regex);
    if (match) {
      const params = {};
      r.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      return { handler: r.handler, params, options: r.options || {}, method: r.method, pattern: r.pattern };
    }
  }
  return null;
}

// ── Response Helpers ──

/**
 * Send a JSON response.
 * @param {http.ServerResponse} res
 * @param {number} status - HTTP status code
 * @param {object} data - Response body
 */
function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * Send a standard error response.
 * @param {http.ServerResponse} res
 * @param {number} status - HTTP status code
 * @param {string} message - Error message
 * @param {string} code - Machine-readable error code
 * @param {object} [extra] - Extra fields merged into the body, for refusals that
 *   share a code and differ by detail (e.g. the master kill's two 500s). It
 *   cannot override `error` or `code` — see below.
 */
function errorResponse(res, status, message, code, extra) {
  // `extra` carries fields a client needs to tell two refusals apart when they
  // share a code — the master kill's two 500s differ only by `cause`.
  //
  // Spread FIRST, so `error` and `code` always win. Spreading it last read as
  // harmless with one caller passing `{ cause }`, and quietly meant any future
  // caller could blank the two fields every client branches on — a hazard that
  // looks safe while it has no reach, which is the shape this whole issue is
  // about. Made impossible rather than documented.
  jsonResponse(res, status, { ...(extra || {}), error: message, code });
}

// ── Body Parser ──

/**
 * The 413 refusal for an over-limit body, carrying the numbers a client needs to
 * say what happened: `limitBytes` (the cap this route enforced) and
 * `receivedBytes` (how big the body was).
 *
 * `receivedBytes` is exact when the request declared a Content-Length: Node's
 * HTTP parser frames the body by that header, so the body is exactly that long
 * even though reading stops at the limit. Without one (chunked transfer) the
 * body is abandoned mid-stream and its full size is never learned, so the count
 * at the moment of refusal is reported with `receivedBytesIsLowerBound: true` —
 * "at least this much", never a guessed total.
 * @param {http.IncomingMessage} req - The request being refused.
 * @param {number} counted - Bytes read when the limit was crossed.
 * @param {number} limit - The route's body cap in bytes.
 * @returns {{status: number, message: string, code: string, extra: object}}
 */
function bodyTooLarge(req, counted, limit) {
  const declared = Number(req.headers && req.headers['content-length']);
  const exact = Number.isSafeInteger(declared) && declared > limit;
  const receivedBytes = exact ? declared : counted;
  return {
    status: 413,
    message: `Request body too large: ${exact ? '' : 'more than '}${receivedBytes} bytes, limit is ${limit} bytes`,
    code: 'BODY_TOO_LARGE',
    extra: exact
      ? { limitBytes: limit, receivedBytes }
      : { limitBytes: limit, receivedBytes, receivedBytesIsLowerBound: true }
  };
}

/**
 * Parse JSON request body with size limit.
 * @param {http.IncomingMessage} req
 * @param {number} [maxSize] - Override default max body size
 * @returns {Promise<object|null>}
 */
function parseBody(req, maxSize) {
  const limit = maxSize || MAX_BODY_SIZE;
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      return resolve(null);
    }

    const chunks = [];
    let size = 0;
    let rejected = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit && !rejected) {
        rejected = true;
        // Resume and discard remaining data so the response can be sent
        req.resume();
        reject(bodyTooLarge(req, size, limit));
        return;
      }
      if (!rejected) {
        chunks.push(chunk);
      }
    });

    req.on('end', () => {
      if (size === 0) return resolve(null);
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch (err) {
        reject({ status: 400, message: 'Invalid JSON in request body', code: 'BAD_REQUEST' });
      }
    });

    req.on('error', (err) => {
      reject({ status: 500, message: err.message, code: 'INTERNAL_ERROR' });
    });
  });
}

// ── Parse Query String ──

/**
 * Build the request URL, tolerating an absent Host header (falls back to
 * localhost). Consolidates the repeated `new URL(req.url, ...)` idiom so the
 * localhost fallback can't drift per call site.
 * @param {http.IncomingMessage} req - Incoming request
 * @returns {URL}
 */
function reqUrl(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
}

/**
 * Parse URL query parameters.
 * @param {string} search - Query string (e.g. '?key=value')
 * @returns {object}
 */
function parseQuery(search) {
  const params = {};
  if (!search) return params;
  const stripped = search.startsWith('?') ? search.slice(1) : search;
  for (const pair of stripped.split('&')) {
    const [key, ...rest] = pair.split('=');
    if (key) {
      params[decodeURIComponent(key)] = decodeURIComponent(rest.join('=') || '');
    }
  }
  return params;
}

/**
 * Every registered route's method and pattern, for tests that must cover a
 * family of routes as registered rather than as a list someone remembered to
 * update (#2032: the gated-route test enumerates the Medusa routes this way).
 * `options` is the route's own registration options, which is what the
 * launch-binding guard is handed: the coverage test judges each route with the
 * same three facts the dispatcher does.
 * @returns {Array<{method: string, pattern: string, options: object}>}
 */
function _routePatterns() {
  return routes.map((r) => ({ method: r.method, pattern: r.pattern, options: r.options }));
}

module.exports = { route, matchRoute, _routePatterns, jsonResponse, errorResponse, bodyTooLarge, parseBody, reqUrl, parseQuery, MAX_BODY_SIZE, MESSAGE_BODY_LIMIT_BYTES };

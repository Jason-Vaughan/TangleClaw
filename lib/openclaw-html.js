'use strict';

// OpenClaw's Control UI index, as served by 2026.9+ gateways, references its
// bundle by ROOT-ABSOLUTE path (`src="/assets/index-….js"`) with an empty base
// path. Behind TangleClaw's proxy the page lives under a prefix
// (`/openclaw-direct/<connId>/`, `/openclaw/<project>/`), so those requests reach
// TangleClaw's own root, 404, and the UI never mounts. Older builds used relative
// `./assets/…` and needed nothing. This module moves root-absolute references
// under the prefix and tells the bundle its base path; the bundle builds its
// config and WebSocket URLs from that base path itself.

const zlib = require('node:zlib');

/** Bodies larger than this stream through unmodified rather than being buffered. */
const MAX_REWRITE_BYTES = 2 * 1024 * 1024;

const BASE_PATH_ATTR = 'data-openclaw-control-ui-base-path';

// #254 Issue A — device-pairing continuity across proxy launches. Every
// `/openclaw-direct/<connId>` path shares the SAME TangleClaw origin
// (same scheme+host+port; only the connId path segment differs), and
// browser `localStorage` is scoped by ORIGIN, not by path — so a stable
// id written here under THIS key persists across every connId a browser
// visits on this install, unlike whatever key (if any) OpenClaw's own
// bundle happens to use.
//
// This is a BRIDGING HELPER, not a guaranteed fix: it exposes the stable
// id via `window[DEVICE_IDENTITY_GLOBAL]` and a `<meta
// name="tc-openclaw-device-id">` tag for OpenClaw's bundle (or an
// operator's own tooling) to read. Whether a given OpenClaw gateway
// version actually reads either is outside this repo's control — OpenClaw
// is a third-party container whose bundle source this module never sees.
const DEVICE_IDENTITY_STORAGE_KEY = 'tc-openclaw-device-id';
const DEVICE_IDENTITY_META_NAME = 'tc-openclaw-device-id';
const DEVICE_IDENTITY_GLOBAL = '__tangleclawOpenclawDeviceId';

// #254 Issue A, I-Gate Round 1 (#5799591957), Ruling A505-R4.5 — the
// bridging helper above has no consumer in OpenClaw's own bundle and
// cannot read a genuinely different origin's (e.g. `openclaw.io`'s)
// localStorage at all (RFC 6454 Same-Origin Policy), so it cannot by
// itself deliver the continuity #254 asks for. What CAN: TangleClaw
// already has a verified, working approval path —
// `POST /api/openclaw/connections/:id/approve-pending`
// (`lib/openclaw-approve.js#approvePending`, SSH + `docker exec openclaw
// devices approve`) — today only reachable by an operator running it by
// hand. Every `/openclaw-direct/<connId>/` page load already names its
// own connId in the proxy prefix, so the injected bootstrap can trigger
// that SAME approval automatically, same-origin, with the operator's own
// session cookie, with no new server-side route.
const APPROVE_PENDING_GLOBAL = '__tangleclawApproveOpenclawDevice';

// A device pairing request is typically filed once the gateway has fully
// seen the WebSocket handshake, which can land a short moment after the
// initial page load's own fetch. One retry, not a poll loop: the operator
// is relaunching ONE specific access path, not leaving the tab open
// waiting for a pairing that may never come.
const APPROVE_PENDING_RETRY_DELAY_MS = 2000;

/**
 * Escape a value for use inside a double-quoted HTML attribute.
 * @param {string} value
 * @returns {string}
 */
function _escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Rewrite an OpenClaw Control UI page so it works under a proxy prefix.
 *
 * Only root-absolute `src`/`href` attribute values inside tags change (`"/x"`);
 * protocol-relative (`"//host/x"`), absolute (`"https://…"`) and relative
 * (`"./x"`) values could already be resolved correctly, or never pointed at the
 * gateway, and are left alone. The base-path attribute is filled when it is empty
 * or absent. A page whose gateway declares its own base path is returned
 * unchanged.
 *
 * @param {string} html - The page as served by the gateway.
 * @param {string} prefix - Proxy prefix without a trailing slash, e.g. `/openclaw-direct/abc`.
 * @returns {string} The rewritten page; unchanged when there is nothing to rewrite.
 */
function rewriteControlUiHtml(html, prefix) {
  if (typeof html !== 'string' || !prefix) return html;
  const base = prefix.replace(/\/+$/, '');
  const escaped = _escapeAttr(base);
  const declared = new RegExp(`(\\s${BASE_PATH_ATTR}=)(["'])(.*?)\\2`, 'i');
  const match = html.match(declared);
  // A gateway that declares its own base path is laying its page out for that
  // path already; rewriting half of it would leave it inconsistent.
  if (match && match[3] !== '') return html;
  // Scoped to tags, so text that merely looks like an attribute (in a comment or
  // a script string) is not touched.
  let out = html.replace(/<[a-zA-Z][^<>]*>/g, (tag) =>
    tag.replace(/(\s(?:src|href)=)(["'])\/(?!\/)/gi, (_m, attr, quote) => `${attr}${quote}${escaped}/`));
  if (out === html) return html;
  if (match) {
    out = out.replace(declared, (_m, attr) => `${attr}"${escaped}"`);
  } else {
    out = out.replace(/<html(\s|>)/i, (_m, rest) => `<html ${BASE_PATH_ATTR}="${escaped}"${rest}`);
  }
  return out;
}

/**
 * The `connId` out of an `/openclaw-direct/<connId>` prefix (#254 Issue A).
 * `prefix` already carries the DECODED segment (the callers that build it —
 * `server.js`'s HTTP and WS proxy handlers — already ran it through
 * `decodeURIComponent`/`_decodeUpgradeSegment` before building the prefix),
 * so this is a plain extraction, not a second decode.
 * @param {string} prefix
 * @returns {string|null}
 */
function _connIdFromDirectPrefix(prefix) {
  if (typeof prefix !== 'string') return null;
  const m = /^\/openclaw-direct\/([^/]+)/.exec(prefix);
  return m ? m[1] : null;
}

/**
 * The device-identity bootstrap's own markup (#254 Issue A/B). Two
 * independent pieces, each in its own try/catch so one failing cannot
 * block the other:
 *
 * 1. Mints a stable id once (`crypto.randomUUID` when available, a
 *    timestamp+random fallback otherwise) and persists it in
 *    `localStorage` under `DEVICE_IDENTITY_STORAGE_KEY`; every later visit
 *    on this origin reads the same id back. Still a BRIDGING helper with
 *    no confirmed OpenClaw-side consumer — see module header.
 * 2. When `connId` is known (every `/openclaw-direct/<connId>/` load),
 *    triggers TangleClaw's OWN already-working, same-origin approval path
 *    (`POST /api/openclaw/connections/<connId>/approve-pending`) once on
 *    load and once more after `APPROVE_PENDING_RETRY_DELAY_MS`, so an
 *    authenticated operator switching access paths gets the pairing
 *    approved automatically instead of running the SSH/docker command by
 *    hand. Exposed as `window[APPROVE_PENDING_GLOBAL]` so a caller (or a
 *    test) can invoke it directly rather than waiting out the timer.
 * @param {string|null} connId
 * @returns {string} A `<script>` tag.
 */
function _deviceIdentityBootstrapScript(connId) {
  const identity = `(function(){try{`
    + `var k=${JSON.stringify(DEVICE_IDENTITY_STORAGE_KEY)};`
    + `var id=localStorage.getItem(k);`
    + `if(!id){id=(window.crypto&&window.crypto.randomUUID)?window.crypto.randomUUID():(Date.now().toString(36)+Math.random().toString(36).slice(2));`
    + `localStorage.setItem(k,id);}`
    + `window[${JSON.stringify(DEVICE_IDENTITY_GLOBAL)}]=id;`
    + `var m=document.createElement('meta');m.name=${JSON.stringify(DEVICE_IDENTITY_META_NAME)};m.content=id;`
    + `if(document.head)document.head.appendChild(m);`
    + `}catch(e){}})();`;

  let approval = '';
  if (connId) {
    const url = `/api/openclaw/connections/${encodeURIComponent(connId)}/approve-pending`;
    // #254 I-Gate Round 2: a signed-in auth gate refuses every state-changing
    // POST without X-CSRF-Token matching the session's own tc_csrf cookie
    // (lib/auth-gate.js). Read it the same way any other same-origin caller
    // would, rather than exempting this one route from CSRF.
    approval = `(function(){try{`
      + `var approve=function(){try{`
      + `var m=(typeof document!=='undefined'&&document.cookie?document.cookie:'').match(/(?:^|;\\s*)tc_csrf=([^;]+)/);`
      + `var csrf=m?decodeURIComponent(m[1]):'';`
      + `return fetch(${JSON.stringify(url)},{method:'POST',credentials:'same-origin',headers:csrf?{'X-CSRF-Token':csrf}:{}}).catch(function(){});`
      + `}catch(e){}};`
      + `window[${JSON.stringify(APPROVE_PENDING_GLOBAL)}]=approve;`
      + `approve();`
      + `setTimeout(approve,${APPROVE_PENDING_RETRY_DELAY_MS});`
      + `}catch(e){}})();`;
  }
  return `<script>${identity}${approval}</script>`;
}

/**
 * Inject the device-identity bootstrap into an OpenClaw Control UI page,
 * right after `<head>` (or right after `<html ...>` when the page has no
 * `<head>` tag at all) so it runs before OpenClaw's own bundle has a
 * chance to generate its own identity (#254 Issue A). Idempotent: a page
 * that already carries the bootstrap — this function run twice, or a
 * gateway that happens to echo the marker — is returned unchanged rather
 * than injecting a second copy.
 * @param {string} html
 * @param {string} [prefix] - The proxy prefix this page is served under
 *   (e.g. `/openclaw-direct/<connId>`). When it names a `/openclaw-direct/`
 *   connId, the bootstrap also wires the automatic pairing-approval call
 *   (#254 Issue A, Ruling A505-R4.5); omitted or any other prefix shape
 *   skips that half and injects only the identity bridge.
 * @returns {string} The page with the bootstrap injected; unchanged when there is nowhere to inject it.
 */
function injectDeviceIdentityBootstrap(html, prefix) {
  if (typeof html !== 'string' || html.includes(DEVICE_IDENTITY_GLOBAL)) return html;
  const connId = _connIdFromDirectPrefix(prefix);
  const script = _deviceIdentityBootstrapScript(connId);
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${script}`);
  }
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<html(\s[^>]*)?>/i, (m) => `${m}${script}`);
  }
  return html;
}

/**
 * Should this proxied exchange be rewritten? Only a successful GET of an HTML page:
 * a HEAD or a 304 has no body to rewrite, and a redirect or error page never
 * carries the bundle references this exists for.
 * @param {string} method - The client's request method.
 * @param {number} status - The upstream status code.
 * @param {object} headers - Upstream response headers (lowercased keys).
 * @returns {boolean}
 */
function shouldRewrite(method, status, headers) {
  return method === 'GET' && status === 200
    && /^\s*text\/html\b/i.test(String((headers && headers['content-type']) || ''));
}

/**
 * Decode a body by its `Content-Encoding`.
 * @param {Buffer} body
 * @param {string} encoding - Lowercased encoding, or '' for none.
 * @returns {Buffer|null} The decoded bytes, or null for an unknown encoding, a decode
 *   failure, or output past `MAX_REWRITE_BYTES`.
 */
function _decode(body, encoding) {
  try {
    if (!encoding || encoding === 'identity') return body;
    // Capped on the OUTPUT: a small compressed body can expand far past the
    // input cap, and this runs on the server's only thread.
    const cap = { maxOutputLength: MAX_REWRITE_BYTES };
    if (encoding === 'br') return zlib.brotliDecompressSync(body, cap);
    if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(body, cap);
    if (encoding === 'deflate') return zlib.inflateSync(body, cap);
    return null;
  } catch {
    return null; // a body we cannot read is passed through as sent
  }
}

/** Hop-by-hop headers that must not travel with a re-framed body. */
const HOP_BY_HOP = ['transfer-encoding', 'connection', 'keep-alive'];

/**
 * Headers for a body sent whole, with an exact `Content-Length`. HTTP forbids a
 * `Content-Length` beside `Transfer-Encoding`, so the upstream's framing goes.
 * @param {object} headers
 * @param {number} length
 * @returns {object}
 */
function _framedHeaders(headers, length) {
  const out = { ...headers };
  for (const h of HOP_BY_HOP) delete out[h];
  out['content-length'] = String(length);
  return out;
}

/**
 * Relay an upstream HTML response to the client, rewritten for the proxy prefix.
 *
 * Buffers the body (up to `MAX_REWRITE_BYTES`), decodes it, rewrites it and sends
 * it uncompressed, dropping `Content-Encoding` and `ETag` because the bytes changed
 * and recomputing `Content-Length`. Anything it cannot safely rewrite (an unknown
 * encoding, a corrupt body, an oversized one) reaches the client exactly as the
 * gateway sent it, and is reported through `onFallback` so an operator whose
 * Control UI still does not start has a reason to find. An upstream that fails or
 * disconnects mid-body gets a 502 when nothing has been sent yet, and a closed
 * connection otherwise, rather than a client left waiting.
 *
 * @param {import('node:http').IncomingMessage} upstream - The gateway's response.
 * @param {import('node:http').ServerResponse} res - The client response.
 * @param {number} status - Status code to send.
 * @param {object} headers - Headers to send (already adjusted by the caller).
 * @param {string} prefix - Proxy prefix without a trailing slash.
 * @param {(reason: string) => void} [onFallback] - Told why a page was not rewritten.
 * @returns {void}
 */
function relayRewrittenHtml(upstream, res, status, headers, prefix, onFallback) {
  const fallback = typeof onFallback === 'function' ? onFallback : () => {};
  const chunks = [];
  let size = 0;
  let settled = false;
  const fail = (reason) => {
    if (settled) return;
    settled = true;
    fallback(reason);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'OpenClaw gateway response was cut off', code: 'BAD_GATEWAY' }));
    } else {
      res.destroy();
    }
  };
  const sendRaw = (raw, reason) => {
    fallback(reason);
    res.writeHead(status, _framedHeaders(headers, raw.length));
    res.end(raw);
  };
  const onData = (chunk) => {
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_REWRITE_BYTES && !settled) {
      settled = true;
      upstream.removeListener('data', onData);
      upstream.removeListener('end', onEnd);
      upstream.pause();
      fallback(`page over ${MAX_REWRITE_BYTES} bytes; sent unmodified`);
      res.writeHead(status, headers);
      for (const c of chunks) res.write(c);
      upstream.pipe(res);
    }
  };
  const onEnd = () => {
    if (settled) return;
    settled = true;
    const raw = Buffer.concat(chunks);
    const encoding = String(headers['content-encoding'] || '').trim().toLowerCase();
    const decoded = _decode(raw, encoding);
    if (!decoded) {
      sendRaw(raw, `could not decode a ${encoding || 'plain'} page; sent unmodified`);
      return;
    }
    const text = decoded.toString('utf8');
    let rewritten = rewriteControlUiHtml(text, prefix);
    // #254 Issue A — scoped to the direct-proxy prefix specifically: the
    // continuity problem (a new connId reading as a new device) is a
    // property of THAT path, not of the project-scoped `/openclaw/*` proxy.
    if (typeof prefix === 'string' && prefix.startsWith('/openclaw-direct/')) {
      rewritten = injectDeviceIdentityBootstrap(rewritten, prefix);
    }
    if (rewritten === text) {
      // Nothing to move (a relative-path build): send the gateway's bytes as-is,
      // compression and ETag included.
      res.writeHead(status, _framedHeaders(headers, raw.length));
      res.end(raw);
      return;
    }
    const body = Buffer.from(rewritten, 'utf8');
    const out = _framedHeaders(headers, body.length);
    delete out['content-encoding'];
    delete out.etag;
    res.writeHead(status, out);
    res.end(body);
  };
  upstream.on('data', onData);
  upstream.on('end', onEnd);
  upstream.on('error', (err) => fail(`gateway response failed: ${err.message}`));
  // `close` before `end` is how current Node reports a dropped upstream;
  // `aborted` is the older, deprecated signal for the same thing.
  upstream.on('aborted', () => fail('gateway closed the connection mid-page'));
  upstream.on('close', () => fail('gateway closed the connection mid-page'));
}

/**
 * Send a proxied OpenClaw response to the client: rewritten when it is the kind
 * of page `shouldRewrite` names, streamed through otherwise. The one place both
 * OpenClaw proxy prefixes hand their upstream response to.
 * @param {import('node:http').IncomingMessage} req - The client request.
 * @param {import('node:http').ServerResponse} res - The client response.
 * @param {import('node:http').IncomingMessage} upstream - The gateway's response.
 * @param {object} headers - Headers to send (already adjusted by the caller).
 * @param {string} prefix - The proxy prefix the page is served under.
 * @param {{warn: Function}} [log] - Where rewrite fallbacks are reported.
 * @returns {void}
 */
function relayOpenclawResponse(req, res, upstream, headers, prefix, log) {
  if (shouldRewrite(req.method, upstream.statusCode, upstream.headers)) {
    const onFallback = (reason) => {
      if (log) log.warn('OpenClaw Control UI page not rewritten', { prefix, reason });
    };
    relayRewrittenHtml(upstream, res, upstream.statusCode, headers, prefix, onFallback);
    return;
  }
  res.writeHead(upstream.statusCode, headers);
  upstream.pipe(res);
}

module.exports = {
  rewriteControlUiHtml, shouldRewrite, relayRewrittenHtml, relayOpenclawResponse, MAX_REWRITE_BYTES,
  injectDeviceIdentityBootstrap,
  DEVICE_IDENTITY_STORAGE_KEY,
  DEVICE_IDENTITY_META_NAME,
  DEVICE_IDENTITY_GLOBAL,
  APPROVE_PENDING_GLOBAL,
  APPROVE_PENDING_RETRY_DELAY_MS
};

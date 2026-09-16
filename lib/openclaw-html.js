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
 * Only root-absolute `src`/`href` values change (`"/x"`); protocol-relative
 * (`"//host/x"`), absolute (`"https://…"`) and relative (`"./x"`) values could
 * already be resolved correctly, or never pointed at the gateway, and are left
 * alone. The base-path attribute is filled only when it is empty or absent, so a
 * gateway that declares its own base path keeps it.
 *
 * @param {string} html - The page as served by the gateway.
 * @param {string} prefix - Proxy prefix without a trailing slash, e.g. `/openclaw-direct/abc`.
 * @returns {string} The rewritten page; unchanged when there is nothing to rewrite.
 */
function rewriteControlUiHtml(html, prefix) {
  if (typeof html !== 'string' || !prefix) return html;
  const base = prefix.replace(/\/+$/, '');
  let out = html.replace(/(\s(?:src|href)=)(["'])\/(?!\/)/gi, (_m, attr, quote) => `${attr}${quote}${base}/`);
  const escaped = _escapeAttr(base);
  const declared = new RegExp(`(\\s${BASE_PATH_ATTR}=)(["'])(.*?)\\2`, 'i');
  const match = out.match(declared);
  if (match) {
    if (match[3] === '') out = out.replace(declared, (_m, attr) => `${attr}"${escaped}"`);
  } else if (out !== html) {
    // Only a page that needed rewriting is an OpenClaw page we should annotate.
    out = out.replace(/<html(\s|>)/i, (_m, rest) => `<html ${BASE_PATH_ATTR}="${escaped}"${rest}`);
  }
  return out;
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
 * @returns {Buffer|null} The decoded bytes, or null for an unknown encoding or a decode failure.
 */
function _decode(body, encoding) {
  try {
    if (!encoding || encoding === 'identity') return body;
    if (encoding === 'br') return zlib.brotliDecompressSync(body);
    if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(body);
    if (encoding === 'deflate') return zlib.inflateSync(body);
    return null;
  } catch {
    return null; // a body we cannot read is passed through as sent
  }
}

/**
 * Relay an upstream HTML response to the client, rewritten for the proxy prefix.
 *
 * Buffers the body (up to `MAX_REWRITE_BYTES`), decodes it, rewrites it and sends
 * it uncompressed, dropping `Content-Encoding` and `ETag` because the bytes changed
 * and recomputing `Content-Length`. Anything it cannot safely rewrite (an unknown
 * encoding, a corrupt body, an oversized one) reaches the client exactly as the
 * gateway sent it.
 *
 * @param {import('node:http').IncomingMessage} upstream - The gateway's response.
 * @param {import('node:http').ServerResponse} res - The client response.
 * @param {number} status - Status code to send.
 * @param {object} headers - Headers to send (already adjusted by the caller).
 * @param {string} prefix - Proxy prefix without a trailing slash.
 * @returns {void}
 */
function relayRewrittenHtml(upstream, res, status, headers, prefix) {
  const chunks = [];
  let size = 0;
  let overflowed = false;
  const passThrough = (buffered) => {
    res.writeHead(status, headers);
    for (const c of buffered) res.write(c);
    upstream.pipe(res);
  };
  const onData = (chunk) => {
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_REWRITE_BYTES && !overflowed) {
      overflowed = true;
      upstream.removeListener('data', onData);
      upstream.removeListener('end', onEnd);
      upstream.pause();
      passThrough(chunks);
    }
  };
  const onEnd = () => {
    const raw = Buffer.concat(chunks);
    const encoding = String(headers['content-encoding'] || '').trim().toLowerCase();
    const decoded = _decode(raw, encoding);
    if (!decoded) {
      res.writeHead(status, headers);
      res.end(raw);
      return;
    }
    const text = decoded.toString('utf8');
    const rewritten = rewriteControlUiHtml(text, prefix);
    if (rewritten === text) {
      // Nothing to move (a relative-path build): send the gateway's bytes as-is,
      // compression and ETag included.
      res.writeHead(status, headers);
      res.end(raw);
      return;
    }
    const body = Buffer.from(rewritten, 'utf8');
    const out = { ...headers };
    delete out['content-encoding'];
    delete out.etag;
    out['content-length'] = String(body.length);
    res.writeHead(status, out);
    res.end(body);
  };
  upstream.on('data', onData);
  upstream.on('end', onEnd);
}

module.exports = { rewriteControlUiHtml, shouldRewrite, relayRewrittenHtml, MAX_REWRITE_BYTES, BASE_PATH_ATTR };

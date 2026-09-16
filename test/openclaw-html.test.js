'use strict';

/*
 * #1534 — OpenClaw 2026.9's Control UI references its bundle by root-absolute
 * path, so behind TangleClaw's proxy prefix the entry script 404s at our root and
 * the UI never mounts. The fixtures are the real index pages captured from a
 * 2026.9.4 gateway (absolute paths) and a 2026.6.11 gateway (relative paths).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { PassThrough } = require('node:stream');
const html = require('../lib/openclaw-html');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const NEW = fixture('openclaw-control-ui-2026.9.4.html');
const OLD = fixture('openclaw-control-ui-2026.6.11.html');
const PREFIX = '/openclaw-direct/03e71f59-458e-43e1-9c8c-3dbb98d16c8b';

/**
 * Every root-absolute src/href value in a page.
 * @param {string} page
 * @returns {string[]}
 */
function rootAbsolute(page) {
  return [...page.matchAll(/\s(?:src|href)=["'](\/(?!\/)[^"']*)["']/gi)].map((m) => m[1]);
}

describe('rewriteControlUiHtml (#1534)', () => {
  it('moves every root-absolute reference in a 2026.9.4 page under the prefix', () => {
    const before = rootAbsolute(NEW);
    assert.ok(before.length > 0, 'the fixture must actually carry absolute references');
    const out = html.rewriteControlUiHtml(NEW, PREFIX);
    for (const ref of rootAbsolute(out)) {
      assert.ok(ref.startsWith(`${PREFIX}/`), `${ref} must sit under the proxy prefix`);
    }
    assert.ok(out.includes(`src="${PREFIX}/assets/index-xdI_JV3r.js"`), 'the entry script is the one that must load');
  });

  it('sets the empty base-path attribute to the prefix', () => {
    const out = html.rewriteControlUiHtml(NEW, PREFIX);
    assert.match(NEW, /data-openclaw-control-ui-base-path=""/);
    assert.ok(out.includes(`data-openclaw-control-ui-base-path="${PREFIX}"`));
    assert.equal(out.match(/data-openclaw-control-ui-base-path=/g).length, 1, 'set once, not added a second time');
  });

  it('leaves a relative-path page (2026.6.11) byte-identical', () => {
    assert.equal(rootAbsolute(OLD).length, 0, 'the older build uses relative paths');
    assert.equal(html.rewriteControlUiHtml(OLD, PREFIX), OLD);
  });

  it('leaves protocol-relative, absolute and relative URLs alone', () => {
    const page = '<html><head><link href="//cdn.example/x.css"><a href="https://docs.openclaw.ai/web">d</a>'
      + '<script src="./assets/a.js"></script><img src="img/b.png"></head></html>';
    assert.equal(html.rewriteControlUiHtml(page, PREFIX), page);
  });

  it('handles single quotes and mixed-case attribute names', () => {
    const out = html.rewriteControlUiHtml(`<html><script SRC='/assets/a.js'></script></html>`, PREFIX);
    assert.ok(out.includes(`SRC='${PREFIX}/assets/a.js'`));
  });

  it('adds the base-path attribute to a rewritten page that lacks it', () => {
    const out = html.rewriteControlUiHtml('<html lang="en"><script src="/assets/a.js"></script></html>', PREFIX);
    assert.ok(out.startsWith(`<html data-openclaw-control-ui-base-path="${PREFIX}" lang="en">`));
  });

  it('keeps a base path the gateway declared itself', () => {
    const page = '<html data-openclaw-control-ui-base-path="/claw"><script src="/claw/assets/a.js"></script></html>';
    const out = html.rewriteControlUiHtml(page, PREFIX);
    assert.ok(out.includes('data-openclaw-control-ui-base-path="/claw"'));
  });

  it('escapes the prefix for the attribute, and is safe with $ in it', () => {
    const out = html.rewriteControlUiHtml('<html data-openclaw-control-ui-base-path=""><script src="/a.js"></script></html>',
      '/openclaw/a"b$&c');
    assert.ok(out.includes('data-openclaw-control-ui-base-path="/openclaw/a&quot;b$&amp;c"'));
  });

  it('tolerates a trailing slash on the prefix', () => {
    const out = html.rewriteControlUiHtml('<html><script src="/a.js"></script></html>', `${PREFIX}/`);
    assert.ok(out.includes(`src="${PREFIX}/a.js"`));
  });
});

describe('shouldRewrite (#1534)', () => {
  const HTML = { 'content-type': 'text/html; charset=utf-8' };
  it('rewrites only a successful GET of an HTML page', () => {
    assert.equal(html.shouldRewrite('GET', 200, HTML), true);
    assert.equal(html.shouldRewrite('HEAD', 200, HTML), false);
    assert.equal(html.shouldRewrite('GET', 304, HTML), false);
    assert.equal(html.shouldRewrite('GET', 302, HTML), false);
    assert.equal(html.shouldRewrite('GET', 200, { 'content-type': 'application/javascript' }), false);
    assert.equal(html.shouldRewrite('GET', 200, {}), false);
  });
});

/**
 * Relay a body through `relayRewrittenHtml` and collect what the client got.
 * @param {Buffer[]} chunks - Upstream body, in pieces.
 * @param {object} headers - Upstream headers.
 * @returns {Promise<{status: number, headers: object, body: Buffer}>}
 */
function relay(chunks, headers) {
  return new Promise((resolve) => {
    const upstream = new PassThrough();
    const got = [];
    const res = new PassThrough();
    res.writeHead = (status, h) => { res.status = status; res.sent = h; };
    res.on('data', (c) => got.push(c));
    res.on('finish', () => resolve({ status: res.status, headers: res.sent, body: Buffer.concat(got) }));
    html.relayRewrittenHtml(upstream, res, 200, headers, PREFIX);
    for (const c of chunks) upstream.write(c);
    upstream.end();
  });
}

describe('relayRewrittenHtml (#1534)', () => {
  const base = { 'content-type': 'text/html; charset=utf-8', etag: 'W/"abc"' };
  const encoders = {
    br: zlib.brotliCompressSync,
    gzip: zlib.gzipSync,
    deflate: zlib.deflateSync
  };

  for (const [encoding, encode] of Object.entries(encoders)) {
    it(`decodes ${encoding}, rewrites, and sends it uncompressed with corrected headers`, async () => {
      const packed = encode(Buffer.from(NEW));
      const r = await relay([packed.subarray(0, 100), packed.subarray(100)],
        { ...base, 'content-encoding': encoding, 'content-length': String(packed.length) });
      const text = r.body.toString('utf8');
      assert.ok(text.includes(`src="${PREFIX}/assets/index-xdI_JV3r.js"`));
      assert.equal(r.headers['content-encoding'], undefined);
      assert.equal(r.headers.etag, undefined, 'the bytes changed, so the old ETag must not be reused');
      assert.equal(r.headers['content-length'], String(r.body.length));
    });
  }

  it('rewrites an uncompressed page too', async () => {
    const r = await relay([Buffer.from(NEW)], { ...base });
    assert.ok(r.body.toString('utf8').includes(`data-openclaw-control-ui-base-path="${PREFIX}"`));
  });

  it('passes a page with nothing to rewrite through exactly as sent', async () => {
    const packed = zlib.brotliCompressSync(Buffer.from(OLD));
    const headers = { ...base, 'content-encoding': 'br', 'content-length': String(packed.length) };
    const r = await relay([packed], headers);
    assert.deepEqual(r.body, packed, 'compressed bytes untouched');
    assert.deepEqual(r.headers, headers, 'headers untouched, ETag included');
  });

  it('passes an unknown encoding through untouched', async () => {
    const raw = Buffer.from('opaque');
    const headers = { ...base, 'content-encoding': 'zstd' };
    const r = await relay([raw], headers);
    assert.deepEqual(r.body, raw);
    assert.deepEqual(r.headers, headers);
  });

  it('passes a corrupt compressed body through untouched', async () => {
    const raw = Buffer.from('not really brotli');
    const r = await relay([raw], { ...base, 'content-encoding': 'br' });
    assert.deepEqual(r.body, raw);
    assert.equal(r.headers['content-encoding'], 'br');
  });

  it('streams an oversized body through unmodified', async () => {
    const big = Buffer.alloc(html.MAX_REWRITE_BYTES + 1024, 'a');
    const head = Buffer.from('<html><script src="/assets/a.js"></script>');
    const r = await relay([head, big], { ...base });
    assert.equal(r.body.length, head.length + big.length, 'every byte arrives');
    assert.ok(r.body.subarray(0, head.length).equals(head), 'and none of it was rewritten');
    assert.equal(r.headers.etag, base.etag);
  });
});

describe('both OpenClaw proxies route HTML through the rewrite (#1534)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  it('the direct proxy passes its own prefix', () => {
    assert.match(src, /openclawHtml\.relayRewrittenHtml\(proxyRes, res, proxyRes\.statusCode, headers, `\/openclaw-direct\/\$\{parts\[2\]\}`\)/);
  });
  it('the project proxy passes its own prefix', () => {
    assert.match(src, /openclawHtml\.relayRewrittenHtml\(proxyRes, res, proxyRes\.statusCode, headers, `\/openclaw\/\$\{encodeURIComponent\(projectName\)\}`\)/);
  });
  it('both decide with shouldRewrite', () => {
    assert.equal((src.match(/openclawHtml\.shouldRewrite\(req\.method, proxyRes\.statusCode, proxyRes\.headers\)/g) || []).length, 2);
  });
});

describe('the direct proxy serves a 2026.9 page that can start (#1534, end to end)', () => {
  const http = require('node:http');
  const os = require('node:os');
  const { setLevel } = require('../lib/logger');
  const store = require('../lib/store');
  const { handleRequest } = require('../server');
  setLevel('error');

  let gateway;
  let tmpDir;
  let connId;
  const JS = 'import"./chunk.js";';

  const { before, after } = require('node:test');
  before(async () => {
    // A stand-in gateway: the captured 2026.9.4 page, Brotli-compressed the way
    // the real one sends it, plus one asset.
    gateway = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'br', etag: 'W/"x"' });
        res.end(zlib.brotliCompressSync(Buffer.from(NEW)));
      } else if (req.url === '/assets/index-xdI_JV3r.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(JS);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-oc-html-'));
    store._setBasePath(tmpDir);
    store.init();
    connId = store.openclawConnections.create({
      name: 'HtmlE2E', host: '10.0.0.9', sshUser: 'admin', sshKeyPath: '~/.ssh/id_rsa',
      localPort: gateway.address().port
    }).id;
  });

  after(async () => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await new Promise((r) => gateway.close(r));
  });

  /**
   * GET a path through the real handler and collect the response.
   * @param {string} url
   * @returns {Promise<{status: number, headers: object, body: string}>}
   */
  function get(url) {
    return new Promise((resolve) => {
      const req = new PassThrough();
      req.url = url;
      req.method = 'GET';
      req.headers = { host: 'localhost:3102' };
      const res = new PassThrough();
      const got = [];
      res.writeHead = (status, h) => { res.status = status; res.sent = h || {}; };
      res.setHeader = () => {};
      res.getHeader = () => undefined;
      res.on('data', (c) => got.push(c));
      res.on('finish', () => resolve({ status: res.status, headers: res.sent, body: Buffer.concat(got).toString('utf8') }));
      handleRequest(req, res);
      req.end();
    });
  }

  it('rewrites the page so its entry script resolves under the prefix', async () => {
    const r = await get(`/openclaw-direct/${connId}/`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], undefined);
    assert.ok(r.body.includes(`src="/openclaw-direct/${connId}/assets/index-xdI_JV3r.js"`));
    assert.ok(r.body.includes(`data-openclaw-control-ui-base-path="/openclaw-direct/${connId}"`));
  });

  it('and that rewritten reference is one the proxy actually serves', async () => {
    const r = await get(`/openclaw-direct/${connId}/assets/index-xdI_JV3r.js`);
    assert.equal(r.status, 200);
    assert.equal(r.body, JS, 'non-HTML responses stream through unchanged');
  });
});

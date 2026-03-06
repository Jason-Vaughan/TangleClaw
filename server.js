'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const api = require('./lib/api');
const config = require('./lib/config');
const session = require('./lib/session');

const PORT = process.env.TANGLECLAW_PAGE_PORT || 3101;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Reverse proxy helper: forward HTTP request to ttyd
function proxyHttp(req, res, ttydPort) {
  const target = req.url.replace(/^\/terminal/, '') || '/';
  const opts = {
    hostname: '127.0.0.1',
    port: ttydPort,
    path: target,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${ttydPort}` },
  };
  const proxy = http.request(opts, (upstream) => {
    res.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(res, { end: true });
  });
  proxy.on('error', () => {
    res.writeHead(502);
    res.end('ttyd unavailable');
  });
  req.pipe(proxy, { end: true });
}

// Reverse proxy helper: forward WebSocket upgrade to ttyd
function proxyWs(req, socket, head, ttydPort) {
  const target = req.url.replace(/^\/terminal/, '') || '/';
  const conn = net.connect({ host: '127.0.0.1', port: ttydPort }, () => {
    const reqLine = `${req.method} ${target} HTTP/${req.httpVersion}\r\n`;
    const headers = Object.entries({ ...req.headers, host: `127.0.0.1:${ttydPort}` })
      .map(([k, v]) => `${k}: ${v}`).join('\r\n');
    conn.write(reqLine + headers + '\r\n\r\n');
    if (head.length) conn.write(head);
    conn.pipe(socket, { end: true });
    socket.pipe(conn, { end: true });
  });
  conn.on('error', () => socket.destroy());
  socket.on('error', () => conn.destroy());
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // Reverse proxy: /terminal/* → ttyd
  if (urlPath.startsWith('/terminal')) {
    const cfg = config.load();
    proxyHttp(req, res, cfg.ttydPort);
    return;
  }

  // API routes
  if (urlPath.startsWith('/api/')) {
    if (!api.dispatch(req, res)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    }
    return;
  }

  // Session wrapper page: /session/:name
  const sessionMatch = urlPath.match(/^\/session\/([^/]+)$/);
  if (sessionMatch) {
    const projectName = decodeURIComponent(sessionMatch[1]);
    const cfg = config.load();
    const html = session.renderPage(projectName, cfg.ttydPort);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  serveStatic(req, res);
});

// Handle WebSocket upgrades for /terminal/ws
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/terminal')) {
    const cfg = config.load();
    proxyWs(req, socket, head, cfg.ttydPort);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`TangleClaw v2 running on http://0.0.0.0:${PORT}`);
});

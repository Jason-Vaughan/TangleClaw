'use strict';

/**
 * OpenClaw standalone viewer — starts tunnel, auto-approves pairing, loads Control UI in iframe.
 */

const connId = window.location.pathname.split('/')[2];

/**
 * Show a toast notification.
 * @param {string} text - Message text
 * @param {'ok'|'warn'} type - Toast type
 * @param {number} [duration=3000] - Auto-hide duration (0 = sticky)
 */
function showToast(text, type, duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.className = `toast toast-${type} visible`;
  if (duration > 0) {
    setTimeout(() => toast.classList.remove('visible'), duration);
  }
}

/**
 * Fetch JSON from an API endpoint.
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<object|null>}
 */
async function api(url, opts) {
  try {
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (err) {
    console.error(`API ${url}:`, err.message);
    return null;
  }
}

/**
 * Initialize the OpenClaw viewer: start tunnel, load iframe, auto-approve pairing.
 */
async function init() {
  if (!connId) {
    showToast('No connection ID in URL', 'warn', 0);
    return;
  }

  // Fetch connection details for the banner
  const conn = await api(`/api/openclaw/connections/${connId}`);
  if (!conn) {
    showToast('Connection not found', 'warn', 0);
    return;
  }

  document.getElementById('bannerName').textContent = conn.name;
  document.getElementById('bannerHost').textContent = `${conn.host}:${conn.port}`;
  document.title = `TangleClaw — ${conn.name}`;

  // Start tunnel
  showToast('Starting tunnel\u2026', 'ok', 0);
  const tunnel = await api(`/api/openclaw/connections/${connId}/tunnel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });

  if (!tunnel || !tunnel.ok) {
    showToast('Tunnel failed — check SSH connectivity', 'warn', 0);
    document.getElementById('statusDot').title = 'Disconnected';
    document.getElementById('statusDot').classList.add('dead');
    return;
  }

  showToast(tunnel.alreadyUp ? 'Tunnel already up' : 'Tunnel established', 'ok');
  document.getElementById('statusDot').title = 'Connected';
  document.getElementById('statusDot').classList.add('live');

  // Load the proxy URL in the iframe
  const frame = document.getElementById('terminalFrame');
  const tokenParam = conn.gatewayToken ? `#token=${encodeURIComponent(conn.gatewayToken)}` : '';
  frame.src = `/openclaw-direct/${encodeURIComponent(connId)}/chat?session=main${tokenParam}`;

  // Auto-approve: poll for pending pairing requests and approve them
  startAutoApprove();
}

/**
 * Poll for pending device pairing requests and auto-approve them.
 * Runs for 30 seconds after page load to catch the initial pairing flow.
 */
function startAutoApprove() {
  let attempts = 0;
  const maxAttempts = 10;

  const timer = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(timer);
      return;
    }

    const result = await api(`/api/openclaw/connections/${connId}/approve-pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });

    if (result && result.approved) {
      showToast('Device paired successfully', 'ok');
      clearInterval(timer);
      // Reload iframe after brief delay to pick up the approved pairing
      setTimeout(() => {
        const frame = document.getElementById('terminalFrame');
        frame.src = frame.src;
      }, 1000);
    }
  }, 3000);
}

init();

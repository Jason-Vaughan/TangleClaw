'use strict';

const { createLogger } = require('./logger');

const log = createLogger('model-status');

let _statusCache = {};
let _pollTimer = null;
let _engines = [];

/**
 * Parse Atlassian Statuspage summary.json response into normalized status.
 * @param {object} json - Parsed summary.json response
 * @param {object} config - Engine statusPage config ({ componentId, componentName })
 * @returns {{ status: string, message: string|null }}
 */
function _parseAtlassian(json, config) {
  // Try to find the specific component
  const components = json.components || [];
  let component = null;

  if (config.componentId) {
    component = components.find(c => c.id === config.componentId);
  }
  if (!component && config.componentName) {
    component = components.find(c => c.name === config.componentName);
  }

  if (component) {
    const statusMap = {
      operational: 'operational',
      degraded_performance: 'degraded',
      partial_outage: 'partial_outage',
      major_outage: 'major_outage'
    };
    return {
      status: statusMap[component.status] || 'unknown',
      message: component.status === 'operational' ? null : component.status.replace(/_/g, ' ')
    };
  }

  // Fall back to page-level indicator
  const indicator = json.status && json.status.indicator;
  const indicatorMap = {
    none: 'operational',
    minor: 'degraded',
    major: 'partial_outage',
    critical: 'major_outage'
  };
  return {
    status: indicatorMap[indicator] || 'unknown',
    message: json.status && json.status.description || null
  };
}

/**
 * Parse Google Cloud incidents.json response into normalized status.
 * Filters for active incidents matching the configured product name.
 * @param {Array} json - Parsed incidents.json array
 * @param {object} config - Engine statusPage config ({ productName })
 * @returns {{ status: string, message: string|null }}
 */
function _parseGoogleIncidents(json, config) {
  if (!Array.isArray(json)) {
    return { status: 'unknown', message: 'Unexpected response format' };
  }

  const productName = (config.productName || '').toLowerCase();

  // Find active incidents affecting this product
  const activeIncidents = json.filter(incident => {
    // Check if incident is still active (not resolved)
    const updates = incident.most_recent_update || incident.updates?.[0];
    if (updates && updates.status === 'RESOLVED') return false;
    if (incident.end) return false;

    // Check if this product is affected
    const affected = incident.affected_products || [];
    return affected.some(p =>
      (p.title || p.name || '').toLowerCase().includes(productName)
    );
  });

  if (activeIncidents.length === 0) {
    return { status: 'operational', message: null };
  }

  // Use the highest severity from active incidents
  const severityMap = { low: 'degraded', medium: 'partial_outage', high: 'major_outage' };
  let worstStatus = 'degraded';
  let worstMessage = null;

  for (const incident of activeIncidents) {
    const severity = (incident.severity || 'low').toLowerCase();
    const mapped = severityMap[severity] || 'degraded';
    const rank = { degraded: 1, partial_outage: 2, major_outage: 3 };
    if ((rank[mapped] || 0) > (rank[worstStatus] || 0)) {
      worstStatus = mapped;
      worstMessage = incident.external_desc || incident.title || null;
    }
  }

  return { status: worstStatus, message: worstMessage || 'Active incident' };
}

/**
 * Poll a single engine's status page.
 * @param {object} profile - Engine profile with statusPage config
 * @returns {Promise<{ status: string, message: string|null, updatedAt: string, error: string|null }>}
 */
async function _pollEngine(profile) {
  const config = profile.statusPage;
  if (!config || !config.url) {
    return { status: 'unknown', message: null, updatedAt: new Date().toISOString(), error: null };
  }

  try {
    const res = await fetch(config.url, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' }
    });

    if (!res.ok) {
      return {
        status: 'unknown',
        message: null,
        updatedAt: new Date().toISOString(),
        error: `HTTP ${res.status}`
      };
    }

    const json = await res.json();
    let parsed;

    switch (config.adapter) {
      case 'atlassian':
        parsed = _parseAtlassian(json, config);
        break;
      case 'google-incidents':
        parsed = _parseGoogleIncidents(json, config);
        break;
      default:
        parsed = { status: 'unknown', message: `Unknown adapter: ${config.adapter}` };
    }

    return {
      status: parsed.status,
      message: parsed.message,
      updatedAt: new Date().toISOString(),
      error: null
    };
  } catch (err) {
    log.warn('Status poll failed', { engine: profile.id, error: err.message });
    return {
      status: 'unknown',
      message: null,
      updatedAt: new Date().toISOString(),
      error: err.message
    };
  }
}

/**
 * Poll all engines with status pages concurrently.
 * @param {object[]} [engines] - Engine profiles to poll (defaults to stored list)
 */
async function pollAll(engines) {
  const list = engines || _engines;
  const pollable = list.filter(e => e.statusPage && e.statusPage.url);

  if (pollable.length === 0) {
    log.debug('No engines with status pages to poll');
    return;
  }

  const results = await Promise.allSettled(
    pollable.map(async (profile) => {
      const result = await _pollEngine(profile);
      _statusCache[profile.id] = result;
      return { id: profile.id, ...result };
    })
  );

  const statuses = results
    .filter(r => r.status === 'fulfilled')
    .map(r => `${r.value.id}=${r.value.status}`);
  log.debug('Status poll complete', { results: statuses.join(', ') });
}

/**
 * Get cached status for all engines.
 * @returns {object} Status cache keyed by engine ID
 */
function getStatus() {
  return { ..._statusCache };
}

/**
 * Get cached status for a single engine.
 * @param {string} engineId - Engine ID to look up
 * @returns {{ status: string, message: string|null, updatedAt: string, error: string|null }|null}
 */
function getEngineStatus(engineId) {
  return _statusCache[engineId] || null;
}

/**
 * Start periodic status monitoring.
 * @param {object[]} engines - Engine profiles to monitor
 * @param {number} [intervalMs=120000] - Poll interval in milliseconds
 */
function startMonitor(engines, intervalMs = 120000) {
  if (_pollTimer) stopMonitor();

  _engines = engines || [];

  // Run initial poll
  pollAll(_engines);

  _pollTimer = setInterval(() => {
    pollAll(_engines);
  }, intervalMs);

  if (_pollTimer.unref) _pollTimer.unref();

  log.info('Model status monitor started', {
    intervalMs,
    engines: _engines.filter(e => e.statusPage && e.statusPage.url).map(e => e.id)
  });
}

/**
 * Stop periodic status monitoring.
 */
function stopMonitor() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
    log.info('Model status monitor stopped');
  }
}

/**
 * Reset internal state (for testing).
 */
function _reset() {
  _statusCache = {};
  _engines = [];
  stopMonitor();
}

module.exports = {
  startMonitor,
  stopMonitor,
  pollAll,
  getStatus,
  getEngineStatus,
  _parseAtlassian,
  _parseGoogleIncidents,
  _pollEngine,
  _reset
};

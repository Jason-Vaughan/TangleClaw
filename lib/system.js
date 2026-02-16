'use strict';

const { execSync } = require('child_process');

let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 10000; // 10 seconds

function getStats() {
  const now = Date.now();
  if (_cache && (now - _cacheTime) < CACHE_TTL) return _cache;

  const stats = {
    cpu: getCpuLoad(),
    memory: getMemory(),
    disk: getDisk(),
    uptime: getUptime(),
  };

  _cache = stats;
  _cacheTime = now;
  return stats;
}

function getCpuLoad() {
  try {
    const output = execSync('sysctl -n vm.loadavg', { encoding: 'utf-8', timeout: 3000 });
    // output like "{ 1.23 1.45 1.67 }"
    const match = output.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    if (!match) return { load1: 0, load5: 0, load15: 0 };
    return {
      load1: parseFloat(match[1]),
      load5: parseFloat(match[2]),
      load15: parseFloat(match[3]),
    };
  } catch {
    return { load1: 0, load5: 0, load15: 0 };
  }
}

function getMemory() {
  try {
    const pageSize = parseInt(execSync('sysctl -n hw.pagesize', { encoding: 'utf-8', timeout: 3000 }).trim(), 10);
    const totalMem = parseInt(execSync('sysctl -n hw.memsize', { encoding: 'utf-8', timeout: 3000 }).trim(), 10);
    const vmstat = execSync('vm_stat', { encoding: 'utf-8', timeout: 3000 });

    let free = 0, active = 0, inactive = 0, wired = 0, compressed = 0;
    vmstat.split('\n').forEach(line => {
      const match = line.match(/^(.+?):\s+(\d+)/);
      if (!match) return;
      const val = parseInt(match[2], 10) * pageSize;
      if (line.includes('free')) free = val;
      else if (line.includes('active')) active = val;
      else if (line.includes('inactive')) inactive = val;
      else if (line.includes('wired')) wired = val;
      else if (line.includes('compressor')) compressed = val;
    });

    const used = active + wired + compressed;
    const totalGB = (totalMem / 1073741824).toFixed(1);
    const usedGB = (used / 1073741824).toFixed(1);
    const pct = totalMem > 0 ? Math.round((used / totalMem) * 100) : 0;

    return { totalGB: parseFloat(totalGB), usedGB: parseFloat(usedGB), pct };
  } catch {
    return { totalGB: 0, usedGB: 0, pct: 0 };
  }
}

function getDisk() {
  try {
    const output = execSync('df -h / | tail -1', { encoding: 'utf-8', timeout: 3000 });
    const parts = output.trim().split(/\s+/);
    // typical: /dev/disk3s1s1  460Gi  186Gi  240Gi    44%  ...
    return {
      total: parts[1] || '?',
      used: parts[2] || '?',
      available: parts[3] || '?',
      pct: parseInt(parts[4], 10) || 0,
    };
  } catch {
    return { total: '?', used: '?', available: '?', pct: 0 };
  }
}

function getUptime() {
  try {
    const output = execSync('sysctl -n kern.boottime', { encoding: 'utf-8', timeout: 3000 });
    const match = output.match(/sec\s*=\s*(\d+)/);
    if (!match) return '?';
    const bootSec = parseInt(match[1], 10);
    const uptimeSec = Math.floor(Date.now() / 1000) - bootSec;
    return formatUptime(uptimeSec);
  } catch {
    return '?';
  }
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

module.exports = { getStats };

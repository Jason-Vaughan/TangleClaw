'use strict';

const os = require('node:os');
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('system');

/**
 * Get system resource stats.
 * @returns {{ cpu: object, memory: object, disk: object, uptime: number, uptimeFormatted: string, nodeVersion: string, platform: string, arch: string }}
 */
function getStats() {
  const uptime = os.uptime();
  return {
    cpu: getCpuInfo(),
    memory: getMemoryInfo(),
    disk: getDiskInfo(),
    uptime,
    uptimeFormatted: formatUptime(uptime),
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch()
  };
}

/**
 * Get CPU info.
 * @returns {{ model: string, cores: number, usage: number }}
 */
function getCpuInfo() {
  const cpus = os.cpus();
  const model = cpus.length > 0 ? cpus[0].model : 'unknown';
  const cores = cpus.length;
  const usage = _calculateCpuUsage(cpus);

  return { model, cores, usage };
}

/**
 * Calculate average CPU usage percentage across all cores.
 * @param {object[]} cpus - os.cpus() result
 * @returns {number} - Percentage 0-100
 */
function _calculateCpuUsage(cpus) {
  if (cpus.length === 0) return 0;

  let totalIdle = 0;
  let totalTick = 0;

  for (const cpu of cpus) {
    const { user, nice, sys, idle, irq } = cpu.times;
    totalIdle += idle;
    totalTick += user + nice + sys + idle + irq;
  }

  const idlePercent = (totalIdle / totalTick) * 100;
  return Math.round((100 - idlePercent) * 10) / 10;
}

/**
 * Get memory info. On macOS, uses vm_stat for accurate readings.
 * Falls back to os.freemem() on non-macOS or command failure.
 * @returns {{ total: number, used: number, free: number, percent: number }}
 */
function getMemoryInfo() {
  if (os.platform() === 'darwin') {
    try {
      return _getMacMemoryInfo();
    } catch (err) {
      log.debug('vm_stat fallback to os.freemem()', { error: err.message });
    }
  }

  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const percent = Math.round((used / total) * 1000) / 10;

  return { total, used, free, percent };
}

/**
 * Get accurate macOS memory info using vm_stat and sysctl.
 * Calculates used = (active + wired + compressed) pages * pageSize.
 * @returns {{ total: number, used: number, free: number, percent: number }}
 */
function _getMacMemoryInfo() {
  const pageSize = parseInt(execSync('sysctl -n hw.pagesize', { timeout: 2000, encoding: 'utf8' }).trim(), 10);
  const totalMem = parseInt(execSync('sysctl -n hw.memsize', { timeout: 2000, encoding: 'utf8' }).trim(), 10);
  const vmStatOutput = execSync('vm_stat', { timeout: 2000, encoding: 'utf8' });

  const parsed = _parseVmStat(vmStatOutput, pageSize);
  const used = parsed.active + parsed.wired + parsed.compressed;
  const free = totalMem - used;
  const percent = Math.round((used / totalMem) * 1000) / 10;

  return { total: totalMem, used, free: Math.max(free, 0), percent };
}

/**
 * Parse vm_stat output into byte values.
 * @param {string} output - vm_stat output
 * @param {number} pageSize - Page size in bytes
 * @returns {{ active: number, wired: number, compressed: number, free: number }}
 */
function _parseVmStat(output, pageSize) {
  const getPages = (label) => {
    const match = output.match(new RegExp(`${label}:\\s+(\\d+)`));
    return match ? parseInt(match[1], 10) : 0;
  };

  return {
    active: getPages('Pages active') * pageSize,
    wired: getPages('Pages wired down') * pageSize,
    compressed: getPages('Pages occupied by compressor') * pageSize,
    free: getPages('Pages free') * pageSize
  };
}

/**
 * Format uptime seconds into human-readable string.
 * @param {number} seconds - Uptime in seconds
 * @returns {string} - e.g. "3d 2h", "5h 30m", "12m"
 */
function formatUptime(seconds) {
  if (typeof seconds !== 'number' || seconds < 0) return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * On macOS (Catalina through Sequoia/Tahoe), `/` is the read-only Sealed
 * System Volume -- a few GiB, never where user/application data lives.
 * That data sits on this APFS volume instead, sharing the same physical
 * container (and its total/free block counts) as `/` (#3217). `df -k /`
 * alone reports the Sealed System Volume's own tiny usage against the
 * shared container's full size, understating real disk fullness by over
 * 40x on a typical machine.
 * @type {string}
 */
const MACOS_DATA_VOLUME = '/System/Volumes/Data';

/**
 * Get disk info for the root volume -- or, on macOS where the APFS Data
 * volume exists, that volume instead (#3217), since that is where
 * user/application data actually lives and `/` alone understates real
 * disk usage (see {@link MACOS_DATA_VOLUME}).
 * @param {object} [options]
 * @param {string} [options.platform] - Defaults to `process.platform`; injectable for deterministic tests.
 * @param {(path: string) => boolean} [options.existsSync] - Defaults to `fs.existsSync`; injectable for tests.
 * @param {Function} [options.execFn] - Defaults to `execSync`; injectable for tests.
 * @returns {{ total: number, used: number, free: number, percent: number }}
 */
function getDiskInfo(options = {}) {
  const platform = options.platform || process.platform;
  const existsSync = options.existsSync || fs.existsSync;
  const execFn = options.execFn || execSync;
  try {
    const target = platform === 'darwin' && existsSync(MACOS_DATA_VOLUME) ? MACOS_DATA_VOLUME : '/';
    const output = execFn(`df -k ${target} | tail -1`, { timeout: 2000, encoding: 'utf8' });
    return _parseDfOutput(output, { platform });
  } catch (err) {
    log.warn('Failed to get disk info', { error: err.message });
    return { total: 0, used: 0, free: 0, percent: 0 };
  }
}

/**
 * Parse the output of `df -k` for a single filesystem line.
 * @param {string} line - A line from df -k output
 * @param {object} [options]
 * @param {string} [options.platform] - When `'darwin'`, applies the shared-
 *   APFS-container correction below. Omitted/other platforms keep the
 *   one-volume `used` column exactly as before #3217.
 * @returns {{ total: number, used: number, free: number, percent: number }}
 */
function _parseDfOutput(line, options = {}) {
  // df -k output: Filesystem 1024-blocks Used Available Capacity ...
  const parts = line.trim().split(/\s+/);
  // On macOS: Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted
  // On Linux: Filesystem 1K-blocks Used Available Use% Mounted
  // We need columns 1 (total), 2 (used), 3 (available)
  const total = parseInt(parts[1], 10) * 1024 || 0;
  const rawUsed = parseInt(parts[2], 10) * 1024 || 0;
  const free = parseInt(parts[3], 10) * 1024 || 0;

  // #3217: on macOS, several APFS volumes (Data, Preboot, VM, Recovery, ...)
  // share one container's total/free block counts, so the ONE volume `df`
  // was asked about reports only its own slice as "Used" -- which can be
  // far smaller than how full the shared container actually is. The gap
  // between `total - free` (every byte the container itself has given out)
  // and this one volume's own `rawUsed` is every OTHER volume's share;
  // when that gap exists, `total - free` is the real used figure, keeping
  // `total === used + free` true instead of the stale one-volume number.
  const used = options.platform === 'darwin' && total > free && (total - free) > rawUsed
    ? total - free
    : rawUsed;
  const percent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;

  return { total, used, free, percent };
}

module.exports = {
  getStats,
  getCpuInfo,
  getMemoryInfo,
  getDiskInfo,
  formatUptime,
  _parseDfOutput,
  _calculateCpuUsage,
  _parseVmStat,
  MACOS_DATA_VOLUME
};

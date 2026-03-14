'use strict';

const os = require('node:os');
const { execSync } = require('node:child_process');
const { createLogger } = require('./logger');

const log = createLogger('system');

/**
 * Get system resource stats.
 * @returns {{ cpu: object, memory: object, disk: object, uptime: number, nodeVersion: string, platform: string, arch: string }}
 */
function getStats() {
  return {
    cpu: getCpuInfo(),
    memory: getMemoryInfo(),
    disk: getDiskInfo(),
    uptime: os.uptime(),
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
 * Get memory info.
 * @returns {{ total: number, used: number, free: number, percent: number }}
 */
function getMemoryInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const percent = Math.round((used / total) * 1000) / 10;

  return { total, used, free, percent };
}

/**
 * Get disk info for the root volume.
 * Uses os.cpus() trick — disk stats require a shell call.
 * @returns {{ total: number, used: number, free: number, percent: number }}
 */
function getDiskInfo() {
  try {
    const output = execSync("df -k / | tail -1", { timeout: 2000, encoding: 'utf8' });
    return _parseDfOutput(output);
  } catch (err) {
    log.warn('Failed to get disk info', { error: err.message });
    return { total: 0, used: 0, free: 0, percent: 0 };
  }
}

/**
 * Parse the output of `df -k` for a single filesystem line.
 * @param {string} line - A line from df -k output
 * @returns {{ total: number, used: number, free: number, percent: number }}
 */
function _parseDfOutput(line) {
  // df -k output: Filesystem 1024-blocks Used Available Capacity ...
  const parts = line.trim().split(/\s+/);
  // On macOS: Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted
  // On Linux: Filesystem 1K-blocks Used Available Use% Mounted
  // We need columns 1 (total), 2 (used), 3 (available)
  const total = parseInt(parts[1], 10) * 1024 || 0;
  const used = parseInt(parts[2], 10) * 1024 || 0;
  const free = parseInt(parts[3], 10) * 1024 || 0;
  const percent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;

  return { total, used, free, percent };
}

module.exports = {
  getStats,
  getCpuInfo,
  getMemoryInfo,
  getDiskInfo,
  _parseDfOutput,
  _calculateCpuUsage
};

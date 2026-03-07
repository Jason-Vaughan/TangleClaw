'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Import the module — system.js uses execSync internally
// These tests verify the output shape, not the exact values
const system = require('../lib/system');

describe('system.getStats', () => {
  it('returns object with cpu, memory, disk, uptime', () => {
    const stats = system.getStats();
    assert.ok(stats.cpu, 'should have cpu');
    assert.ok(stats.memory, 'should have memory');
    assert.ok(stats.disk, 'should have disk');
    assert.ok(stats.uptime !== undefined, 'should have uptime');
  });

  it('cpu has load1, load5, load15 as numbers', () => {
    const { cpu } = system.getStats();
    assert.equal(typeof cpu.load1, 'number');
    assert.equal(typeof cpu.load5, 'number');
    assert.equal(typeof cpu.load15, 'number');
  });

  it('memory has totalGB, usedGB, pct as numbers', () => {
    const { memory } = system.getStats();
    assert.equal(typeof memory.totalGB, 'number');
    assert.equal(typeof memory.usedGB, 'number');
    assert.equal(typeof memory.pct, 'number');
    assert.ok(memory.totalGB > 0, 'total memory should be positive');
    assert.ok(memory.pct >= 0 && memory.pct <= 100, 'memory pct should be 0-100');
  });

  it('disk has total, used, available, pct', () => {
    const { disk } = system.getStats();
    assert.ok(disk.total);
    assert.ok(disk.used);
    assert.ok(disk.available);
    assert.equal(typeof disk.pct, 'number');
  });

  it('uptime is a string', () => {
    const { uptime } = system.getStats();
    assert.equal(typeof uptime, 'string');
    assert.ok(uptime !== '?', 'uptime should resolve to a value');
  });

  it('returns cached result on rapid calls', () => {
    const first = system.getStats();
    const second = system.getStats();
    // Same reference means cache hit
    assert.equal(first, second);
  });
});

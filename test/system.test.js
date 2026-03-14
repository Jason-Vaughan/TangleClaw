'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const system = require('../lib/system');

describe('system', () => {
  describe('getStats', () => {
    it('should return all expected fields', () => {
      const stats = system.getStats();
      assert.ok(stats.cpu);
      assert.ok(stats.memory);
      assert.ok(stats.disk);
      assert.ok(typeof stats.uptime === 'number');
      assert.ok(typeof stats.nodeVersion === 'string');
      assert.ok(typeof stats.platform === 'string');
      assert.ok(typeof stats.arch === 'string');
    });
  });

  describe('getCpuInfo', () => {
    it('should return cpu model, cores, and usage', () => {
      const cpu = system.getCpuInfo();
      assert.ok(typeof cpu.model === 'string');
      assert.ok(typeof cpu.cores === 'number');
      assert.ok(cpu.cores > 0);
      assert.ok(typeof cpu.usage === 'number');
      assert.ok(cpu.usage >= 0 && cpu.usage <= 100);
    });
  });

  describe('getMemoryInfo', () => {
    it('should return memory stats', () => {
      const mem = system.getMemoryInfo();
      assert.ok(typeof mem.total === 'number');
      assert.ok(mem.total > 0);
      assert.ok(typeof mem.used === 'number');
      assert.ok(typeof mem.free === 'number');
      assert.ok(typeof mem.percent === 'number');
      assert.ok(mem.percent >= 0 && mem.percent <= 100);
      assert.equal(mem.total, mem.used + mem.free);
    });
  });

  describe('getDiskInfo', () => {
    it('should return disk stats', () => {
      const disk = system.getDiskInfo();
      assert.ok(typeof disk.total === 'number');
      assert.ok(typeof disk.used === 'number');
      assert.ok(typeof disk.free === 'number');
      assert.ok(typeof disk.percent === 'number');
    });

    it('should have non-zero total on a real system', () => {
      const disk = system.getDiskInfo();
      assert.ok(disk.total > 0);
    });
  });

  describe('_parseDfOutput', () => {
    it('should parse macOS df -k output', () => {
      const line = '/dev/disk3s1s1  965595304 452891112 503893600    48%  4935513 5038936000    0%   /';
      const result = system._parseDfOutput(line);
      assert.equal(result.total, 965595304 * 1024);
      assert.equal(result.used, 452891112 * 1024);
      assert.equal(result.free, 503893600 * 1024);
      assert.ok(result.percent > 0);
    });

    it('should handle empty line', () => {
      const result = system._parseDfOutput('');
      assert.equal(result.total, 0);
      assert.equal(result.used, 0);
      assert.equal(result.free, 0);
      assert.equal(result.percent, 0);
    });
  });

  describe('_calculateCpuUsage', () => {
    it('should calculate usage percentage', () => {
      const cpus = [
        { times: { user: 80, nice: 0, sys: 10, idle: 10, irq: 0 } },
        { times: { user: 60, nice: 0, sys: 20, idle: 20, irq: 0 } }
      ];
      const usage = system._calculateCpuUsage(cpus);
      // Total idle: 30, total tick: 200, idle%: 15%, usage: 85%
      assert.equal(usage, 85);
    });

    it('should return 0 for empty array', () => {
      assert.equal(system._calculateCpuUsage([]), 0);
    });

    it('should handle 100% idle', () => {
      const cpus = [
        { times: { user: 0, nice: 0, sys: 0, idle: 100, irq: 0 } }
      ];
      assert.equal(system._calculateCpuUsage(cpus), 0);
    });
  });
});

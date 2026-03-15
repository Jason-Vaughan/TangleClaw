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

  describe('formatUptime', () => {
    it('should format days and hours', () => {
      assert.equal(system.formatUptime(3 * 86400 + 2 * 3600), '3d 2h');
    });

    it('should format hours and minutes', () => {
      assert.equal(system.formatUptime(5 * 3600 + 30 * 60), '5h 30m');
    });

    it('should format minutes only', () => {
      assert.equal(system.formatUptime(12 * 60), '12m');
    });

    it('should show 0m for zero seconds', () => {
      assert.equal(system.formatUptime(0), '0m');
    });

    it('should return -- for non-number', () => {
      assert.equal(system.formatUptime(null), '--');
      assert.equal(system.formatUptime(undefined), '--');
      assert.equal(system.formatUptime('abc'), '--');
    });

    it('should show 1d 0h for exactly one day', () => {
      assert.equal(system.formatUptime(86400), '1d 0h');
    });
  });

  describe('_parseVmStat', () => {
    it('should parse vm_stat output into byte values', () => {
      const vmStatOutput = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12345.
Pages active:                            100000.
Pages inactive:                           50000.
Pages speculative:                         1000.
Pages throttled:                              0.
Pages wired down:                         80000.
Pages purgeable:                           5000.
"Translation faults":                  99999999.
Pages copy-on-write:                    1234567.
Pages zero filled:                     12345678.
Pages reactivated:                       123456.
Pages purged:                             12345.
File-backed pages:                        60000.
Anonymous pages:                          90000.
Pages stored in compressor:              200000.
Pages occupied by compressor:             40000.
Decompressions:                          123456.
Compressions:                            234567.
Pageins:                                 345678.
Pageouts:                                    12.
Swapins:                                      0.
Swapouts:                                     0.`;

      const result = system._parseVmStat(vmStatOutput, 16384);
      assert.equal(result.active, 100000 * 16384);
      assert.equal(result.wired, 80000 * 16384);
      assert.equal(result.compressed, 40000 * 16384);
      assert.equal(result.free, 12345 * 16384);
    });

    it('should return zeroes for empty output', () => {
      const result = system._parseVmStat('', 4096);
      assert.equal(result.active, 0);
      assert.equal(result.wired, 0);
      assert.equal(result.compressed, 0);
      assert.equal(result.free, 0);
    });
  });

  describe('getStats uptimeFormatted', () => {
    it('should include uptimeFormatted field', () => {
      const stats = system.getStats();
      assert.ok(typeof stats.uptimeFormatted === 'string');
      assert.notEqual(stats.uptimeFormatted, '--');
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

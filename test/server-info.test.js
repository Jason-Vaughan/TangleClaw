'use strict';

// Tests for lib/server-info.js (#199 — stale-server detection).
// Covers: capture/snapshot semantics, no-git fallback, dirty-vs-clean
// transitions, commit-ahead counting, defensive shapes.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const serverInfo = require('../lib/server-info');

describe('lib/server-info (#199 stale-server detection)', () => {
  let origInternal;

  beforeEach(() => {
    origInternal = { ...serverInfo._internal };
    serverInfo.__unsafeResetForTest();
  });

  function restoreInternal() {
    Object.assign(serverInfo._internal, origInternal);
  }

  describe('captureStartup', () => {
    it('captures startup SHA and timestamp on first call', () => {
      serverInfo._internal.execSync = () => 'abc123\n';
      try {
        const result = serverInfo.captureStartup();
        assert.equal(result.startupSha, 'abc123');
        assert.match(result.startedAt, /^\d{4}-\d{2}-\d{2}T/, 'ISO timestamp');
      } finally {
        restoreInternal();
      }
    });

    it('is idempotent — subsequent calls return the same captured state', () => {
      let callCount = 0;
      serverInfo._internal.execSync = () => {
        callCount++;
        return `sha-${callCount}\n`;
      };
      try {
        const first = serverInfo.captureStartup();
        const second = serverInfo.captureStartup();
        assert.equal(first.startupSha, 'sha-1');
        assert.equal(second.startupSha, 'sha-1', 'second call must not re-detect');
        assert.equal(second.startedAt, first.startedAt);
      } finally {
        restoreInternal();
      }
    });

    it('handles git unavailable — startupSha is null but startedAt is still set', () => {
      serverInfo._internal.execSync = () => { throw new Error('git not found'); };
      try {
        const result = serverInfo.captureStartup();
        assert.equal(result.startupSha, null);
        assert.match(result.startedAt, /^\d{4}-\d{2}-\d{2}T/,
          'timestamp still captures even when git fails — uptime stays meaningful');
      } finally {
        restoreInternal();
      }
    });

    it('treats empty git output as null SHA (defensive)', () => {
      serverInfo._internal.execSync = () => '   \n';
      try {
        const result = serverInfo.captureStartup();
        assert.equal(result.startupSha, null);
      } finally {
        restoreInternal();
      }
    });
  });

  describe('getServerInfo — clean (in-sync) state', () => {
    it('isStale=false when startup SHA matches current disk SHA', () => {
      serverInfo._internal.execSync = () => 'same-sha\n';
      try {
        serverInfo.captureStartup();
        const info = serverInfo.getServerInfo();
        assert.equal(info.startupSha, 'same-sha');
        assert.equal(info.currentDiskSha, 'same-sha');
        assert.equal(info.isStale, false);
        assert.equal(info.commitsAhead, 0);
      } finally {
        restoreInternal();
      }
    });

    it('isStale=false when both SHAs are null (no-git fallback)', () => {
      serverInfo._internal.execSync = () => { throw new Error('not a git repo'); };
      try {
        serverInfo.captureStartup();
        const info = serverInfo.getServerInfo();
        assert.equal(info.startupSha, null);
        assert.equal(info.currentDiskSha, null);
        assert.equal(info.isStale, false,
          'no-git installs must never surface a stale banner — opt-in via git presence');
        assert.equal(info.commitsAhead, 0);
      } finally {
        restoreInternal();
      }
    });

    it('uptimeSeconds is a non-negative integer when captureStartup was called', () => {
      serverInfo._internal.execSync = () => 'abc\n';
      try {
        serverInfo.captureStartup();
        const info = serverInfo.getServerInfo();
        assert.equal(typeof info.uptimeSeconds, 'number');
        assert.ok(info.uptimeSeconds >= 0, 'uptime cannot be negative');
        assert.ok(Number.isInteger(info.uptimeSeconds), 'uptime is whole seconds');
      } finally {
        restoreInternal();
      }
    });
  });

  describe('getServerInfo — stale state (disk advanced)', () => {
    it('isStale=true when current disk SHA differs from startup', () => {
      let call = 0;
      serverInfo._internal.execSync = (cmd) => {
        call++;
        if (cmd.includes('rev-list')) return '3\n';
        // First call → startup, second → current disk
        return call <= 1 ? 'startup-sha\n' : 'disk-sha\n';
      };
      try {
        serverInfo.captureStartup();
        // Reset call counter for the snapshot reads
        const info = serverInfo.getServerInfo();
        assert.equal(info.startupSha, 'startup-sha');
        assert.notEqual(info.currentDiskSha, 'startup-sha');
        assert.equal(info.isStale, true);
        assert.ok(info.commitsAhead > 0, 'commitsAhead should reflect rev-list count');
      } finally {
        restoreInternal();
      }
    });

    it('commitsAhead reflects the rev-list count', () => {
      let phase = 'startup';
      serverInfo._internal.execSync = (cmd) => {
        if (phase === 'startup') {
          phase = 'after-startup';
          return 'old\n';
        }
        if (cmd.startsWith('git rev-parse')) return 'new\n';
        if (cmd.includes('rev-list')) return '7\n';
        return '';
      };
      try {
        serverInfo.captureStartup();
        const info = serverInfo.getServerInfo();
        assert.equal(info.commitsAhead, 7);
      } finally {
        restoreInternal();
      }
    });

    it('commitsAhead falls back to 0 when rev-list fails (defensive)', () => {
      let phase = 'startup';
      serverInfo._internal.execSync = (cmd) => {
        if (phase === 'startup') {
          phase = 'after-startup';
          return 'old\n';
        }
        if (cmd.startsWith('git rev-parse')) return 'new\n';
        if (cmd.includes('rev-list')) throw new Error('exec failed');
        return '';
      };
      try {
        serverInfo.captureStartup();
        const info = serverInfo.getServerInfo();
        // Stale is still true (SHAs differ) but commit count degrades gracefully.
        assert.equal(info.isStale, true);
        assert.equal(info.commitsAhead, 0);
      } finally {
        restoreInternal();
      }
    });

    it('commitsAhead is 0 when rev-list output is non-numeric (defensive)', () => {
      let phase = 'startup';
      serverInfo._internal.execSync = (cmd) => {
        if (phase === 'startup') {
          phase = 'after-startup';
          return 'old\n';
        }
        if (cmd.startsWith('git rev-parse')) return 'new\n';
        if (cmd.includes('rev-list')) return 'garbage\n';
        return '';
      };
      try {
        serverInfo.captureStartup();
        const info = serverInfo.getServerInfo();
        assert.equal(info.commitsAhead, 0);
      } finally {
        restoreInternal();
      }
    });
  });

  describe('getServerInfo — degraded states', () => {
    it('returns null fields when captureStartup was never called', () => {
      // No captureStartup() — fresh after _resetForTest.
      serverInfo._internal.execSync = () => 'whatever\n';
      try {
        const info = serverInfo.getServerInfo();
        assert.equal(info.startupSha, null);
        assert.equal(info.startedAt, null);
        assert.equal(info.uptimeSeconds, null);
        assert.equal(info.isStale, false, 'cannot be stale without a startup reference');
      } finally {
        restoreInternal();
      }
    });

    it('isStale=null (unknown) when startup was captured but current disk read fails (#1118)', () => {
      let phase = 'startup';
      serverInfo._internal.execSync = (cmd) => {
        if (phase === 'startup') {
          phase = 'after-startup';
          return 'startup-sha\n';
        }
        throw new Error('git removed mid-runtime');
      };
      try {
        serverInfo.captureStartup();
        const info = serverInfo.getServerInfo();
        assert.equal(info.startupSha, 'startup-sha');
        assert.equal(info.currentDiskSha, null);
        assert.equal(info.isStale, null,
          'a failed probe is unknown, not a fact — neither stale nor confidently fresh');
        assert.match(String(info.staleUnknownReason), /current git SHA read failed/);
      } finally {
        restoreInternal();
      }
    });
  });

  describe('detached HEAD + mid-runtime degraded modes', () => {
    it('detached HEAD: SHA is still detectable and stale state surfaces correctly', () => {
      // Detached HEAD returns a real SHA from `git rev-parse HEAD` — the
      // commit just isn't on a branch. The detection logic doesn't care.
      let phase = 'startup';
      serverInfo._internal.execSync = (cmd) => {
        if (phase === 'startup') {
          phase = 'after-startup';
          return 'detached-startup-sha\n';
        }
        if (cmd.startsWith('git rev-parse')) return 'detached-disk-sha\n';
        if (cmd.includes('rev-list')) return '2\n';
        return '';
      };
      try {
        serverInfo.captureStartup();
        const info = serverInfo.getServerInfo();
        assert.equal(info.startupSha, 'detached-startup-sha');
        assert.equal(info.currentDiskSha, 'detached-disk-sha');
        assert.equal(info.isStale, true);
      } finally {
        restoreInternal();
      }
    });

    it('exec timeout mid-runtime falls through the same catch as ENOENT — no crash', () => {
      let phase = 'startup';
      serverInfo._internal.execSync = (cmd) => {
        if (phase === 'startup') {
          phase = 'after-startup';
          return 'old-sha\n';
        }
        const err = new Error('timeout');
        err.code = 'ETIMEDOUT';
        throw err;
      };
      try {
        serverInfo.captureStartup();
        // Should not throw — both currentDiskSha lookups (one for SHA, one
        // for rev-list) degrade to null/0.
        const info = serverInfo.getServerInfo();
        assert.equal(info.startupSha, 'old-sha');
        assert.equal(info.currentDiskSha, null);
        assert.equal(info.isStale, null,
          'a timed-out probe is unknown, not a fact (#1118) — never reported as stale, never as fresh');
        assert.equal(info.commitsAhead, 0);
      } finally {
        restoreInternal();
      }
    });
  });

  describe('_countCommitsAhead — pure helper', () => {
    it('returns 0 when either SHA is null/empty', () => {
      assert.equal(serverInfo._countCommitsAhead(null, 'abc'), 0);
      assert.equal(serverInfo._countCommitsAhead('abc', null), 0);
      assert.equal(serverInfo._countCommitsAhead('', 'abc'), 0);
      assert.equal(serverInfo._countCommitsAhead(null, null), 0);
    });

    it('returns 0 when SHAs match (no advancement)', () => {
      // Doesn't even call execSync — early-return short-circuits.
      let called = false;
      serverInfo._internal.execSync = () => { called = true; return '5\n'; };
      try {
        assert.equal(serverInfo._countCommitsAhead('abc', 'abc'), 0);
        assert.equal(called, false, 'identical SHAs must not shell out');
      } finally {
        restoreInternal();
      }
    });
  });

  describe('detectRestartMechanism (#235)', () => {
    it("returns 'launchctl' on macOS when the per-user plist exists", () => {
      serverInfo._internal.platform = () => 'darwin';
      serverInfo._internal.existsSync = (p) => p === serverInfo.MACOS_PLIST_PATH;
      try {
        assert.equal(serverInfo.detectRestartMechanism(), 'launchctl');
      } finally {
        restoreInternal();
      }
    });

    it('returns null on macOS when the plist is absent (e.g. node started manually)', () => {
      serverInfo._internal.platform = () => 'darwin';
      serverInfo._internal.existsSync = () => false;
      try {
        assert.equal(serverInfo.detectRestartMechanism(), null);
      } finally {
        restoreInternal();
      }
    });

    it('returns null on Linux today (deliberate follow-up, not a regression)', () => {
      serverInfo._internal.platform = () => 'linux';
      serverInfo._internal.existsSync = () => true; // even with a stray file, Linux returns null
      try {
        assert.equal(serverInfo.detectRestartMechanism(), null);
      } finally {
        restoreInternal();
      }
    });

    it('returns null on unknown platforms (Windows, etc.)', () => {
      serverInfo._internal.platform = () => 'win32';
      serverInfo._internal.existsSync = () => true;
      try {
        assert.equal(serverInfo.detectRestartMechanism(), null);
      } finally {
        restoreInternal();
      }
    });

    it('caches the detection result — second call does not re-stat the plist', () => {
      // The plist file lives at a fixed location chosen at install
      // time; re-detecting every poll wastes filesystem calls. Pin
      // the caching invariant so a future refactor cannot quietly
      // drop it.
      let existsCalls = 0;
      serverInfo._internal.platform = () => 'darwin';
      serverInfo._internal.existsSync = () => { existsCalls++; return true; };
      try {
        assert.equal(serverInfo.detectRestartMechanism(), 'launchctl');
        assert.equal(serverInfo.detectRestartMechanism(), 'launchctl');
        assert.equal(serverInfo.detectRestartMechanism(), 'launchctl');
        assert.equal(existsCalls, 1, 'plist existence must be probed at most once per process');
      } finally {
        restoreInternal();
      }
    });
  });

  describe('buildRestartCommand (#235)', () => {
    it("emits the correct launchctl kickstart command for 'launchctl'", () => {
      const cmd = serverInfo.buildRestartCommand('launchctl');
      // gui/$(id -u)/com.tangleclaw.server — the per-user GUI domain.
      // Pin the exact shape so a future refactor (e.g. switching to
      // `launchctl bootout` followed by `bootstrap`) is caught.
      assert.equal(cmd, 'launchctl kickstart -k gui/$(id -u)/com.tangleclaw.server');
    });

    it('returns null for an unknown mechanism (defensive — should never reach the exec path)', () => {
      assert.equal(serverInfo.buildRestartCommand('systemctl'), null);
      assert.equal(serverInfo.buildRestartCommand('unknown'), null);
      assert.equal(serverInfo.buildRestartCommand(null), null);
      assert.equal(serverInfo.buildRestartCommand(undefined), null);
    });
  });

  describe('getServerInfo — restartMechanism surface (#235)', () => {
    it('includes restartMechanism in the snapshot', () => {
      serverInfo._internal.execSync = () => 'sha-1\n';
      serverInfo._internal.platform = () => 'darwin';
      serverInfo._internal.existsSync = (p) => p === serverInfo.MACOS_PLIST_PATH;
      try {
        serverInfo.captureStartup();
        const info = serverInfo.getServerInfo();
        assert.equal(info.restartMechanism, 'launchctl');
      } finally {
        restoreInternal();
      }
    });

    it("restartMechanism is null when no mechanism is available — frontend hides the button on this signal", () => {
      serverInfo._internal.execSync = () => 'sha-1\n';
      serverInfo._internal.platform = () => 'linux';
      serverInfo._internal.existsSync = () => false;
      try {
        serverInfo.captureStartup();
        const info = serverInfo.getServerInfo();
        assert.equal(info.restartMechanism, null);
      } finally {
        restoreInternal();
      }
    });
  });
});

describe('#1118 — boot-time SHA capture failure must not silently disable detection', () => {
  let origInternal;

  beforeEach(() => {
    origInternal = { ...serverInfo._internal };
    serverInfo.__unsafeResetForTest();
  });

  function restore() {
    Object.assign(serverInfo._internal, origInternal);
  }

  it('a boot probe failure with a working later probe recovers a late baseline — never a permanently latched null', () => {
    let boot = true;
    serverInfo._internal.execSync = (cmd) => {
      if (boot) { boot = false; const e = new Error('timeout'); e.code = 'ETIMEDOUT'; throw e; }
      if (String(cmd).includes('rev-list')) return '1\n';
      return 'recovered-sha\n';
    };
    try {
      serverInfo.captureStartup();
      const info = serverInfo.getServerInfo();
      assert.equal(info.startupSha, 'recovered-sha', 'the first successful probe becomes the baseline');
      assert.equal(info.shaBaselineSource, 'late', 'a recovered baseline must say it is late, not pretend it is from boot');
      assert.equal(info.isStale, false);
    } finally {
      restore();
    }
  });

  it('after late recovery, a subsequent disk move IS detected — detection stops being dead', () => {
    let phase = 'boot';
    serverInfo._internal.execSync = (cmd) => {
      if (phase === 'boot') { phase = 'recover'; throw new Error('transient exec failure'); }
      if (String(cmd).includes('rev-list')) return '2\n';
      if (phase === 'recover') { phase = 'moved'; return 'baseline-sha\n'; }
      return 'moved-sha\n';
    };
    try {
      serverInfo.captureStartup();
      const first = serverInfo.getServerInfo();
      assert.equal(first.isStale, false);
      const second = serverInfo.getServerInfo();
      assert.equal(second.isStale, true, 'the recovered baseline must catch later merges');
      assert.equal(second.commitsAhead, 2);
    } finally {
      restore();
    }
  });

  it('boot failure with probes still failing reports isStale=null with a reason — never a confident false', () => {
    serverInfo._internal.execSync = () => { const e = new Error('timeout'); e.code = 'ETIMEDOUT'; throw e; };
    try {
      serverInfo.captureStartup();
      const info = serverInfo.getServerInfo();
      assert.equal(info.isStale, null, 'the live-install #1118 state: unknown rendered as unknown, not as all-clear');
      assert.match(String(info.staleUnknownReason), /failed at boot/);
      assert.equal(info.shaBaselineSource, null);
    } finally {
      restore();
    }
  });

  it('version signal still outranks SHA-unknown: a release on disk reports stale even while git fails', () => {
    serverInfo._internal.execSync = () => { throw new Error('exec failure'); };
    let v = '5.14.0';
    serverInfo._internal.readFileSync = () => JSON.stringify({ version: v });
    try {
      serverInfo.captureStartup();
      v = '5.14.1';
      const info = serverInfo.getServerInfo();
      assert.equal(info.isStale, true, 'a positive signal wins over an unknown one');
    } finally {
      restore();
    }
  });

  it('the designed no-git fallback stays a quiet false — not unknown', () => {
    serverInfo._internal.execSync = () => { throw new Error('fatal: not a git repository (or any of the parent directories): .git'); };
    try {
      serverInfo.captureStartup();
      const info = serverInfo.getServerInfo();
      assert.equal(info.isStale, false, 'tarball installs opted out by design must not warn forever');
      assert.equal(info.staleUnknownReason, null);
    } finally {
      restore();
    }
  });

  it('_classifyGitError separates the designed fallback from real failures', () => {
    const enoent = new Error('spawn git ENOENT'); enoent.code = 'ENOENT';
    assert.equal(serverInfo._classifyGitError(enoent), 'no-git');
    assert.equal(serverInfo._classifyGitError(new Error('fatal: not a git repository')), 'no-git');
    const timeout = new Error('timed out'); timeout.code = 'ETIMEDOUT';
    assert.equal(serverInfo._classifyGitError(timeout), 'failed');
    assert.equal(serverInfo._classifyGitError(new Error('anything else')), 'failed');
    const stderrCase = new Error('command failed'); stderrCase.stderr = 'fatal: not a git repository';
    assert.equal(serverInfo._classifyGitError(stderrCase), 'no-git');
  });
});

describe('version-based staleness (independent of git)', () => {
  let origInternal;

  beforeEach(() => {
    origInternal = { ...serverInfo._internal };
    serverInfo.__unsafeResetForTest();
  });

  function restore() {
    Object.assign(serverInfo._internal, origInternal);
  }

  function stubVersion(v) {
    serverInfo._internal.readFileSync = () => JSON.stringify({ version: v });
  }

  it('reports stale when version.json moved even though git detection fails', () => {
    // The case that matters: a self-update rewrote version.json, the restart
    // did not take, and git is unavailable — so the SHA check cannot fire.
    serverInfo._internal.execSync = () => { throw new Error('git unavailable'); };
    stubVersion('4.32.0');
    try {
      serverInfo.captureStartup();
      stubVersion('4.32.1');
      const info = serverInfo.getServerInfo();
      assert.equal(info.isStale, true, 'disk moved but no banner would show');
      assert.equal(info.runningVersion, '4.32.0');
      assert.equal(info.diskVersion, '4.32.1');
      assert.equal(info.commitsAhead, 0, 'no git means no commit count to claim');
    } finally {
      restore();
    }
  });

  it('is not stale when the version is unchanged and git agrees', () => {
    serverInfo._internal.execSync = () => 'samesha\n';
    stubVersion('4.32.1');
    try {
      serverInfo.captureStartup();
      const info = serverInfo.getServerInfo();
      assert.equal(info.isStale, false);
      assert.equal(info.runningVersion, '4.32.1');
      assert.equal(info.diskVersion, '4.32.1');
    } finally {
      restore();
    }
  });

  it('still reports stale from the SHA check when the version is unchanged', () => {
    // A merge that does not bump the version must keep the original signal.
    let n = 0;
    serverInfo._internal.execSync = (cmd) => {
      if (String(cmd).includes('rev-list')) return '3\n';
      n += 1;
      return n === 1 ? 'oldsha\n' : 'newsha\n';
    };
    stubVersion('4.32.1');
    try {
      serverInfo.captureStartup();
      const info = serverInfo.getServerInfo();
      assert.equal(info.isStale, true);
      assert.equal(info.commitsAhead, 3);
    } finally {
      restore();
    }
  });

  it('reports unknown (not fresh) when git probes fail and the version cannot be read at all (#1118)', () => {
    // 'no git' does not say "not a git repository" — it is a *failure*, not
    // the designed no-git fallback, so with the version signal also blind
    // the honest answer is "cannot tell".
    serverInfo._internal.execSync = () => { throw new Error('no git'); };
    serverInfo._internal.readFileSync = () => { throw new Error('no version.json'); };
    try {
      serverInfo.captureStartup();
      const info = serverInfo.getServerInfo();
      assert.equal(info.isStale, null, 'unknown state must not render as a fact in either direction');
      assert.equal(info.runningVersion, null);
      assert.equal(info.diskVersion, null);
    } finally {
      restore();
    }
  });

  it('tolerates malformed version.json without throwing', () => {
    serverInfo._internal.execSync = () => { throw new Error('no git'); };
    serverInfo._internal.readFileSync = () => '{ not json';
    try {
      serverInfo.captureStartup();
      const info = serverInfo.getServerInfo();
      assert.equal(info.diskVersion, null);
      assert.equal(info.isStale, null,
        'a failed git probe plus an unreadable version is unknown, not fresh (#1118)');
    } finally {
      restore();
    }
  });
});

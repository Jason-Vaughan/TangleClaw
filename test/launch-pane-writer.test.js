'use strict';

/**
 * The shared pane-writer behind `launch-unready.js` and `launch-kickoff.js`
 * (#1669).
 *
 * This module owns no state machine of its own, so its tests are plain
 * function tests: given these seams, does it capture, assess, inject and log
 * the way both callers' own test suites prove they rely on.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const paneWriter = require('../lib/launch-pane-writer');

describe('launch-pane-writer (#1669)', () => {
  describe('assessPaneIdle', () => {
    it('captures the pane and assesses it idle', () => {
      const verdict = paneWriter.assessPaneIdle('tc-session', {
        capturePane: () => ({ lines: ['> '] }),
        cursorInfo: () => ({ row: 0, col: 2 }),
        assessIdle: ({ lines, profile, cursor, prevDigest, idleTicks }) => {
          assert.deepEqual(lines, ['> ']);
          assert.equal(profile, 'a-profile');
          assert.deepEqual(cursor, { row: 0, col: 2 });
          assert.equal(prevDigest, 'd0');
          assert.equal(idleTicks, 2);
          return { idle: true, reason: 'at-prompt', digest: 'd1', idleTicks: 3 };
        },
        profile: 'a-profile',
        lineCount: 15,
        prevDigest: 'd0',
        idleTicks: 2
      });
      assert.deepEqual(verdict, { idle: true, reason: 'at-prompt', digest: 'd1', idleTicks: 3 });
    });

    it('defaults idleTicks to 0 when the caller has no prior observation', () => {
      let seen;
      paneWriter.assessPaneIdle('tc-session', {
        capturePane: () => ({ lines: [] }),
        cursorInfo: () => null,
        assessIdle: (opts) => { seen = opts; return { idle: false, reason: 'x', digest: 'd', idleTicks: 0 }; },
        profile: 'p',
        lineCount: 15
      });
      assert.equal(seen.idleTicks, 0);
    });

    it('treats an empty capture as no lines, not a throw', () => {
      let seen;
      paneWriter.assessPaneIdle('tc-session', {
        capturePane: () => null,
        cursorInfo: () => null,
        assessIdle: (opts) => { seen = opts; return { idle: false, reason: 'x', digest: 'd', idleTicks: 0 }; },
        profile: 'p',
        lineCount: 15
      });
      assert.deepEqual(seen.lines, []);
    });

    it('falls back to a null cursor, best-effort, when the cursor probe throws', () => {
      let seen;
      let caught;
      const verdict = paneWriter.assessPaneIdle('tc-session', {
        capturePane: () => ({ lines: ['> '] }),
        cursorInfo: () => { throw new Error('cursor unavailable'); },
        assessIdle: (opts) => { seen = opts; return { idle: true, reason: 'at-prompt', digest: 'd', idleTicks: 1 }; },
        profile: 'p',
        lineCount: 15,
        onCursorError: (err) => { caught = err; }
      });
      assert.equal(seen.cursor, null);
      assert.equal(verdict.idle, true);
      assert.equal(caught.message, 'cursor unavailable');
    });

    it('never calls onCursorError when no cursor probe fails', () => {
      let called = false;
      paneWriter.assessPaneIdle('tc-session', {
        capturePane: () => ({ lines: ['> '] }),
        cursorInfo: () => ({ row: 0, col: 0 }),
        assessIdle: () => ({ idle: true, reason: 'at-prompt', digest: 'd', idleTicks: 1 }),
        profile: 'p',
        lineCount: 15,
        onCursorError: () => { called = true; }
      });
      assert.equal(called, false);
    });

    it('does not require onCursorError: a cursor failure with none given is silently best-effort', () => {
      assert.doesNotThrow(() => paneWriter.assessPaneIdle('tc-session', {
        capturePane: () => ({ lines: ['> '] }),
        cursorInfo: () => { throw new Error('boom'); },
        assessIdle: () => ({ idle: true, reason: 'at-prompt', digest: 'd', idleTicks: 1 }),
        profile: 'p',
        lineCount: 15
      }));
    });

    it('propagates a pane-capture failure to the caller rather than swallowing it', () => {
      assert.throws(() => paneWriter.assessPaneIdle('tc-session', {
        capturePane: () => { throw new Error('pane vanished'); },
        cursorInfo: () => null,
        assessIdle: () => { throw new Error('must not be reached'); },
        profile: 'p',
        lineCount: 15
      }), /pane vanished/);
    });
  });

  describe('injectLine', () => {
    it('classifies a successful send as sent', () => {
      const { code, sent } = paneWriter.injectLine(
        () => ({ ok: true, error: null }), 'proj', 'one line', { sessionId: 1 }
      );
      assert.equal(code, 'sent');
      assert.equal(sent.ok, true);
    });

    it('classifies a control refusal as control-held, not inject-failed', () => {
      const refusal = { status: 423, code: 'CONTROL_HELD', message: 'held', details: {} };
      const { code, sent } = paneWriter.injectLine(
        () => ({ ok: false, error: 'CONTROL_HELD: held', controlRefusal: refusal }), 'proj', 'one line', {}
      );
      assert.equal(code, 'control-held');
      assert.equal(sent.controlRefusal, refusal);
    });

    it('classifies an ordinary failed send as inject-failed', () => {
      const { code, sent } = paneWriter.injectLine(
        () => ({ ok: false, error: 'tmux session not found' }), 'proj', 'one line', {}
      );
      assert.equal(code, 'inject-failed');
      assert.equal(sent.error, 'tmux session not found');
    });

    it('passes the project name, line and options through unchanged', () => {
      let seen;
      paneWriter.injectLine((projectName, line, options) => {
        seen = { projectName, line, options };
        return { ok: true, error: null };
      }, 'my-project', 'the line', { sessionId: 7, launchSend: true });
      assert.deepEqual(seen, { projectName: 'my-project', line: 'the line', options: { sessionId: 7, launchSend: true } });
    });
  });

  describe('logActivityBestEffort', () => {
    it('logs the entry and nothing else on success', () => {
      const logged = [];
      let warned = false;
      paneWriter.logActivityBestEffort(
        (entry) => logged.push(entry), { warn: () => { warned = true; } },
        'should not be logged', { eventType: 'launch.nudged', detail: {} }
      );
      assert.deepEqual(logged, [{ eventType: 'launch.nudged', detail: {} }]);
      assert.equal(warned, false);
    });

    it('swallows a logging failure and warns with the entry\'s eventType and the error', () => {
      let warning;
      paneWriter.logActivityBestEffort(
        () => { throw new Error('disk full'); },
        { warn: (message, context) => { warning = { message, context }; } },
        'caller-module: failed to log an activity entry',
        { eventType: 'launch.kickoff', detail: { observed: 'sent' } }
      );
      assert.equal(warning.message, 'caller-module: failed to log an activity entry');
      assert.equal(warning.context.eventType, 'launch.kickoff');
      assert.equal(warning.context.error, 'disk full');
    });

    it('never throws, whatever the activity log does', () => {
      assert.doesNotThrow(() => paneWriter.logActivityBestEffort(
        () => { throw new Error('boom'); }, { warn: () => {} }, 'msg', { eventType: 'x' }
      ));
    });
  });
});

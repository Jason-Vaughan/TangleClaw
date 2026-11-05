'use strict';

/**
 * Session History backfill controller (#2830, #2074 Slice 2).
 *
 * `lib/transcript.js#backfillTranscript` (#2074 Slice 1) is a primitive
 * nobody calls yet: it fills in a missing transcript for a session that was
 * already wrapped without one, but no caller wires it into the Session
 * History read path. This module is that caller, and the one thing it adds
 * beyond a bare pass-through is provenance: which of the two ways a
 * session's transcript ended up captured --
 *
 *   - `'live-pane-capture'`: already present, from the session's own wrap
 *     (`lib/transcript.js#snapshot`, called at wrap time).
 *   - `'native-log-backfill'`: filled in just now, read from the harness's
 *     native on-disk log well after the session wrapped.
 *
 * so the Session History UI (`public/session-history-ui.js`) can badge the
 * two differently rather than show an identical "transcript captured" for
 * both.
 *
 * Wiring this into the actual read route (`server.js`) and the UI's own
 * render call (`public/history-drawer.js`) is tracked as a later slice --
 * neither file is in this one's envelope.
 *
 * @module lib/session-history-backfill
 */

const transcript = require('./transcript');
const continuity = require('./continuity');

/** Seam for tests: the clock a backfill's `backfilledAt` is read from. */
const _internal = {
  now: () => new Date().toISOString()
};

/**
 * Ensure a session has a captured transcript, backfilling it from the
 * harness's native log when nothing is there yet, and report which kind of
 * capture is now present.
 *
 * Idempotent and side-effect-free on a session that already has one: the
 * existing capture is read and reported, never re-scanned or overwritten
 * (the same guarantee `backfillTranscript` itself gives).
 *
 * @param {object} project - Project record (uses `.path`, `.name`)
 * @param {object} session - TC session row (uses `.engineId`, `.startedAt`)
 * @param {string|number} sid - TC session id (the store key)
 * @returns {Promise<{captured: boolean, reason?: string, source?: ('native-log-backfill'|'live-pane-capture'),
 *   engine: string, backfilledAt?: string, capturedAt?: string, bytes?: number, lineCount?: number,
 *   secretsFlagged?: boolean, secretTypes?: string[], scanSkipped?: boolean}>}
 */
async function ensureSessionTranscript(project, session, sid) {
  const engine = transcript._normalizeHarness(session && session.engineId);

  const existing = continuity.readTranscriptMeta(project.path, sid);
  if (existing) {
    return {
      captured: true,
      source: 'live-pane-capture',
      engine,
      capturedAt: existing.capturedAt || null,
      bytes: existing.bytes || 0,
      lineCount: existing.lineCount || 0,
      secretsFlagged: !!existing.secretsFlagged,
      secretTypes: Array.isArray(existing.secretTypes) ? existing.secretTypes : [],
      scanSkipped: !!existing.scanSkipped
    };
  }

  const result = await transcript.backfillTranscript(project, session, sid);
  if (!result.captured) {
    // Honest skip: nothing was there, and nothing could be filled in either
    // (unsupported harness, no matching native log, or -- a benign race --
    // another caller captured it between the read above and this call).
    return { captured: false, reason: result.reason, engine };
  }

  return {
    captured: true,
    source: 'native-log-backfill',
    engine,
    backfilledAt: _internal.now(),
    bytes: result.bytes,
    lineCount: result.lineCount,
    secretsFlagged: result.secretsFlagged,
    secretTypes: result.secretTypes,
    scanSkipped: result.scanSkipped
  };
}

module.exports = { ensureSessionTranscript, _internal };

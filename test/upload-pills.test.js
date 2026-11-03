'use strict';

// #1577 (Architect Ruling A1577): multi-file upload queue state and
// auto-appending Attachment Pills. lib/upload-pills.js is a pure library:
// no filesystem, no real upload, no DOM. Every assertion here drives the
// real exported function.
//
// Also covers public/upload-pills.js's own pure view-model helpers (A1577's
// own required public component, co-located here per the ruling's one
// authorized test file for both). Mirrors test/wrap-drawer.test.js's
// vm-sandbox pattern: DOM is unavailable here, but the helpers are
// intentionally DOM-free so they're testable in pure Node; app.js/session.js
// own the real rendering and event wiring (Slice 2, deliberately deferred).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const up = require('../lib/upload-pills');
const { MAX_UPLOAD_BYTES } = require('../lib/uploads');

const UI_HELPER_PATH = path.join(__dirname, '..', 'public', 'upload-pills.js');
const UI_HELPER_SRC = fs.readFileSync(UI_HELPER_PATH, 'utf8');

/**
 * Build a sandbox with a `window` shim and evaluate public/upload-pills.js
 * into it. Returns the `tcUploadPillsHelpers` namespace attached to window.
 * @returns {object} helpers
 */
function loadUiHelpers() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(UI_HELPER_SRC, sandbox);
  return sandbox.window.tcUploadPillsHelpers;
}

describe('upload-pills: exported vocabulary', () => {
  it('exposes its own state/transition vocabulary and batch bound', () => {
    assert.deepEqual(up.PILL_STATES, ['queued', 'uploading', 'ready', 'failed']);
    assert.deepEqual(up.PILL_TRANSITIONS, { queued: ['uploading', 'failed'], uploading: ['ready', 'failed'], ready: [], failed: ['queued'] });
    assert.equal(up.MAX_FILES_PER_BATCH, 10);
  });
});

describe('upload-pills: enqueueUploads (#1577)', () => {
  it('refuses a non-array existingPills', () => {
    assert.equal(up.enqueueUploads({ existingPills: 'nope', files: [{ filename: 'a', sizeBytes: 1 }] }).code, 'UPLOAD_PILLS_INVALID');
  });

  it('refuses an empty or non-array files', () => {
    assert.equal(up.enqueueUploads({ existingPills: [], files: [] }).code, 'UPLOAD_PILLS_INVALID');
    assert.equal(up.enqueueUploads({ existingPills: [], files: 'nope' }).code, 'UPLOAD_PILLS_INVALID');
  });

  it('refuses a file with no filename or a non-positive sizeBytes', () => {
    assert.equal(up.enqueueUploads({ existingPills: [], files: [{ sizeBytes: 1 }] }).code, 'UPLOAD_PILLS_INVALID');
    assert.equal(up.enqueueUploads({ existingPills: [], files: [{ filename: 'a', sizeBytes: 0 }] }).code, 'UPLOAD_PILLS_INVALID');
  });

  it('queues fresh files as "queued" pills with no remotePath yet', () => {
    const r = up.enqueueUploads({ existingPills: [], files: [{ filename: 'a.png', sizeBytes: 100, mimeType: 'image/png' }] });
    assert.equal(r.ok, true);
    assert.equal(r.result.added.length, 1);
    assert.equal(r.result.added[0].state, 'queued');
    assert.equal(r.result.added[0].remotePath, null);
    assert.equal(r.result.added[0].mimeType, 'image/png');
    assert.equal(r.result.pills.length, 1);
  });

  it('deduplicates an identical attachment (same filename + sizeBytes) already in existingPills', () => {
    const first = up.enqueueUploads({ existingPills: [], files: [{ filename: 'a.png', sizeBytes: 100 }] });
    const second = up.enqueueUploads({ existingPills: first.result.pills, files: [{ filename: 'a.png', sizeBytes: 100 }] });
    assert.equal(second.result.added.length, 0);
    assert.equal(second.result.duplicates.length, 1);
    assert.equal(second.result.pills.length, 1);
  });

  it('deduplicates within the SAME call, not just against existingPills', () => {
    const r = up.enqueueUploads({
      existingPills: [], files: [{ filename: 'a.png', sizeBytes: 100 }, { filename: 'a.png', sizeBytes: 100 }]
    });
    assert.equal(r.result.added.length, 1);
    assert.equal(r.result.duplicates.length, 1);
  });

  it('does NOT dedupe two files with the same name but a different size', () => {
    const r = up.enqueueUploads({
      existingPills: [], files: [{ filename: 'a.png', sizeBytes: 100 }, { filename: 'a.png', sizeBytes: 200 }]
    });
    assert.equal(r.result.added.length, 2);
    assert.equal(r.result.duplicates.length, 0);
  });

  it('rejects a file over the shared MAX_UPLOAD_BYTES size bound, without blocking the rest of the batch', () => {
    const r = up.enqueueUploads({
      existingPills: [],
      files: [{ filename: 'ok.png', sizeBytes: 100 }, { filename: 'huge.bin', sizeBytes: MAX_UPLOAD_BYTES + 1 }]
    });
    assert.equal(r.ok, true);
    assert.equal(r.result.added.length, 1);
    assert.equal(r.result.added[0].filename, 'ok.png');
    assert.equal(r.result.rejected.length, 1);
    assert.equal(r.result.rejected[0].filename, 'huge.bin');
    assert.match(r.result.rejected[0].reason, /size bound/);
  });

  it('a file exactly at MAX_UPLOAD_BYTES is allowed; one byte over is not', () => {
    const atLimit = up.enqueueUploads({ existingPills: [], files: [{ filename: 'edge.bin', sizeBytes: MAX_UPLOAD_BYTES }] });
    assert.equal(atLimit.result.added.length, 1);
    const overLimit = up.enqueueUploads({ existingPills: [], files: [{ filename: 'edge2.bin', sizeBytes: MAX_UPLOAD_BYTES + 1 }] });
    assert.equal(overLimit.result.rejected.length, 1);
  });

  it('rejects files past the per-batch file-count bound, without blocking earlier ones in the same batch', () => {
    const existingPills = Array.from({ length: up.MAX_FILES_PER_BATCH - 1 }, (_, i) => ({
      pillId: `existing-${i}`, filename: `old-${i}.png`, sizeBytes: 10, state: 'ready', remotePath: `/x/old-${i}.png`
    }));
    const r = up.enqueueUploads({
      existingPills, files: [{ filename: 'new-1.png', sizeBytes: 10 }, { filename: 'new-2.png', sizeBytes: 10 }]
    });
    assert.equal(r.result.added.length, 1);
    assert.equal(r.result.added[0].filename, 'new-1.png');
    assert.equal(r.result.rejected.length, 1);
    assert.equal(r.result.rejected[0].filename, 'new-2.png');
    assert.match(r.result.rejected[0].reason, /batch bound/);
  });

  it('every pillId is unique, even for two files queued in the same call', () => {
    const r = up.enqueueUploads({
      existingPills: [], files: [{ filename: 'a.png', sizeBytes: 100 }, { filename: 'b.png', sizeBytes: 200 }]
    });
    const ids = r.result.added.map((p) => p.pillId);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('upload-pills: transitionPill (#1577)', () => {
  const basePill = { pillId: 'p1', filename: 'a.png', sizeBytes: 100, mimeType: null, state: 'queued', remotePath: null };

  it('refuses a pill with no pillId', () => {
    assert.equal(up.transitionPill({ pill: {}, toState: 'uploading' }).code, 'UPLOAD_PILLS_INVALID');
  });

  it('refuses an unrecognized toState', () => {
    assert.equal(up.transitionPill({ pill: basePill, toState: 'bogus' }).code, 'UPLOAD_PILLS_INVALID');
  });

  it('allows queued -> uploading', () => {
    const r = up.transitionPill({ pill: basePill, toState: 'uploading' });
    assert.equal(r.ok, true);
    assert.equal(r.pill.state, 'uploading');
  });

  it('allows uploading -> ready, given a remotePath, and stores it', () => {
    const uploading = { ...basePill, state: 'uploading' };
    const r = up.transitionPill({ pill: uploading, toState: 'ready', remotePath: '/abs/a.png' });
    assert.equal(r.ok, true);
    assert.equal(r.pill.state, 'ready');
    assert.equal(r.pill.remotePath, '/abs/a.png');
  });

  it('refuses uploading -> ready with no remotePath', () => {
    const uploading = { ...basePill, state: 'uploading' };
    const r = up.transitionPill({ pill: uploading, toState: 'ready' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'UPLOAD_PILLS_INVALID');
  });

  it('allows uploading -> failed', () => {
    const uploading = { ...basePill, state: 'uploading' };
    const r = up.transitionPill({ pill: uploading, toState: 'failed' });
    assert.equal(r.ok, true);
    assert.equal(r.pill.state, 'failed');
  });

  it('allows failed -> queued as a retry, clearing any stale remotePath', () => {
    const failed = { ...basePill, state: 'failed', remotePath: null };
    const r = up.transitionPill({ pill: failed, toState: 'queued' });
    assert.equal(r.ok, true);
    assert.equal(r.pill.state, 'queued');
    assert.equal(r.pill.remotePath, null);
  });

  it('refuses ready -> anything -- ready is terminal', () => {
    const ready = { ...basePill, state: 'ready', remotePath: '/abs/a.png' };
    const r = up.transitionPill({ pill: ready, toState: 'uploading' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'UPLOAD_PILL_CONFLICT');
  });

  it('refuses queued -> ready directly -- uploading is required in between', () => {
    const r = up.transitionPill({ pill: basePill, toState: 'ready', remotePath: '/abs/a.png' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'UPLOAD_PILL_CONFLICT');
  });
});

describe('upload-pills: removePill (#1577)', () => {
  const pills = [
    { pillId: 'p1', filename: 'a.png', sizeBytes: 1, state: 'queued', remotePath: null },
    { pillId: 'p2', filename: 'b.png', sizeBytes: 2, state: 'queued', remotePath: null }
  ];

  it('refuses a non-array pills or a missing pillId', () => {
    assert.equal(up.removePill('nope', 'p1').code, 'UPLOAD_PILLS_INVALID');
    assert.equal(up.removePill(pills, '').code, 'UPLOAD_PILLS_INVALID');
  });

  it('refuses a pillId not present in the list', () => {
    const r = up.removePill(pills, 'nope');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'UPLOAD_PILL_NOT_FOUND');
  });

  it('removes exactly the named pill, leaving the others untouched', () => {
    const r = up.removePill(pills, 'p1');
    assert.equal(r.ok, true);
    assert.deepEqual(r.pills.map((p) => p.pillId), ['p2']);
  });
});

describe('upload-pills: serializeReadyPills (#1577)', () => {
  it('refuses a non-array pills', () => {
    assert.equal(up.serializeReadyPills('nope').code, 'UPLOAD_PILLS_INVALID');
  });

  it('includes only "ready" pills, in their original order', () => {
    const pills = [
      { pillId: 'p1', filename: 'a.png', state: 'ready', remotePath: '/abs/a.png' },
      { pillId: 'p2', filename: 'b.png', state: 'queued', remotePath: null },
      { pillId: 'p3', filename: 'c.png', state: 'ready', remotePath: '/abs/c.png' }
    ];
    const r = up.serializeReadyPills(pills);
    assert.equal(r.ok, true);
    assert.deepEqual(r.result.references.map((ref) => ref.pillId), ['p1', 'p3']);
  });

  it('deterministically serializes each reference\'s absolute path as a composer token', () => {
    const pills = [{ pillId: 'p1', filename: 'a.png', state: 'ready', remotePath: '/abs/a.png' }];
    const r = up.serializeReadyPills(pills);
    assert.equal(r.result.references[0].token, '[attachment:/abs/a.png]');
    assert.equal(r.result.promptText, '[attachment:/abs/a.png]');
  });

  it('joins multiple ready references into one promptText, space-separated', () => {
    const pills = [
      { pillId: 'p1', filename: 'a.png', state: 'ready', remotePath: '/abs/a.png' },
      { pillId: 'p2', filename: 'b.png', state: 'ready', remotePath: '/abs/b.png' }
    ];
    const r = up.serializeReadyPills(pills);
    assert.equal(r.result.promptText, '[attachment:/abs/a.png] [attachment:/abs/b.png]');
  });

  it('an empty list (no ready pills) serializes to an empty promptText', () => {
    const r = up.serializeReadyPills([{ pillId: 'p1', filename: 'a.png', state: 'queued', remotePath: null }]);
    assert.deepEqual(r.result.references, []);
    assert.equal(r.result.promptText, '');
  });
});

describe('public/upload-pills.js UI helpers: formatFileSize', () => {
  const H = loadUiHelpers();

  it('formats bytes under 1024 with no decimal', () => {
    assert.equal(H.formatFileSize(0), '0 B');
    assert.equal(H.formatFileSize(512), '512 B');
    assert.equal(H.formatFileSize(1023), '1023 B');
  });

  it('formats kilobytes with one decimal under 10, none at or above', () => {
    assert.equal(H.formatFileSize(1024), '1.0 KB');
    assert.equal(H.formatFileSize(4300), '4.2 KB');
    assert.equal(H.formatFileSize(1024 * 15), '15 KB');
  });

  it('formats megabytes and gigabytes', () => {
    assert.equal(H.formatFileSize(1024 * 1024), '1.0 MB');
    assert.equal(H.formatFileSize(1024 * 1024 * 1024 * 2), '2.0 GB');
  });

  it('returns an empty string for a non-finite or negative size', () => {
    assert.equal(H.formatFileSize(NaN), '');
    assert.equal(H.formatFileSize(-5), '');
    assert.equal(H.formatFileSize(undefined), '');
  });
});

describe('public/upload-pills.js UI helpers: buildPillView', () => {
  const H = loadUiHelpers();

  it('derives a queued pill\'s view', () => {
    const v = H.buildPillView({ pillId: 'p1', filename: 'a.png', sizeBytes: 2048, state: 'queued' });
    assert.equal(v.id, 'p1');
    assert.equal(v.filename, 'a.png');
    assert.equal(v.displaySize, '2.0 KB');
    assert.equal(v.state, 'queued');
    assert.equal(v.stateLabel, 'Queued');
    assert.equal(v.isReady, false);
    assert.equal(v.isFailed, false);
    assert.equal(v.canRemove, true);
    assert.equal(v.canRetry, false);
  });

  it('an uploading pill cannot be removed', () => {
    const v = H.buildPillView({ pillId: 'p1', filename: 'a.png', sizeBytes: 100, state: 'uploading' });
    assert.equal(v.canRemove, false);
    assert.equal(v.stateLabel, 'Uploading…');
  });

  it('a ready pill is marked isReady, and can be removed but not retried', () => {
    const v = H.buildPillView({ pillId: 'p1', filename: 'a.png', sizeBytes: 100, state: 'ready' });
    assert.equal(v.isReady, true);
    assert.equal(v.canRemove, true);
    assert.equal(v.canRetry, false);
  });

  it('a failed pill is marked isFailed and canRetry, and can still be removed', () => {
    const v = H.buildPillView({ pillId: 'p1', filename: 'a.png', sizeBytes: 100, state: 'failed' });
    assert.equal(v.isFailed, true);
    assert.equal(v.canRetry, true);
    assert.equal(v.canRemove, true);
  });

  it('falls back to "queued" semantics for a missing/unrecognized state', () => {
    const v = H.buildPillView({ pillId: 'p1', filename: 'a.png', sizeBytes: 100 });
    assert.equal(v.state, 'queued');
  });

  it('a null pill does not throw, and produces an empty-identity view', () => {
    const v = H.buildPillView(null);
    assert.equal(v.id, '');
    assert.equal(v.filename, '');
    assert.equal(v.state, 'queued');
  });
});

describe('public/upload-pills.js UI helpers: buildTrayView', () => {
  const H = loadUiHelpers();

  it('an empty list has count 0 and is never allReady', () => {
    const tray = H.buildTrayView([]);
    assert.equal(tray.count, 0);
    assert.equal(tray.allReady, false);
    assert.equal(tray.hasFailed, false);
    assert.equal(tray.hasInFlight, false);
  });

  it('allReady is true only when every pill is ready', () => {
    const allReady = H.buildTrayView([
      { pillId: 'p1', filename: 'a.png', sizeBytes: 1, state: 'ready' },
      { pillId: 'p2', filename: 'b.png', sizeBytes: 1, state: 'ready' }
    ]);
    assert.equal(allReady.allReady, true);

    const mixed = H.buildTrayView([
      { pillId: 'p1', filename: 'a.png', sizeBytes: 1, state: 'ready' },
      { pillId: 'p2', filename: 'b.png', sizeBytes: 1, state: 'queued' }
    ]);
    assert.equal(mixed.allReady, false);
    assert.equal(mixed.hasInFlight, true);
  });

  it('hasFailed is true when any pill failed', () => {
    const tray = H.buildTrayView([
      { pillId: 'p1', filename: 'a.png', sizeBytes: 1, state: 'ready' },
      { pillId: 'p2', filename: 'b.png', sizeBytes: 1, state: 'failed' }
    ]);
    assert.equal(tray.hasFailed, true);
    assert.equal(tray.allReady, false);
  });

  it('hasInFlight is true for queued OR uploading, false once every pill has resolved', () => {
    const queued = H.buildTrayView([{ pillId: 'p1', filename: 'a.png', sizeBytes: 1, state: 'queued' }]);
    assert.equal(queued.hasInFlight, true);
    const uploading = H.buildTrayView([{ pillId: 'p1', filename: 'a.png', sizeBytes: 1, state: 'uploading' }]);
    assert.equal(uploading.hasInFlight, true);
    const resolved = H.buildTrayView([
      { pillId: 'p1', filename: 'a.png', sizeBytes: 1, state: 'ready' },
      { pillId: 'p2', filename: 'b.png', sizeBytes: 1, state: 'failed' }
    ]);
    assert.equal(resolved.hasInFlight, false);
  });

  it('a non-array input produces an empty tray rather than throwing', () => {
    const tray = H.buildTrayView(null);
    assert.equal(tray.pills.length, 0);
    assert.equal(tray.count, 0);
  });

  it('preserves pill order in the tray\'s own pills array', () => {
    const tray = H.buildTrayView([
      { pillId: 'p1', filename: 'a.png', sizeBytes: 1, state: 'ready' },
      { pillId: 'p2', filename: 'b.png', sizeBytes: 1, state: 'queued' },
      { pillId: 'p3', filename: 'c.png', sizeBytes: 1, state: 'failed' }
    ]);
    assert.deepEqual(tray.pills.map((p) => p.id), ['p1', 'p2', 'p3']);
  });
});

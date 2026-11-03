'use strict';

// #1577 (Architect Ruling A1577): multi-file upload queue state and
// auto-appending Attachment Pills. lib/upload-pills.js is a pure library:
// no filesystem, no real upload, no DOM. Every assertion here drives the
// real exported function.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const up = require('../lib/upload-pills');
const { MAX_UPLOAD_BYTES } = require('../lib/uploads');

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

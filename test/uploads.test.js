'use strict';

/**
 * The server-facing half of uploads: the delegation to the scanner child and
 * the vocabulary the caller sees when that delegation fails (#889).
 *
 * The filesystem behavior itself lives in `test/uploads-fs.test.js`, where the
 * code moved when it had to leave the event loop, and `test/api-uploads.test.js`
 * exercises the routes end to end through a real fork. What is only observable
 * here is which scanner is used and how a failure is translated — a stubbed
 * supervisor is the only way to produce a timeout on demand.
 */

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const dirScanner = require('../lib/dir-scanner');
const uploads = require('../lib/uploads');
const { setLevel, setConsoleStream } = require('../lib/logger');

setLevel('error');

/**
 * An error shaped like the supervisor's own deadline expiry.
 * @returns {Error & {tcTimedOut: boolean}}
 */
function timedOut() {
  const err = new Error('timed out after 5000ms reading /p');
  err.tcTimedOut = true;
  return err;
}

describe('uploads (server half)', () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('listUploads', () => {
    it('uses the INTERACTIVE scanner, not the backed-off polling one', async () => {
      const interactive = mock.method(dirScanner, 'interactiveRequest',
        async () => ({ uploads: [], unreadable: null, code: null }));
      const polled = mock.method(dirScanner, 'request', async () => { throw new Error('unused'); });

      await uploads.listUploads('/p');

      // An operator who has just granted Full Disk Access and pressed the button
      // again must not be answered from a five-minute remembered refusal.
      assert.equal(interactive.mock.calls.length, 1);
      assert.equal(polled.mock.calls.length, 0);
      assert.equal(interactive.mock.calls[0].arguments[0], 'listUploads');
      assert.deepEqual(interactive.mock.calls[0].arguments[1], { projectPath: '/p' });
    });

    it('passes the child\'s refusal through with its errno and no Full Disk Access advice', async () => {
      mock.method(dirScanner, 'interactiveRequest', async () => ({
        uploads: [{ name: 'kept.txt' }],
        unreadable: "EACCES: permission denied, scandir '/p/.uploads'",
        code: 'EACCES'
      }));

      const result = await uploads.listUploads('/p');
      assert.equal(result.uploads.length, 1, 'a partial list is still a list');
      assert.equal(result.unreadableCode, 'EACCES');
      assert.equal(result.unreadableHint, null,
        'the filesystem answered — sending the operator to a privacy setting would be the misdiagnosis');
    });

    it('reports a path that never answered as SCAN_TIMEOUT, with the remedy', async () => {
      mock.method(dirScanner, 'interactiveRequest', async () => { throw timedOut(); });

      const result = await uploads.listUploads('/p');
      assert.deepEqual(result.uploads, []);
      assert.notEqual(result.unreadable, null,
        'an empty list with no reason is the exact lie this replaced');
      assert.equal(result.unreadableCode, 'SCAN_TIMEOUT');
      assert.match(result.unreadableHint, /Full Disk Access/);
    });

    it('reports collateral of another path\'s kill as SCAN_ABORTED, without the remedy', async () => {
      mock.method(dirScanner, 'interactiveRequest', async () => {
        const err = new Error('cancelled');
        err.tcAborted = true;
        throw err;
      });

      const result = await uploads.listUploads('/p');
      assert.equal(result.unreadableCode, 'SCAN_ABORTED');
      assert.equal(result.unreadableHint, null,
        'this directory may be perfectly healthy — it died with a sibling\'s child');
    });
  });

  describe('saveUpload', () => {
    it('returns the saved upload on the happy path', async () => {
      mock.method(dirScanner, 'interactiveRequest',
        async () => ({ status: 'saved', upload: { name: '20260101-000000-a.txt' } }));

      const result = await uploads.saveUpload('/p', 'a.txt', 'YQ==', 4);
      assert.equal(result.status, 'saved');
      assert.equal(result.upload.name, '20260101-000000-a.txt');
    });

    it('distinguishes a project directory that is gone from a directory that would not answer', async () => {
      mock.method(dirScanner, 'interactiveRequest', async () => ({ status: 'project-missing' }));
      assert.equal((await uploads.saveUpload('/p', 'a.txt', 'YQ==')).status, 'project-missing');

      mock.restoreAll();
      mock.method(dirScanner, 'interactiveRequest', async () => { throw timedOut(); });
      const unavailable = await uploads.saveUpload('/p', 'a.txt', 'YQ==');
      // One is the operator's to fix (400); the other is the server reporting
      // its own limit (500). A thrown error flattens them into one answer.
      assert.equal(unavailable.status, 'unavailable');
      assert.equal(unavailable.unreadableCode, 'SCAN_TIMEOUT');
      assert.match(unavailable.unreadableHint, /Full Disk Access/);
    });

    it('a project directory that is THERE and refused is not reported as one that is gone', async () => {
      // THE MUTATION THIS CATCHES: map anything-not-saved to `project-missing`.
      // The route turns that into a 400 asserting the operator's project is not
      // on disk, so a directory they can see, whose permissions are merely
      // wrong, is reported to them as deleted. The child already draws this
      // distinction with `_probe`; collapsing it here restores the misdiagnosis
      // one layer above the fix, at the surface the operator actually reads.
      mock.method(dirScanner, 'interactiveRequest',
        async () => ({ status: 'project-refused', code: 'EACCES' }));

      const result = await uploads.saveUpload('/p', 'a.txt', 'YQ==');
      assert.equal(result.status, 'unavailable',
        'a refusal is the server reporting its own limit (500), never the operator\'s 400');
      assert.notEqual(result.status, 'project-missing');
      assert.equal(result.unreadableCode, 'EACCES');
      assert.match(result.unreadable, /may not read it/);
      assert.equal(result.unreadableHint, null,
        'the filesystem answered — the Full Disk Access remedy would be the wrong advice');
    });

    it('a status this module does not know becomes the server\'s limit, and is logged', async () => {
      // A future handler status must not silently acquire the 400's meaning.
      // The log line is the only thing that would contradict a confident wrong
      // answer, so it is asserted rather than assumed.
      mock.method(dirScanner, 'interactiveRequest', async () => ({ status: 'invented-later' }));
      // Captured from the logger's own console seam rather than by spying on a
      // logger object: `createLogger` returns a FRESH object per call, so a spy
      // built here would watch something `lib/uploads.js` never calls and the
      // assertion would pass while the log line was absent.
      let written = '';
      setConsoleStream({ write: (chunk) => { written += chunk; } });
      try {
        const result = await uploads.saveUpload('/p', 'a.txt', 'YQ==');
        assert.equal(result.status, 'unavailable');
        assert.equal(result.unreadableCode, 'SCAN_FAILED');
        assert.match(result.unreadable, /invented-later/,
          'the unknown status is named, so the log and the response agree');
        assert.match(written, /invented-later/,
          'an unrecognised status must be logged, not swallowed — the log line is the only thing '
          + 'that would contradict a confident wrong answer');
      } finally {
        setConsoleStream(null);
      }
    });

    it('sends the whole payload to the child, so no part of the write stays on the event loop', async () => {
      const interactive = mock.method(dirScanner, 'interactiveRequest',
        async () => ({ status: 'saved', upload: {} }));

      await uploads.saveUpload('/p', 'a.txt', 'YQ==', 9);

      assert.equal(interactive.mock.calls[0].arguments[0], 'saveUpload');
      assert.deepEqual(interactive.mock.calls[0].arguments[1], {
        projectPath: '/p', filename: 'a.txt', base64Data: 'YQ==', sid: 9
      });
    });
  });

  describe('the save deadline is derived from the body cap, not chosen beside it', () => {
    it('scales with MAX_UPLOAD_BYTES', () => {
      // Two numbers that must agree and are maintained separately drift, and the
      // failure drift produces here is a successful upload killed for taking too
      // long and reported to the operator as a permissions problem.
      const expected = 5000 + Math.ceil(uploads.MAX_UPLOAD_BYTES / (5 * 1024 * 1024)) * 1000;
      assert.equal(uploads.SAVE_TIMEOUT_MS, expected);
      assert.ok(uploads.SAVE_TIMEOUT_MS > uploads.LIST_TIMEOUT_MS,
        'a save carries the body across the channel; a listing does not');
    });
  });
});

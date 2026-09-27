'use strict';

/*
 * The release notes gate (#1947): release.yml measures the exact UTF-8 bytes
 * of the Release body before it tags, and refuses empty or oversized notes
 * rather than truncating them. The ceiling is 120,000 bytes, per an Architect
 * ruling, counted in bytes, not JavaScript characters.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MAX_RELEASE_BODY_BYTES, checkNotes, main } = require('../scripts/release-notes-gate');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'release-notes-gate.js');

/**
 * A body of exactly `bytes` ASCII bytes.
 * @param {number} bytes - Length
 * @returns {Buffer}
 */
const ascii = (bytes) => Buffer.from('x'.repeat(bytes), 'utf8');

describe('checkNotes', () => {
  it('the ceiling is 120,000 bytes', () => {
    assert.equal(MAX_RELEASE_BODY_BYTES, 120000);
  });

  it('accepts boundary-1 and exactly the boundary, refuses boundary+1', () => {
    assert.equal(checkNotes(ascii(MAX_RELEASE_BODY_BYTES - 1)).ok, true);
    const at = checkNotes(ascii(MAX_RELEASE_BODY_BYTES));
    assert.equal(at.ok, true);
    assert.equal(at.bytes, MAX_RELEASE_BODY_BYTES);
    const over = checkNotes(ascii(MAX_RELEASE_BODY_BYTES + 1));
    assert.equal(over.ok, false);
    assert.equal(over.bytes, MAX_RELEASE_BODY_BYTES + 1);
    assert.match(over.message, /120001 bytes, over the 120000-byte ceiling/);
    assert.match(over.message, /never truncated/);
  });

  it('counts multibyte text in bytes: under the ceiling in characters, over it in bytes, is refused', () => {
    // '€' is three bytes in UTF-8, so 40,001 of them are 40,001 characters but 120,003 bytes.
    const euros = Buffer.from('€'.repeat(40001), 'utf8');
    assert.equal('€'.repeat(40001).length, 40001);
    const v = checkNotes(euros);
    assert.equal(v.ok, false);
    assert.equal(v.bytes, 120003);
    // Exactly 120,000 bytes of multibyte text is at the boundary and passes.
    assert.equal(checkNotes(Buffer.from('€'.repeat(40000), 'utf8')).ok, true);
    // A four-byte character that straddles the boundary tips it over.
    assert.equal(checkNotes(Buffer.concat([ascii(MAX_RELEASE_BODY_BYTES - 3), Buffer.from('😀', 'utf8')])).ok, false);
  });

  it('refuses empty and whitespace-only notes', () => {
    assert.equal(checkNotes(Buffer.alloc(0)).ok, false);
    assert.match(checkNotes(Buffer.from(' \n\t\n', 'utf8')).message, /empty/);
  });

  it('never returns a shortened body: the verdict carries no replacement text', () => {
    const v = checkNotes(ascii(MAX_RELEASE_BODY_BYTES + 500));
    assert.deepEqual(Object.keys(v).sort(), ['bytes', 'message', 'ok']);
  });
});

describe('release-notes-gate CLI', () => {
  let dir;

  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-notes-gate-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /**
   * Run the script on a file holding `body`.
   * @param {Buffer} body - File contents
   * @returns {import('node:child_process').SpawnSyncReturns<string>}
   */
  function runOn(body) {
    const file = path.join(dir, `notes-${body.length}.md`);
    fs.writeFileSync(file, body);
    return spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  }

  it('exits 0 at the boundary and 1 one byte over, leaving the file untouched', () => {
    assert.equal(runOn(ascii(MAX_RELEASE_BODY_BYTES)).status, 0);
    const body = ascii(MAX_RELEASE_BODY_BYTES + 1);
    const r = runOn(body);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^::error::.*Refusing to tag or release\./);
    assert.deepEqual(fs.readFileSync(path.join(dir, `notes-${body.length}.md`)), body, 'the notes file is never rewritten');
  });

  it('exits 2 on a missing file or bad usage', () => {
    assert.equal(spawnSync(process.execPath, [SCRIPT, path.join(dir, 'absent.md')], { encoding: 'utf8' }).status, 2);
    assert.equal(main([]).code, 2);
    assert.equal(main(['a', 'b']).code, 2);
    assert.equal(main(['--truncate']).code, 2);
  });
});

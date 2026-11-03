'use strict';

// #1305 (Architect Ruling A1305): safe auto-creation of a project group's
// missing sharedDir. #1306 (Architect Ruling A1306): surfacing unresolvable
// shared-doc registrations. Both co-hosted in lib/shared-docs.js per their
// own shared file envelope; both pure functions over the caller's own
// already-fetched paths/rows -- no store, no route.
//
// Also covers #1307 (Architect Ruling A1307, lib/shared-docs-http.js) per
// that ruling's own authorized test file being this same one -- a
// read-only MagicDNS link builder and confined document responder, pure
// over the caller's own already-fetched registered-doc/group data.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sharedDocs = require('../lib/shared-docs');
const sharedDocsHttp = require('../lib/shared-docs-http');

describe('shared-docs: ensureGroupSharedDir (#1305)', () => {
  let tmpDir;
  it('setup', () => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sd-upkeep-')); });

  it('refuses a non-string, empty, or null-byte-carrying path', () => {
    assert.equal(sharedDocs.ensureGroupSharedDir(undefined).code, 'SHARED_DIR_INVALID');
    assert.equal(sharedDocs.ensureGroupSharedDir('').code, 'SHARED_DIR_INVALID');
    assert.equal(sharedDocs.ensureGroupSharedDir('/tmp/x\u0000y').code, 'SHARED_DIR_INVALID');
  });

  it('refuses a relative path', () => {
    assert.equal(sharedDocs.ensureGroupSharedDir('relative/path').code, 'SHARED_DIR_INVALID');
  });

  it('refuses the filesystem root', () => {
    assert.equal(sharedDocs.ensureGroupSharedDir('/').code, 'SHARED_DIR_INVALID');
  });

  it('creates a missing directory (including missing parents) and reports created: true', () => {
    const target = path.join(tmpDir, 'fresh', 'nested', 'dir');
    const r = sharedDocs.ensureGroupSharedDir(target);
    assert.equal(r.ok, true);
    assert.equal(r.created, true);
    assert.equal(r.path, target);
    assert.ok(fs.statSync(target).isDirectory());
  });

  it('re-running on an existing directory succeeds with created: false, leaving it untouched', () => {
    const target = path.join(tmpDir, 'already-there');
    fs.mkdirSync(target);
    const marker = path.join(target, 'marker.txt');
    fs.writeFileSync(marker, 'keep me');
    const r = sharedDocs.ensureGroupSharedDir(target);
    assert.equal(r.ok, true);
    assert.equal(r.created, false);
    assert.ok(fs.existsSync(marker), 'an existing directory\'s own contents must survive');
  });

  it('fails closed with SHARED_DIR_NOT_A_DIRECTORY when the path collides with an existing file', () => {
    const target = path.join(tmpDir, 'im-a-file.txt');
    fs.writeFileSync(target, 'x');
    const r = sharedDocs.ensureGroupSharedDir(target);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SHARED_DIR_NOT_A_DIRECTORY');
  });
});

describe('shared-docs: inspectSharedDocRegistrations (#1306)', () => {
  let tmpDir;
  let okFile;
  let missingFile;
  let danglingLink;
  let unreadableFile;

  it('setup', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sd-inspect-'));
    okFile = path.join(tmpDir, 'ok.md');
    fs.writeFileSync(okFile, '# OK');
    missingFile = path.join(tmpDir, 'missing.md');
    danglingLink = path.join(tmpDir, 'dangling.md');
    fs.symlinkSync(path.join(tmpDir, 'does-not-exist-target.md'), danglingLink);
    unreadableFile = path.join(tmpDir, 'unreadable.md');
    fs.writeFileSync(unreadableFile, '# secret');
    fs.chmodSync(unreadableFile, 0o000);
  });

  const GROUPS = () => [
    { id: 'g1', name: 'Group One', sharedDir: tmpDir },
    { id: 'g2', name: 'Group Two', sharedDir: null },
    { id: 'g3', name: 'Group Three', sharedDir: path.join(tmpDir, 'never-existed') }
  ];

  it('an existing, readable doc reports resolved: true, status: "ok"', () => {
    const r = sharedDocs.inspectSharedDocRegistrations(
      [{ docId: 'd1', groupId: 'g1', name: 'OK Doc', filePath: okFile }], GROUPS()
    );
    assert.equal(r.docs[0].resolved, true);
    assert.equal(r.docs[0].status, 'ok');
    assert.equal(r.docs[0].remediationHint, null);
    assert.deepEqual(r.unresolvableDocs, []);
    assert.equal(r.startupWarning, null);
  });

  it('a missing file is reported as unresolvable with status "missing_file"', () => {
    const r = sharedDocs.inspectSharedDocRegistrations(
      [{ docId: 'd2', groupId: 'g1', name: 'Missing Doc', filePath: missingFile }], GROUPS()
    );
    assert.equal(r.docs[0].resolved, false);
    assert.equal(r.docs[0].status, 'missing_file');
    assert.ok(r.docs[0].remediationHint);
    assert.equal(r.unresolvableDocs.length, 1);
    assert.equal(r.unresolvableDocs[0].groupName, 'Group One');
  });

  it('a group with no sharedDir configured at all is reported as "missing_shared_dir"', () => {
    const r = sharedDocs.inspectSharedDocRegistrations(
      [{ docId: 'd3', groupId: 'g2', name: 'No Dir Doc', filePath: okFile }], GROUPS()
    );
    assert.equal(r.docs[0].status, 'missing_shared_dir');
  });

  it('a group whose configured sharedDir no longer exists on disk is "missing_shared_dir", even when the doc\'s own file is independently readable elsewhere (PRR-B I-Gate Round 1 #2 on PR #2869)', () => {
    const r = sharedDocs.inspectSharedDocRegistrations(
      [{ docId: 'd7', groupId: 'g3', name: 'Orphaned sharedDir Doc', filePath: okFile }], GROUPS()
    );
    assert.equal(r.docs[0].resolved, false);
    assert.equal(r.docs[0].status, 'missing_shared_dir');
    assert.equal(r.unresolvableDocs[0].groupName, 'Group Three');
  });

  it('a group whose configured sharedDir exists but is a file, not a directory, is "missing_shared_dir"', () => {
    const notADir = path.join(tmpDir, 'sharedDir-is-a-file.txt');
    fs.writeFileSync(notADir, 'x');
    const groups = [{ id: 'g4', name: 'Group Four', sharedDir: notADir }];
    const r = sharedDocs.inspectSharedDocRegistrations(
      [{ docId: 'd8', groupId: 'g4', name: 'File-as-Dir Doc', filePath: okFile }], groups
    );
    assert.equal(r.docs[0].status, 'missing_shared_dir');
  });

  it('a dangling symlink is reported as "dangling_symlink", not "missing_file"', () => {
    const r = sharedDocs.inspectSharedDocRegistrations(
      [{ docId: 'd4', groupId: 'g1', name: 'Dangling Doc', filePath: danglingLink }], GROUPS()
    );
    assert.equal(r.docs[0].status, 'dangling_symlink');
  });

  it('an unreadable file (permissions) is reported as "unreadable"', (t) => {
    if (process.getuid && process.getuid() === 0) t.skip('root ignores file permissions');
    const r = sharedDocs.inspectSharedDocRegistrations(
      [{ docId: 'd5', groupId: 'g1', name: 'Unreadable Doc', filePath: unreadableFile }], GROUPS()
    );
    assert.equal(r.docs[0].status, 'unreadable');
  });

  it('a doc naming an unregistered groupId is reported as "missing_shared_dir", not thrown', () => {
    const r = sharedDocs.inspectSharedDocRegistrations(
      [{ docId: 'd6', groupId: 'g-nonexistent', name: 'Orphan Doc', filePath: okFile }], GROUPS()
    );
    assert.equal(r.docs[0].status, 'missing_shared_dir');
    assert.equal(r.unresolvableDocs[0].groupName, null);
  });

  it('startupWarning names every unresolvable doc, and is null when none are unresolvable', () => {
    const r = sharedDocs.inspectSharedDocRegistrations(
      [
        { docId: 'd1', groupId: 'g1', name: 'OK Doc', filePath: okFile },
        { docId: 'd2', groupId: 'g1', name: 'Missing Doc', filePath: missingFile }
      ], GROUPS()
    );
    assert.match(r.startupWarning, /Missing Doc/);
    assert.equal(r.unresolvableDocs.length, 1);
  });

  it('a non-array docs or groups input never throws', () => {
    const r = sharedDocs.inspectSharedDocRegistrations(null, null);
    assert.deepEqual(r.docs, []);
    assert.deepEqual(r.unresolvableDocs, []);
    assert.equal(r.startupWarning, null);
  });

  it('UNRESOLVABLE_REASONS names every status this function can report', () => {
    assert.deepEqual(Object.values(sharedDocs.UNRESOLVABLE_REASONS).sort(), [
      'dangling_symlink', 'missing_file', 'missing_shared_dir', 'unreadable'
    ]);
  });
});

describe('shared-docs-http: buildSharedDocMagicDnsUrl (#1307)', () => {
  it('builds the stable /shared-docs/:docId form when a docId is given', () => {
    const r = sharedDocsHttp.buildSharedDocMagicDnsUrl({ baseUrl: 'https://x.ts.net:8443', docId: 'abc-123' });
    assert.equal(r.ok, true);
    assert.equal(r.url, 'https://x.ts.net:8443/shared-docs/abc-123');
  });

  it('builds the /shared/:groupId/:filename form when docId is absent', () => {
    const r = sharedDocsHttp.buildSharedDocMagicDnsUrl({ baseUrl: 'https://x.ts.net:8443', groupId: 'g1', filename: 'NETWORK.md' });
    assert.equal(r.ok, true);
    assert.equal(r.url, 'https://x.ts.net:8443/shared/g1/NETWORK.md');
  });

  it('strips a trailing slash from baseUrl before composing', () => {
    const r = sharedDocsHttp.buildSharedDocMagicDnsUrl({ baseUrl: 'https://x.ts.net:8443/', docId: 'abc' });
    assert.equal(r.url, 'https://x.ts.net:8443/shared-docs/abc');
  });

  it('URL-encodes path segments', () => {
    const r = sharedDocsHttp.buildSharedDocMagicDnsUrl({ baseUrl: 'https://x.ts.net', groupId: 'g 1', filename: 'a b.md' });
    assert.equal(r.url, 'https://x.ts.net/shared/g%201/a%20b.md');
  });

  it('refuses a missing baseUrl, or neither docId nor a groupId+filename pair', () => {
    assert.equal(sharedDocsHttp.buildSharedDocMagicDnsUrl({}).ok, false);
    assert.equal(sharedDocsHttp.buildSharedDocMagicDnsUrl({ baseUrl: 'https://x.ts.net' }).ok, false);
    assert.equal(sharedDocsHttp.buildSharedDocMagicDnsUrl({ baseUrl: 'https://x.ts.net', groupId: 'g1' }).ok, false);
  });

  it('prefers docId over a groupId+filename pair when both are given', () => {
    const r = sharedDocsHttp.buildSharedDocMagicDnsUrl({ baseUrl: 'https://x.ts.net', docId: 'abc', groupId: 'g1', filename: 'x.md' });
    assert.equal(r.url, 'https://x.ts.net/shared-docs/abc');
  });
});

describe('shared-docs-http: resolveSharedDocumentHttp (#1307)', () => {
  let tmpDir, sharedDir, docPath, registeredDocs, groups;

  it('setup', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sdhttp-'));
    sharedDir = path.join(tmpDir, 'shared');
    fs.mkdirSync(sharedDir);
    docPath = path.join(sharedDir, 'NETWORK.md');
    fs.writeFileSync(docPath, '# Network\n\nTopology.');
    registeredDocs = [{ docId: 'd1', groupId: 'g1', filePath: docPath, name: 'NETWORK' }];
    groups = [{ id: 'g1', name: 'Group One', sharedDir }];
  });

  it('serves a registered document by docId with exact markdown content', () => {
    const r = sharedDocsHttp.resolveSharedDocumentHttp({ docId: 'd1', registeredDocs, groups });
    assert.equal(r.status, 200);
    assert.equal(r.contentType, 'text/markdown; charset=utf-8');
    assert.equal(r.content, '# Network\n\nTopology.');
  });

  it('serves the same document by groupId + filename', () => {
    const r = sharedDocsHttp.resolveSharedDocumentHttp({ groupId: 'g1', filename: 'NETWORK.md', registeredDocs, groups });
    assert.equal(r.status, 200);
    assert.equal(r.content, '# Network\n\nTopology.');
  });

  it('refuses an unregistered docId with 404', () => {
    const r = sharedDocsHttp.resolveSharedDocumentHttp({ docId: 'nope', registeredDocs, groups });
    assert.equal(r.status, 404);
  });

  it('refuses a filename not registered under the given group with 404', () => {
    const r = sharedDocsHttp.resolveSharedDocumentHttp({ groupId: 'g1', filename: 'unknown.md', registeredDocs, groups });
    assert.equal(r.status, 404);
  });

  it('refuses a request naming neither docId nor a groupId+filename pair', () => {
    const r = sharedDocsHttp.resolveSharedDocumentHttp({ registeredDocs, groups });
    assert.equal(r.status, 404);
  });

  it('refuses with 403 when the registered file\'s real path is a plain ".." escape of sharedDir', () => {
    const outside = path.join(tmpDir, 'secret.md');
    fs.writeFileSync(outside, 'secret');
    const badDocs = [{ docId: 'd2', groupId: 'g1', filePath: outside, name: 'Secret' }];
    const r = sharedDocsHttp.resolveSharedDocumentHttp({ docId: 'd2', registeredDocs: badDocs, groups });
    assert.equal(r.status, 403);
    assert.equal(r.code, 'SHARED_DOC_ESCAPES_SHARED_DIR');
  });

  it('refuses with 403 when a symlink INSIDE sharedDir points to a target outside it', () => {
    const outside = path.join(tmpDir, 'secret2.md');
    fs.writeFileSync(outside, 'secret');
    const linkInside = path.join(sharedDir, 'link.md');
    fs.symlinkSync(outside, linkInside);
    const linkDocs = [{ docId: 'd3', groupId: 'g1', filePath: linkInside, name: 'Link' }];
    const r = sharedDocsHttp.resolveSharedDocumentHttp({ docId: 'd3', registeredDocs: linkDocs, groups });
    assert.equal(r.status, 403);
    assert.equal(r.code, 'SHARED_DOC_ESCAPES_SHARED_DIR');
  });

  it('refuses with 404 when the document\'s group has no sharedDir configured', () => {
    const noDirGroups = [{ id: 'g1', name: 'Group One', sharedDir: null }];
    const r = sharedDocsHttp.resolveSharedDocumentHttp({ docId: 'd1', registeredDocs, groups: noDirGroups });
    assert.equal(r.status, 404);
  });

  it('refuses with 404 when the registered file no longer exists on disk', () => {
    const goneDocs = [{ docId: 'd4', groupId: 'g1', filePath: path.join(sharedDir, 'gone.md'), name: 'Gone' }];
    const r = sharedDocsHttp.resolveSharedDocumentHttp({ docId: 'd4', registeredDocs: goneDocs, groups });
    assert.equal(r.status, 404);
  });

  it('refuses a non-array registeredDocs/groups rather than throwing', () => {
    const r = sharedDocsHttp.resolveSharedDocumentHttp({ docId: 'd1', registeredDocs: null, groups: null });
    assert.equal(r.status, 404);
  });
});

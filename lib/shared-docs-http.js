'use strict';

/**
 * Public HTTP / MagicDNS shared-document link builder and responder
 * (#1307, Architect Ruling A1307, `v5.61.0` Car 61-B Slice 1).
 *
 * A pure read-only library: {@link buildSharedDocMagicDnsUrl} and
 * {@link resolveSharedDocumentHttp} take the caller's own already-fetched
 * registered-document and group data as plain data and return a computed
 * URL or a confined read result -- nothing here mounts an Express route,
 * reads the real store, or writes anything. Mounting this behind a real
 * route in `server.js` is a tracked Slice 2 follow-up (`Milestone #51`),
 * deliberately deferred so Car 61-B stays 100% file-disjoint from this
 * wave's other `v5.61.0` cars.
 *
 * @module lib/shared-docs-http
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * A refusal, in the one shape this module always answers with.
 * @param {number} status - HTTP status
 * @param {string} code
 * @param {string} message
 * @returns {{status: number, code: string, message: string}}
 */
function _refuse(status, code, message) {
  return { status, code, message };
}

/**
 * Build the canonical shareable URL for a registered shared document
 * (#1307): `/shared-docs/:docId` when a `docId` is given (the stable,
 * never-renamed form), else `/shared/:groupId/:filename` (a readable,
 * human-facing form keyed by group and filename).
 * @param {object} input
 * @param {string} input.baseUrl - The MagicDNS/HTTP origin, no trailing slash
 * @param {string} [input.docId]
 * @param {string} [input.groupId]
 * @param {string} [input.filename]
 * @returns {{ok: true, url: string}|{ok: false, code: string, message: string}}
 */
function buildSharedDocMagicDnsUrl(input) {
  if (!input || typeof input !== 'object' || typeof input.baseUrl !== 'string' || !input.baseUrl) {
    return { ok: false, code: 'SHARED_DOC_HTTP_INVALID', message: 'input.baseUrl is required.' };
  }
  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  if (typeof input.docId === 'string' && input.docId) {
    return { ok: true, url: `${baseUrl}/shared-docs/${encodeURIComponent(input.docId)}` };
  }
  if (typeof input.groupId === 'string' && input.groupId && typeof input.filename === 'string' && input.filename) {
    return { ok: true, url: `${baseUrl}/shared/${encodeURIComponent(input.groupId)}/${encodeURIComponent(input.filename)}` };
  }
  return { ok: false, code: 'SHARED_DOC_HTTP_INVALID', message: 'Either input.docId, or both input.groupId and input.filename, are required.' };
}

/**
 * Resolve and read ONE registered shared document, strictly confined to
 * its own group's registered `sharedDir` (#1307): a request naming a
 * `docId` not in `registeredDocs`, a `groupId`/`filename` pair that names
 * no registered document, or a registered file whose real path (after
 * resolving every symlink) lands outside its group's own `sharedDir`, is
 * refused -- never served. `fs.realpathSync` on both the document and the
 * `sharedDir` is what catches a `..` traversal AND a symlink planted to
 * point outside `sharedDir` after registration; a path that merely LOOKS
 * confined by string comparison alone is not trusted.
 * @param {object} input
 * @param {string} [input.docId]
 * @param {string} [input.groupId]
 * @param {string} [input.filename]
 * @param {object[]} input.registeredDocs - `{docId, groupId, filePath, name}`
 * @param {object[]} input.groups - `{id, name, sharedDir}`
 * @returns {{status: 200, contentType: string, content: string}
 *   |{status: 403|404, code: string, message: string}}
 */
function resolveSharedDocumentHttp(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.registeredDocs) || !Array.isArray(input.groups)) {
    return _refuse(404, 'SHARED_DOC_NOT_FOUND', 'input.registeredDocs and input.groups must be arrays.');
  }

  let doc = null;
  if (typeof input.docId === 'string' && input.docId) {
    doc = input.registeredDocs.find((d) => d.docId === input.docId) || null;
  } else if (typeof input.groupId === 'string' && input.groupId && typeof input.filename === 'string' && input.filename) {
    doc = input.registeredDocs.find((d) => d.groupId === input.groupId && path.basename(d.filePath) === input.filename) || null;
  } else {
    return _refuse(404, 'SHARED_DOC_NOT_FOUND', 'Either docId, or both groupId and filename, are required.');
  }
  if (!doc) {
    return _refuse(404, 'SHARED_DOC_NOT_FOUND', 'No registered shared document matches this request.');
  }

  const group = input.groups.find((g) => g.id === doc.groupId);
  if (!group || typeof group.sharedDir !== 'string' || !group.sharedDir) {
    return _refuse(404, 'SHARED_DOC_NOT_FOUND', 'This document\'s group has no sharedDir configured.');
  }

  let realSharedDir;
  let realDocPath;
  try {
    realSharedDir = fs.realpathSync(group.sharedDir);
  } catch (err) {
    return _refuse(404, 'SHARED_DOC_NOT_FOUND', `The group's sharedDir could not be resolved: ${err.message}`);
  }
  try {
    realDocPath = fs.realpathSync(doc.filePath);
  } catch (err) {
    return _refuse(404, 'SHARED_DOC_NOT_FOUND', `The document's file could not be resolved: ${err.message}`);
  }
  const confined = realDocPath === realSharedDir || realDocPath.startsWith(realSharedDir + path.sep);
  if (!confined) {
    return _refuse(403, 'SHARED_DOC_ESCAPES_SHARED_DIR', 'This document\'s real path lands outside its group\'s sharedDir.');
  }

  let content;
  try {
    content = fs.readFileSync(realDocPath, 'utf8');
  } catch (err) {
    return _refuse(404, 'SHARED_DOC_NOT_FOUND', `The document could not be read: ${err.message}`);
  }
  return { status: 200, contentType: 'text/markdown; charset=utf-8', content };
}

module.exports = {
  buildSharedDocMagicDnsUrl,
  resolveSharedDocumentHttp
};

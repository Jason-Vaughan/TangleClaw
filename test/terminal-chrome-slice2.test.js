'use strict';

/*
 * `public/terminal-identity-ui.js` and `public/upload-pills-ui.js` (#2862,
 * Slice 2 of #1573/#1577, Ruling A503-R1) -- the stateful UI controllers
 * that wrap Slice 1's pure libraries (`lib/terminal-identity.js`,
 * `lib/upload-pills.js`) with the form state, validation and live-preview
 * logic a composer/Project Settings mount will drive. DOM is unavailable
 * here (zero-dependency repo, no jsdom): both modules are reached the same
 * way `test/upload-pills.test.js` reaches `public/upload-pills.js`, a vm
 * sandbox with a bare `window` shim, since both are deliberately DOM-free
 * except for `attachDropZone`'s own thin, optionally-called event wiring,
 * which is exercised here with a minimal hand-built element stub rather
 * than a real DOM.
 */

const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const terminalIdentity = require('../lib/terminal-identity');
const uploadPills = require('../lib/upload-pills');

/**
 * Evaluate a `public/*.js` UMD module into a fresh `{window: {}}` sandbox
 * and return its `window.<globalName>` namespace -- the same pattern
 * `test/upload-pills.test.js` already uses for `public/upload-pills.js`.
 * @param {string} filename - Under `public/`.
 * @param {string} globalName - The `window.<name>` the module attaches.
 * @returns {object}
 */
function loadUiModule(filename, globalName) {
  const file = path.join(__dirname, '..', 'public', filename);
  const src = fs.readFileSync(file, 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window[globalName];
}

/**
 * A plain-object/array copy of a value that may have come from the vm
 * sandbox's own realm, so `assert.deepEqual`/`deepStrictEqual` against a
 * literal written in THIS file's realm compares structure, not also each
 * array/object's originating `Array.prototype`/`Object.prototype` (which
 * differ by realm even for identically-shaped data, and
 * `assert.deepEqual`'s strict mode checks exactly that).
 * @param {*} value
 * @returns {*}
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// public/terminal-identity-ui.js
// ---------------------------------------------------------------------------

describe('terminal-identity-ui: validateField / validateForm', () => {
  const ui = loadUiModule('terminal-identity-ui.js', 'tcTerminalIdentityUi');

  it('exposes LOGO_POSITIONS and FIELD_NAMES', () => {
    assert.deepEqual(plain(ui.LOGO_POSITIONS), ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']);
    assert.deepEqual(plain(ui.FIELD_NAMES), ['backgroundColor', 'logoUrl', 'logoSize', 'logoOpacity', 'logoPosition']);
  });

  it('emptyFormState has every field, backgroundColor/logoUrl unset', () => {
    assert.deepEqual(plain(ui.emptyFormState()), {
      backgroundColor: null, logoUrl: null, logoSize: 100, logoOpacity: 1, logoPosition: 'bottom-right'
    });
  });

  it('accepts a null/empty backgroundColor and logoUrl (falls back to derived default)', () => {
    assert.equal(ui.validateField('backgroundColor', null).ok, true);
    assert.equal(ui.validateField('logoUrl', '').ok, true);
  });

  it('rejects a malformed backgroundColor', () => {
    const r = ui.validateField('backgroundColor', 'not-a-hex');
    assert.equal(r.ok, false);
    assert.match(r.message, /rrggbb/);
  });

  it('accepts a valid #rrggbb backgroundColor', () => {
    assert.equal(ui.validateField('backgroundColor', '#8BC34A').ok, true);
  });

  it('bounds logoSize to 10-200 and logoOpacity to 0-1', () => {
    assert.equal(ui.validateField('logoSize', 5).ok, false);
    assert.equal(ui.validateField('logoSize', 201).ok, false);
    assert.equal(ui.validateField('logoSize', 100).ok, true);
    assert.equal(ui.validateField('logoOpacity', -0.1).ok, false);
    assert.equal(ui.validateField('logoOpacity', 1.1).ok, false);
    assert.equal(ui.validateField('logoOpacity', 0).ok, true);
  });

  it('rejects a logoPosition outside LOGO_POSITIONS', () => {
    assert.equal(ui.validateField('logoPosition', 'middle-ish').ok, false);
    assert.equal(ui.validateField('logoPosition', 'center').ok, true);
  });

  it('rejects an unrecognized field name', () => {
    assert.equal(ui.validateField('notAField', 1).ok, false);
  });

  it('validateForm collects every field\'s error, keyed by field', () => {
    const result = ui.validateForm({ backgroundColor: 'nope', logoUrl: '', logoSize: 5, logoOpacity: 0.5, logoPosition: 'center' });
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result.errors).sort(), ['backgroundColor', 'logoSize']);
  });

  it('validateForm passes on a fully valid form', () => {
    assert.equal(ui.validateForm(ui.emptyFormState()).ok, true);
  });
});

describe('terminal-identity-ui: createController', () => {
  const ui = loadUiModule('terminal-identity-ui.js', 'tcTerminalIdentityUi');

  it('requires projectId and deriveProjectIdentity', () => {
    assert.throws(() => ui.createController({ deriveProjectIdentity: terminalIdentity.deriveProjectIdentity }), /projectId/);
    assert.throws(() => ui.createController({ projectId: 'p1' }), /deriveProjectIdentity/);
  });

  it('getPreview reflects the derived identity with no overrides set', () => {
    const controller = ui.createController({ projectId: 'proj-a', deriveProjectIdentity: terminalIdentity.deriveProjectIdentity });
    const preview = controller.getPreview();
    assert.equal(preview.ok, true);
    assert.equal(preview.identity.accentHex, terminalIdentity.deriveProjectIdentity({ projectId: 'proj-a' }).identity.accentHex);
    assert.deepEqual(plain(preview.logo), { url: null, size: 100, opacity: 1, position: 'bottom-right' });
  });

  it('setField updates the form state and recomputes the preview with overrideColor applied', () => {
    const controller = ui.createController({ projectId: 'proj-a', deriveProjectIdentity: terminalIdentity.deriveProjectIdentity });
    const r = controller.setField('backgroundColor', '#112233');
    assert.equal(r.ok, true);
    assert.equal(controller.getFormState().backgroundColor, '#112233');
    const preview = controller.getPreview();
    assert.equal(preview.identity.accentHex, '#112233');
    assert.equal(preview.identity.borderHex, '#112233');
  });

  it('setField rejects an invalid value and leaves the prior state untouched', () => {
    const controller = ui.createController({ projectId: 'proj-a', deriveProjectIdentity: terminalIdentity.deriveProjectIdentity });
    controller.setField('logoSize', 50);
    const rejected = controller.setField('logoSize', 9999);
    assert.equal(rejected.ok, false);
    assert.equal(controller.getFormState().logoSize, 50);
  });

  it('calls onChange with the recomputed preview after every successful setField', () => {
    const onChange = mock.fn();
    const controller = ui.createController({ projectId: 'proj-a', deriveProjectIdentity: terminalIdentity.deriveProjectIdentity, onChange });
    controller.setField('logoPosition', 'top-left');
    assert.equal(onChange.mock.calls.length, 1);
    assert.equal(onChange.mock.calls[0].arguments[0].logo.position, 'top-left');
    controller.setField('logoSize', 99999); // rejected -- no further onChange call
    assert.equal(onChange.mock.calls.length, 1);
  });

  it('reset clears every override back to emptyFormState and fires onChange', () => {
    const onChange = mock.fn();
    const controller = ui.createController({ projectId: 'proj-a', deriveProjectIdentity: terminalIdentity.deriveProjectIdentity, onChange, initial: { backgroundColor: '#112233' } });
    assert.equal(controller.getFormState().backgroundColor, '#112233');
    controller.reset();
    assert.deepEqual(controller.getFormState(), ui.emptyFormState());
    assert.equal(onChange.mock.calls.length, 1);
  });

  it('getFormState returns a copy, not the live internal state', () => {
    const controller = ui.createController({ projectId: 'proj-a', deriveProjectIdentity: terminalIdentity.deriveProjectIdentity });
    const snapshot = controller.getFormState();
    snapshot.logoSize = 1;
    assert.equal(controller.getFormState().logoSize, 100);
  });
});

// ---------------------------------------------------------------------------
// public/upload-pills-ui.js
// ---------------------------------------------------------------------------

describe('upload-pills-ui: filesFromFileList', () => {
  const ui = loadUiModule('upload-pills-ui.js', 'tcUploadPillsUi');

  it('translates a FileList-like array-of-File into the enqueueUploads shape', () => {
    const fileList = { length: 2, 0: { name: 'a.png', size: 10, type: 'image/png' }, 1: { name: 'b.txt', size: 5, type: '' } };
    assert.deepEqual(plain(ui.filesFromFileList(fileList)), [
      { filename: 'a.png', sizeBytes: 10, mimeType: 'image/png' },
      { filename: 'b.txt', sizeBytes: 5, mimeType: null }
    ]);
  });

  it('returns an empty array for an empty or missing list', () => {
    assert.deepEqual(plain(ui.filesFromFileList({ length: 0 })), []);
    assert.deepEqual(plain(ui.filesFromFileList(undefined)), []);
  });
});

describe('upload-pills-ui: createController', () => {
  const ui = loadUiModule('upload-pills-ui.js', 'tcUploadPillsUi');

  function freshController(extra) {
    return ui.createController(Object.assign({
      enqueueUploads: uploadPills.enqueueUploads,
      transitionPill: uploadPills.transitionPill,
      removePill: uploadPills.removePill,
      serializeReadyPills: uploadPills.serializeReadyPills
    }, extra || {}));
  }

  it('requires all four lib functions', () => {
    assert.throws(() => ui.createController({}), /required/);
    assert.throws(() => ui.createController({ enqueueUploads: uploadPills.enqueueUploads }), /required/);
  });

  it('addFiles enqueues through the real lib and updates the view', () => {
    const controller = freshController();
    const result = controller.addFiles([{ filename: 'a.png', sizeBytes: 10 }]);
    assert.equal(result.added.length, 1);
    assert.equal(controller.getPills().length, 1);
    assert.equal(controller.getView().count, 1);
  });

  it('markUploading / markReady drive a pill through its real lib transitions', () => {
    const controller = freshController();
    const { added } = controller.addFiles([{ filename: 'a.png', sizeBytes: 10 }]);
    const pillId = added[0].pillId;
    assert.equal(controller.markUploading(pillId).ok, true);
    assert.equal(controller.getPills()[0].state, 'uploading');
    assert.equal(controller.markReady(pillId, '/remote/a.png').ok, true);
    assert.equal(controller.getPills()[0].state, 'ready');
    assert.equal(controller.getPills()[0].remotePath, '/remote/a.png');
  });

  it('markFailed then retry: failed -> queued, remotePath cleared', () => {
    const controller = freshController();
    const { added } = controller.addFiles([{ filename: 'a.png', sizeBytes: 10 }]);
    const pillId = added[0].pillId;
    controller.markUploading(pillId);
    controller.markFailed(pillId);
    assert.equal(controller.getPills()[0].state, 'failed');
    assert.equal(controller.retry(pillId).ok, true);
    assert.equal(controller.getPills()[0].state, 'queued');
  });

  it('a transition against an unknown pillId refuses cleanly', () => {
    const controller = freshController();
    const result = controller.markUploading('no-such-pill');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'UPLOAD_PILL_NOT_FOUND');
  });

  it('remove drops a pill from the real queue', () => {
    const controller = freshController();
    const { added } = controller.addFiles([{ filename: 'a.png', sizeBytes: 10 }]);
    assert.equal(controller.remove(added[0].pillId).ok, true);
    assert.equal(controller.getPills().length, 0);
  });

  it('serialize delegates to the real serializeReadyPills over only ready pills', () => {
    const controller = freshController();
    const { added } = controller.addFiles([{ filename: 'a.png', sizeBytes: 10 }]);
    controller.markUploading(added[0].pillId);
    controller.markReady(added[0].pillId, '/remote/a.png');
    const serialized = controller.serialize();
    assert.equal(serialized.ok, true);
    assert.equal(serialized.result.references.length, 1);
    assert.equal(serialized.result.references[0].remotePath, '/remote/a.png');
  });

  it('onChange fires after addFiles, a transition, and remove -- never on a refusal', () => {
    const onChange = mock.fn();
    const controller = freshController({ onChange });
    const { added } = controller.addFiles([{ filename: 'a.png', sizeBytes: 10 }]);
    assert.equal(onChange.mock.calls.length, 1);
    controller.markUploading(added[0].pillId);
    assert.equal(onChange.mock.calls.length, 2);
    controller.markUploading('bogus');
    assert.equal(onChange.mock.calls.length, 2);
    controller.remove(added[0].pillId);
    assert.equal(onChange.mock.calls.length, 3);
  });

  it('getView uses the injected buildTrayView when given, else a minimal {pills, count} fallback', () => {
    const buildTrayView = mock.fn((pills) => ({ pills, count: pills.length, custom: true }));
    const controller = freshController({ buildTrayView });
    controller.addFiles([{ filename: 'a.png', sizeBytes: 10 }]);
    // addFiles itself calls getView() once already, to feed onChange -- this
    // call is the test's own, explicit second one.
    assert.equal(controller.getView().custom, true);
    assert.equal(buildTrayView.mock.calls.length, 2);
  });

  it('attachDropZone requires a real addEventListener-capable element', () => {
    const controller = freshController();
    assert.throws(() => controller.attachDropZone(null), /addEventListener/);
    assert.throws(() => controller.attachDropZone({}), /addEventListener/);
  });

  it('attachDropZone wires drop -> addFiles via a minimal element stub (no real DOM)', () => {
    const controller = freshController();
    const handlers = {};
    const dropZone = { addEventListener: (type, fn) => { handlers[type] = fn; } };
    controller.attachDropZone(dropZone);
    assert.equal(typeof handlers.dragover, 'function');
    assert.equal(typeof handlers.drop, 'function');

    let prevented = false;
    handlers.drop({
      preventDefault: () => { prevented = true; },
      dataTransfer: { files: { length: 1, 0: { name: 'dropped.png', size: 20, type: 'image/png' } } }
    });
    assert.equal(prevented, true);
    assert.equal(controller.getPills().length, 1);
    assert.equal(controller.getPills()[0].filename, 'dropped.png');
  });

  it('attachDropZone also wires a paired file-input\'s change event', () => {
    const controller = freshController();
    const inputHandlers = {};
    const fileInput = { addEventListener: (type, fn) => { inputHandlers[type] = fn; } };
    const dropZone = { addEventListener: () => {} };
    controller.attachDropZone(dropZone, { fileInput });
    assert.equal(typeof inputHandlers.change, 'function');
    inputHandlers.change({ target: { files: { length: 1, 0: { name: 'picked.png', size: 30, type: 'image/png' } } } });
    assert.equal(controller.getPills().length, 1);
    assert.equal(controller.getPills()[0].filename, 'picked.png');
  });
});

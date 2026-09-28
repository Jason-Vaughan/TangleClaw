'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
require('../public/api-helper.js');

/** Wire the production iframe path with a client platform and event recorder. */
function setup(platform = 'Win32') {
  const listeners = [];
  const textarea = {};
  const doc = {
    defaultView: { navigator: { platform } },
    addEventListener(type, handler, capture) { listeners.push({ type, handler, capture }); },
    querySelector() { return null; },
    createElement() { return { style: {}, setAttribute() {}, addEventListener() {} }; },
    head: { appendChild() {} },
    body: { appendChild() {} }
  };
  const term = { options: {}, textarea, element: { contains: target => target === textarea } };
  let load;
  const frame = { contentWindow: { term }, contentDocument: doc,
    addEventListener(type, handler) { load = handler; } };
  globalThis.tcWireTerminalFrame({ setTimeout() {} }, frame, () => 'dark');
  load();
  return { listeners, textarea, load };
}

/** Dispatch to capture handlers, recording native default and xterm delivery. */
function dispatch(env, props = {}) {
  const result = { stopped: false, prevented: false };
  const event = { key: 'v', ctrlKey: true, target: env.textarea,
    stopImmediatePropagation() { result.stopped = true; },
    preventDefault() { result.prevented = true; }, ...props };
  for (const listener of env.listeners) {
    if (listener.type === 'keydown' && listener.capture === true) listener.handler(event);
    if (result.stopped) break;
  }
  return result;
}

describe('Windows terminal native paste', () => {
  it('stops Ctrl+V before xterm while preserving the browser paste default', () => {
    assert.deepEqual(dispatch(setup()), { stopped: true, prevented: false });
  });
  it('leaves other shortcuts, composition, and other inputs alone', () => {
    const env = setup();
    for (const props of [{ key: 'c' }, { ctrlKey: false }, { altKey: true },
      { metaKey: true }, { shiftKey: true }, { isComposing: true }, { target: {} }]) {
      assert.deepEqual(dispatch(env, props), { stopped: false, prevented: false });
    }
  });
  it('preserves Mac and Linux terminal control-key behavior', () => {
    for (const platform of ['MacIntel', 'Linux x86_64', 'iPad']) {
      assert.deepEqual(dispatch(setup(platform)), { stopped: false, prevented: false });
    }
  });
  it('does not register duplicate paste handlers when wired again', () => {
    const env = setup();
    env.load();
    assert.equal(env.listeners.filter(x => x.type === 'keydown' && x.capture === true).length, 1);
  });
});

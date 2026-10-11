'use strict';

/*
 * #2268 — how the report on launch identity variables in tmux's global
 * environment reaches the operator: a banner on the landing page.
 *
 * Tested by RUNNING the page's render function against a DOM stub, as
 * `test/caddy-drift-surfacing.test.js` does. The property that matters most
 * here is one a source match cannot hold: the banner is hidden on a stated
 * "none" and on nothing else, so a server that says nothing is never read as a
 * server that found nothing.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setLevel } = require('../lib/logger');

setLevel('error');

const serverInfo = require('../lib/server-info');
const launchIdentity = require('../lib/launch-identity');

const LANDING_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const READ_AT = '2026-10-11T22:05:09.000Z';

/**
 * Slice a top-level function out of landing.js by brace matching.
 * @param {string} name - Function name.
 * @returns {string} Its source.
 */
function extract(name) {
  const at = LANDING_SRC.indexOf(`function ${name}(`);
  assert.ok(at > -1, `${name} should exist in landing.js`);
  const start = LANDING_SRC.lastIndexOf('\n', at) + 1;
  let depth = 0;
  for (let i = LANDING_SRC.indexOf('{', at); i < LANDING_SRC.length; i += 1) {
    if (LANDING_SRC[i] === '{') depth += 1;
    else if (LANDING_SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) return LANDING_SRC.slice(start, i + 1);
    }
  }
  throw new Error(`could not brace-match ${name}`);
}

/**
 * Run `renderLaunchIdentityBanner` against a DOM stub. The banner starts
 * hidden, as it does in the page, unless `shownBefore` says an earlier poll
 * had shown it.
 * @param {*} notice - What the poll hands the function; `undefined` is passed as that.
 * @param {{shownBefore?: boolean}} [options]
 * @returns {{hidden: boolean, html: string}} What the banner became.
 */
function render(notice, { shownBefore = false } = {}) {
  const dom = {
    hidden: !shownBefore,
    text: shownBefore ? 'left by an earlier poll' : ''
  };
  const textEl = {
    get innerHTML() { return dom.text; },
    set innerHTML(v) { dom.text = v; },
    get textContent() { return dom.text; },
    set textContent(v) { dom.text = v; }
  };
  const banner = { classList: {
    add(c) { if (c === 'hidden') dom.hidden = true; },
    remove(c) { if (c === 'hidden') dom.hidden = false; }
  } };
  const ctx = vm.createContext({
    notice,
    document: {
      getElementById: (id) => {
        if (id === 'launchIdentityBanner') return banner;
        if (id === 'launchIdentityBannerText') return textEl;
        return null;
      }
    }
  });
  vm.runInContext(`${extract('esc')}\n${extract('renderLaunchIdentityBanner')}\nrenderLaunchIdentityBanner(notice);`, ctx);
  return { hidden: dom.hidden, html: dom.text };
}

/**
 * The notice the server builds for a read that answered with these names:
 * made by the real report function, so the banner is tested against the shape
 * the server sends and not against one retyped here.
 * @param {string[]} present - Names the read found.
 * @returns {object} The notice.
 */
function noticeFor(present) {
  return launchIdentity.reportGlobalIdentity({
    read: () => ({ present, answered: true, cause: null }),
    log: { warn() {} },
    setNotice() {},
    now: () => new Date(READ_AT)
  });
}

/**
 * The notice the server builds for a read that did not answer.
 * @returns {object} The notice.
 */
function unansweredNotice() {
  return launchIdentity.reportGlobalIdentity({
    read: () => ({ present: [], answered: false, cause: 'read-timed-out' }),
    log: { warn() {} },
    setNotice() {},
    now: () => new Date(READ_AT)
  });
}

const WHEN = new Date(READ_AT).toLocaleString();

describe('#2268 the launch identity banner: variables found', () => {
  const notice = noticeFor(['TANGLECLAW_LAUNCH_ID', 'TANGLECLAW_ROLE']);

  it('is built from a notice the server really sends as found', () => {
    assert.equal(notice.state, 'found');
    assert.deepEqual(notice.variables, ['TANGLECLAW_LAUNCH_ID', 'TANGLECLAW_ROLE']);
  });

  it('shows the banner and names each variable', () => {
    const out = render(notice);
    assert.equal(out.hidden, false);
    for (const name of notice.variables) {
      assert.ok(out.html.includes(`<code>${name}</code>`), `${name} is on the page: ${out.html}`);
    }
  });

  it('gives the command that removes each one', () => {
    const out = render(notice);
    assert.equal(notice.removeCommands.length, 2);
    for (const command of notice.removeCommands) {
      assert.ok(out.html.includes(`<code>${command}</code>`), `${command} is on the page: ${out.html}`);
    }
  });

  it('says no pane TangleClaw launches inherits them', () => {
    assert.match(render(notice).html, /No pane TangleClaw launches inherits them/);
  });

  it('gives the time of the read, and says the read was made once at server start', () => {
    const out = render(notice);
    assert.ok(out.html.includes(WHEN), `${WHEN} is on the page: ${out.html}`);
    assert.match(out.html, /read once, when the server started/);
  });

  it('says it clears at the next server restart after they are removed', () => {
    assert.match(render(notice).html, /clears at the next server restart after they are removed/);
  });

  it('still shows the variables when the time is missing or unreadable, and prints no broken date', () => {
    for (const observedAt of [null, undefined, 'not a time', 42]) {
      const out = render({ ...notice, observedAt });
      assert.equal(out.hidden, false);
      assert.ok(out.html.includes('<code>TANGLECLAW_ROLE</code>'), out.html);
      assert.ok(!/Invalid Date/.test(out.html), out.html);
      assert.match(out.html, /read once, when the server started:/);
    }
  });

  it('shows the variables without a remove sentence when the server sent no commands', () => {
    const out = render({ ...notice, removeCommands: undefined });
    assert.equal(out.hidden, false);
    assert.ok(out.html.includes('<code>TANGLECLAW_LAUNCH_ID</code>'), out.html);
    assert.ok(!out.html.includes('To remove them'), out.html);
  });
});

describe('#2268 the launch identity banner: none found', () => {
  it('is hidden on a notice the server really sends as none', () => {
    const notice = noticeFor([]);
    assert.equal(notice.state, 'none');
    assert.equal(render(notice).hidden, true);
  });

  it('hides and empties a banner an earlier poll had shown', () => {
    const out = render(noticeFor([]), { shownBefore: true });
    assert.equal(out.hidden, true);
    assert.equal(out.html, '');
  });
});

describe('#2268 the launch identity banner: could not check', () => {
  it('shows the server\'s own sentence for a read that did not answer, with the time it was tried', () => {
    const notice = unansweredNotice();
    assert.equal(notice.state, 'could-not-check');
    const out = render(notice);
    assert.equal(out.hidden, false);
    assert.match(out.html, /could not check tmux&#39;s global environment/);
    assert.match(out.html, /tmux did not answer in time/);
    assert.ok(out.html.includes(WHEN), `${WHEN} is on the page: ${out.html}`);
  });

  it('shows the notice of a server that has made no read, with no time', () => {
    serverInfo.setLaunchIdentityNotice(null);
    const notice = serverInfo.getServerInfo().launchIdentityNotice;
    assert.equal(notice.state, 'could-not-check');
    assert.equal(notice.observedAt, null);
    const out = render(notice);
    assert.equal(out.hidden, false);
    assert.match(out.html, /has not checked tmux&#39;s global environment/);
    assert.ok(!out.html.includes('Tried at'), out.html);
    assert.ok(!/Invalid Date/.test(out.html), out.html);
  });

  it('names no variable and no command', () => {
    const out = render(unansweredNotice());
    assert.ok(!out.html.includes('<code>'), out.html);
  });
});

describe('#2268 the launch identity banner: a missing report is never read as none', () => {
  const MISSING = [
    ['undefined, as an older server answers', undefined],
    ['null', null],
    ['an object with no state', {}],
    ['a state this page does not know', { state: 'all-clear', variables: [], removeCommands: [], observedAt: READ_AT, message: '' }],
    ['a state of the wrong type', { state: ['none'] }],
    ['a string', 'none'],
    ['found with no variable named', { state: 'found', variables: [], removeCommands: [], observedAt: READ_AT, message: 'x' }],
    ['found with variables that are not a list', { state: 'found', variables: 'TANGLECLAW_ROLE' }],
    ['could-not-check with no sentence', { state: 'could-not-check', variables: [], removeCommands: [], observedAt: null, message: '' }]
  ];

  for (const [label, notice] of MISSING) {
    it(`shows the could-not-check line for ${label}`, () => {
      const out = render(notice);
      assert.equal(out.hidden, false, 'the banner is hidden only on a stated none');
      assert.match(out.html, /could not check tmux's global environment for launch identity variables/);
      assert.match(out.html, /the server sent no report this page can read/);
    });
  }

  it('does not promise that no pane inherits them, which an older server cannot promise', () => {
    const out = render(undefined);
    assert.ok(!/inherits/.test(out.html), out.html);
  });

  it('replaces what an earlier poll had shown', () => {
    const out = render(undefined, { shownBefore: true });
    assert.equal(out.hidden, false);
    assert.ok(!out.html.includes('left by an earlier poll'), out.html);
  });
});

describe('#2268 the launch identity banner: what reaches the page', () => {
  const HOSTILE = '<img src=x onerror=alert(1)>';

  it('escapes a variable name', () => {
    const out = render({ state: 'found', variables: [HOSTILE], removeCommands: [], observedAt: READ_AT, message: '' });
    assert.equal(out.hidden, false);
    assert.ok(!out.html.includes('<img'), out.html);
    assert.ok(out.html.includes('&lt;img'), out.html);
  });

  it('escapes a remove command', () => {
    const out = render({ state: 'found', variables: ['TANGLECLAW_ROLE'], removeCommands: [HOSTILE], observedAt: READ_AT, message: '' });
    assert.ok(!out.html.includes('<img'), out.html);
    assert.ok(out.html.includes('&lt;img'), out.html);
  });

  it('escapes the could-not-check sentence', () => {
    const out = render({ state: 'could-not-check', variables: [], removeCommands: [], observedAt: null, message: HOSTILE });
    assert.equal(out.hidden, false);
    assert.ok(!out.html.includes('<img'), out.html);
    assert.ok(out.html.includes('&lt;img'), out.html);
  });

  it('drops a name or a command that is not a string', () => {
    const out = render({
      state: 'found',
      variables: ['TANGLECLAW_ROLE', { toString: () => HOSTILE }, 7, null],
      removeCommands: [{ toString: () => HOSTILE }, 'tmux set-environment -g -u TANGLECLAW_ROLE'],
      observedAt: READ_AT,
      message: ''
    });
    assert.equal((out.html.match(/<code>/g) || []).length, 2, out.html);
    assert.ok(!out.html.includes('img'), out.html);
  });

  it('never shows a value handed to it in a field it does not render', () => {
    const SECRET = 'launch-id-0f3c9a-not-for-the-page';
    const found = render({
      ...noticeFor(['TANGLECLAW_LAUNCH_ID']),
      values: { TANGLECLAW_LAUNCH_ID: SECRET },
      value: SECRET,
      message: `TANGLECLAW_LAUNCH_ID=${SECRET}`
    });
    assert.equal(found.hidden, false);
    assert.ok(!found.html.includes(SECRET), found.html);
    const unknown = render({ state: 'all-clear', message: SECRET, variables: [SECRET], removeCommands: [SECRET] });
    assert.ok(!unknown.html.includes(SECRET), unknown.html);
  });

  it('shows no value for a notice the server builds: the notice carries none', () => {
    const notice = noticeFor(['TANGLECLAW_LAUNCH_ID', 'TANGLECLAW_PROJECT_ID', 'TANGLECLAW_WORKSPACE_ID', 'TANGLECLAW_ROLE']);
    assert.deepEqual(Object.keys(notice).sort(), ['message', 'observedAt', 'removeCommands', 'state', 'variables']);
    const out = render(notice);
    assert.ok(!out.html.includes('='), `no NAME=value on the page: ${out.html}`);
  });
});

describe('#2268 the launch identity banner: the poll and the page', () => {
  afterEach(() => serverInfo.setLaunchIdentityNotice(null));

  /**
   * The name of the field `GET /api/server-info` carries the notice in, found
   * by setting a marked notice and looking for it in the answer.
   * @returns {string} The field's name.
   */
  function fieldName() {
    const marked = { ...noticeFor(['TANGLECLAW_ROLE']), message: 'marked for the field search' };
    serverInfo.setLaunchIdentityNotice(marked);
    const info = serverInfo.getServerInfo();
    const names = Object.keys(info).filter((key) => info[key] === marked);
    assert.equal(names.length, 1, 'one field of the answer carries the notice');
    return names[0];
  }

  /**
   * Run the page's `loadServerInfo` over an answer, with every other render
   * function stubbed, and collect what the banner's function was called with.
   * @param {object} payload - The `/api/server-info` answer.
   * @returns {Promise<Array>} One entry per call: its arguments.
   */
  async function pollWith(payload) {
    const calls = [];
    const noop = () => {};
    const ctx = vm.createContext({
      state: { restartMechanism: null, serverStartedAt: null },
      api: async () => payload,
      loadUpdateStatus: async () => {},
      renderAuthUser: noop,
      renderAuthStatus: noop,
      renderBindNotice: noop,
      renderCaddyDriftBanner: noop,
      renderRecoveryNotice: noop,
      renderRunningVersion: noop,
      renderBehindOriginBanner: noop,
      renderMedusaEscalationBanner: noop,
      renderLiveCheckoutBanner: noop,
      renderStaleServerBanner: noop,
      renderStaleUnknownBanner: noop,
      hideStaleServerBanner: noop,
      renderLaunchIdentityBanner: (...args) => { calls.push(args); }
    });
    await vm.runInContext(`${extract('loadServerInfo')}\nloadServerInfo();`, ctx);
    return calls;
  }

  it('hands the banner the field the server carries the notice in', async () => {
    const field = fieldName();
    const notice = noticeFor(['TANGLECLAW_ROLE']);
    const calls = await pollWith({ [field]: notice, isStale: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1);
    assert.equal(calls[0][0], notice);
  });

  it('still calls the banner when the answer has no such field, so the gap is shown', async () => {
    for (const payload of [{ isStale: false }, { isStale: null }, { isStale: true }]) {
      const calls = await pollWith(payload);
      assert.equal(calls.length, 1, JSON.stringify(payload));
      assert.equal(calls[0][0], undefined);
    }
  });

  it('has its two anchors in the page, hidden until the first answer', () => {
    assert.match(INDEX_SRC, /<div id="launchIdentityBanner" class="orphan-banner[^"]* hidden"/);
    assert.match(INDEX_SRC, /<span class="orphan-banner-text" id="launchIdentityBannerText"><\/span>/);
  });

  it('has no dismiss control and no timer', () => {
    const at = INDEX_SRC.indexOf('id="launchIdentityBanner"');
    const element = INDEX_SRC.slice(at, INDEX_SRC.indexOf('</div>', at));
    assert.ok(!/<button/.test(element), element);
    const fn = extract('renderLaunchIdentityBanner');
    assert.ok(!/setTimeout|setInterval|onclick/.test(fn));
  });
});

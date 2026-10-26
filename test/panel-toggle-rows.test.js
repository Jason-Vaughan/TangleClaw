'use strict';

/*
 * #1906 — the ports, groups and OpenClaw panels fold each row with a toggle.
 * A control nested inside a `role="button"` element (or inside a real button)
 * is presentational to assistive technology, so the edit and undo buttons that
 * used to sit inside the toggle row might never be announced.
 *
 * The contract: the toggle is a native `<button type="button">` holding only
 * the arrow, the name and passive metadata, and every action control is its
 * sibling in the row. Asserted on the HTML the shipped render functions
 * produce, walked as a tree, so nesting is checked rather than pattern-matched.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { liftDeclaration } = require('./helpers/lift');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const ui = read('ui.js');
const landing = read('landing.js');

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

/**
 * Whether an element is an interactive control: the thing that must never sit
 * inside a button. The arrow, name and count spans are content, not controls.
 *
 * @param {{tag: string, attrs: string}} e - A walked element.
 * @returns {boolean}
 */
function isControl(e) {
  return ['button', 'a', 'input', 'select', 'textarea'].includes(e.tag)
    || /onclick=|role="button"|tabindex="0"/.test(e.attrs);
}

/**
 * Walk HTML into a flat list of elements, each knowing its ancestors. Enough
 * for markup these templates produce: attribute values are escaped, so `>`
 * never appears inside a tag.
 *
 * @param {string} html - Rendered markup.
 * @returns {{tag: string, attrs: string, cls: string[], parent: object|null, ancestors: object[]}[]}
 */
function walk(html) {
  const out = [];
  const stack = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
    const [, closing, rawTag, attrs] = m;
    const tag = rawTag.toLowerCase();
    if (closing) {
      const at = stack.map((e) => e.tag).lastIndexOf(tag);
      assert.notEqual(at, -1, `unbalanced </${tag}>`);
      stack.length = at;
      continue;
    }
    const clsMatch = attrs.match(/\bclass="([^"]*)"/);
    const el = {
      tag,
      attrs,
      cls: clsMatch ? clsMatch[1].split(/\s+/) : [],
      parent: stack[stack.length - 1] || null,
      ancestors: [...stack]
    };
    out.push(el);
    if (!VOID.has(tag)) stack.push(el);
  }
  assert.equal(stack.length, 0, 'every element must close');
  return out;
}

/**
 * Render one panel from the shipped source.
 *
 * @param {string} fnName - Render function, e.g. `renderPorts`.
 * @param {string} panelId - Element id it writes into.
 * @param {object} state - Page state it reads.
 * @returns {string} The panel's innerHTML.
 */
function renderPanel(fnName, panelId, state) {
  const panel = { innerHTML: '' };
  const src = [
    liftDeclaration(landing, 'function esc('),
    liftDeclaration(landing, 'function jsArg('),
    liftDeclaration(ui, `function ${fnName}(`)
  ].join('\n');
  new Function('state', 'document', 'api', 'loadGroupDetail', `${src}\n${fnName}();`)(
    state,
    { getElementById: (id) => (id === panelId ? panel : null) },
    () => Promise.resolve(null),
    () => {}
  );
  return panel.innerHTML;
}

const PANELS = {
  ports: {
    html: () => renderPanel('renderPorts', 'portsGrid', {
      ports: [
        { port: 5432, project: "O'Brien DB", service: 'db', permanent: true, ownerKind: 'external' },
        { port: 3290, project: 'SomeProject', service: 'dev', permanent: true }
      ],
      portGroupsOpen: {}
    }),
    toggleFn: 'togglePortGroup',
    toggleClass: 'port-group-toggle',
    actions: ['Undo the Not a project mark']
  },
  groups: {
    html: () => renderPanel('renderGroups', 'groupsPanel', {
      groups: [{ id: 'g1', name: 'Backend', memberCount: 2, docCount: 1 }],
      groupItemsOpen: { g1: false }
    }),
    toggleFn: 'toggleGroupItem',
    toggleClass: 'group-item-toggle',
    actions: ['Edit group']
  },
  openclaw: {
    html: () => renderPanel('renderOpenclawConnections', 'openclawPanel', {
      openclawConnections: [{ id: 'c1', name: 'Lab', host: 'lab.local', port: 18789, sshUser: 'u', sshKeyPath: '/k', localPort: 18790 }],
      openclawItemsOpen: { c1: false },
      openclawTunnelStatus: {}
    }),
    toggleFn: 'toggleOpenclawItem',
    toggleClass: 'oc-item-toggle',
    actions: ['Edit connection']
  }
};

describe('panel toggle rows are real buttons with their actions beside them (#1906)', () => {
  for (const [name, p] of Object.entries(PANELS)) {
    describe(name, () => {
      const els = walk(p.html());
      const toggles = els.filter((e) => e.cls.includes(p.toggleClass));

      it('renders the toggle as a native button that carries the expanded state', () => {
        assert.ok(toggles.length > 0, 'a toggle must render');
        for (const t of toggles) {
          assert.equal(t.tag, 'button');
          assert.match(t.attrs, /\btype="button"/);
          assert.match(t.attrs, /\baria-expanded="(true|false)"/);
          assert.match(t.attrs, new RegExp(`onclick="${p.toggleFn}\\(`));
          assert.ok(t.parent && t.parent.cls.includes('toggle-row'), 'the toggle sits in the shared row');
        }
      });

      it('nests no control inside the toggle, and leaves no role="button" row', () => {
        for (const e of els.filter(isControl)) {
          assert.ok(!e.ancestors.some((a) => a.tag === 'button' || /\brole="button"/.test(a.attrs)),
            `a <${e.tag}> control must not sit inside a button`);
        }
        assert.ok(!els.some((e) => /\brole="button"/.test(e.attrs)), 'the div-as-button rows are gone');
      });

      it('puts each action control beside the toggle, in the same row', () => {
        for (const title of p.actions) {
          const action = els.find((e) => e.tag === 'button' && e.attrs.includes(`title="${title}"`));
          assert.ok(action, `the "${title}" button must render`);
          const toggle = toggles.find((t) => t.parent === action.parent);
          assert.ok(toggle, `the "${title}" button is a sibling of a toggle`);
          assert.match(action.attrs, /\btype="button"/);
          // Nothing nests any more, so nothing needs to stop the click reaching the toggle.
          assert.doesNotMatch(action.attrs, /stopPropagation/);
        }
      });
    });
  }

  it('fails the nesting check on the old shape, so the check can see the defect', () => {
    const old = '<div class="toggle-row"><button type="button" class="toggle-btn x" aria-expanded="true">'
      + '<span>n</span><button class="btn">e</button></button></div>';
    const els = walk(old);
    assert.ok(els.filter(isControl).some((e) => e.ancestors.some((a) => a.tag === 'button')));
  });
});

/*
 * #1946 — folding a row re-rendered the whole panel, which replaced the
 * pressed button and dropped keyboard focus. The toggles now fold their row in
 * place, and the polling re-renders put focus back on the same toggle.
 */

/**
 * A class list over a Set, as much of DOMTokenList as the fold code touches.
 *
 * @param {string[]} [initial] - Starting classes.
 * @returns {{has: Function, toggle: Function, set: Set<string>}}
 */
function classList(initial = []) {
  const set = new Set(initial);
  return {
    set,
    has: (c) => set.has(c),
    toggle(c, force) {
      const on = force === undefined ? !set.has(c) : force;
      if (on) set.add(c); else set.delete(c);
      return on;
    }
  };
}

/**
 * One panel row as the render functions build it: a `.toggle-row` holding the
 * toggle, followed by the content element.
 *
 * @param {boolean} open - Initial state.
 * @returns {{button: object, arrow: object, content: object}}
 */
function makeRow(open) {
  const content = { classList: classList(open ? ['open'] : []) };
  const row = { nextElementSibling: content };
  const arrow = { classList: classList(open ? ['arrow', 'open'] : ['arrow']) };
  const attrs = { 'aria-expanded': String(open) };
  const button = {
    attrs,
    setAttribute(k, v) { attrs[k] = v; },
    querySelector: (sel) => (sel === '.arrow' ? arrow : null),
    closest: (sel) => (sel === '.toggle-row' ? row : null)
  };
  return { button, arrow, content };
}

/**
 * Lift the fold helpers and one toggle function, with recording stubs for
 * everything they call.
 *
 * @param {string} toggleFn - The toggle to lift, e.g. `togglePortGroup`.
 * @param {object} state - Page state.
 * @returns {{toggle: Function, renders: string[], details: string[]}}
 */
function liftToggle(toggleFn, state) {
  const renders = [];
  const details = [];
  const src = [
    liftDeclaration(ui, 'function foldToggleInPlace('),
    liftDeclaration(ui, `function ${toggleFn}(`)
  ].join('\n');
  const toggle = new Function('state', 'renderPorts', 'renderGroups', 'renderOpenclawConnections', 'loadGroupDetail',
    `${src}\nreturn ${toggleFn};`)(
    state,
    () => renders.push('ports'),
    () => renders.push('groups'),
    () => renders.push('openclaw'),
    (id) => details.push(id)
  );
  return { toggle, renders, details };
}

describe('folding keeps keyboard focus on the toggle (#1946)', () => {
  const CASES = [
    { fn: 'togglePortGroup', key: 'portGroupsOpen', id: "O'Brien DB", startOpen: true },
    { fn: 'toggleGroupItem', key: 'groupItemsOpen', id: 'g1', startOpen: false },
    { fn: 'toggleOpenclawItem', key: 'openclawItemsOpen', id: 'c1', startOpen: false }
  ];

  for (const c of CASES) {
    it(`${c.fn} folds its own row in place and re-renders nothing`, () => {
      const state = { [c.key]: { [c.id]: c.startOpen } };
      const { toggle, renders } = liftToggle(c.fn, state);
      const { button, arrow, content } = makeRow(c.startOpen);
      toggle(c.id, button);
      const now = !c.startOpen;
      assert.equal(state[c.key][c.id], now);
      assert.equal(button.attrs['aria-expanded'], String(now));
      assert.equal(arrow.classList.has('open'), now);
      assert.equal(content.classList.has('open'), now);
      assert.deepEqual(renders, [], 'the pressed button is never replaced');
      toggle(c.id, button);
      assert.equal(button.attrs['aria-expanded'], String(c.startOpen), 'and it folds back');
      assert.deepEqual(renders, []);
    });

    it(`${c.fn} still re-renders when called without the button`, () => {
      const state = { [c.key]: { [c.id]: c.startOpen } };
      const { toggle, renders } = liftToggle(c.fn, state);
      toggle(c.id);
      assert.equal(renders.length, 1);
      assert.equal(state[c.key][c.id], !c.startOpen);
    });
  }

  // foldToggleInPlace takes the element right after `.toggle-row` as the
  // content. Held against the markup the shipped renders produce, so a badge or
  // hint slipped between the row and its content fails here, not in a browser.
  for (const [name, p] of Object.entries(PANELS)) {
    it(`the ${name} render puts the row's content immediately after each toggle row`, () => {
      const contentClass = { ports: 'port-group-content', groups: 'group-item-content', openclaw: 'oc-item-content' }[name];
      const els = walk(p.html());
      const rows = els.filter((e) => e.cls.includes('toggle-row'));
      assert.ok(rows.length > 0);
      for (const row of rows) {
        const next = els.slice(els.indexOf(row) + 1).find((e) => e.parent === row.parent);
        assert.ok(next, 'a toggle row must be followed by its content');
        assert.ok(next.cls.includes(contentClass), `the element after the toggle row is .${contentClass}, not .${next.cls.join('.')}`);
      }
    });
  }

  it('a group opened in place loads its details, and closing it loads nothing', () => {
    const state = { groupItemsOpen: { g1: false } };
    const { toggle, details } = liftToggle('toggleGroupItem', state);
    const { button } = makeRow(false);
    toggle('g1', button);
    assert.deepEqual(details, ['g1']);
    toggle('g1', button);
    assert.deepEqual(details, ['g1'], 'closing fetches nothing');
  });

  for (const [name, p] of Object.entries(PANELS)) {
    it(`the ${name} toggles carry a fold key and hand the pressed button to ${p.toggleFn}`, () => {
      const toggles = walk(p.html()).filter((e) => e.cls.includes(p.toggleClass));
      assert.ok(toggles.length > 0);
      for (const t of toggles) {
        assert.match(t.attrs, /\bdata-fold-key="[^"]+"/);
        assert.match(t.attrs, new RegExp(`onclick="${p.toggleFn}\\([^"]*, this\\)"`));
      }
    });
  }

  describe('renderKeepingFoldFocus', () => {
    /**
     * A panel whose render replaces every toggle with a new element, as
     * `innerHTML` does, and a document that tracks focus.
     *
     * @param {string[]} keys - Fold keys the panel renders.
     * @returns {{doc: object, panel: object, render: Function, current: Function}}
     */
    function setup(keys) {
      const doc = { activeElement: null };
      let buttons = [];
      const build = () => {
        buttons = keys.map((k) => {
          const b = { dataset: { foldKey: k }, focus(opts) { doc.activeElement = b; doc.focusOptions = opts; } };
          return b;
        });
      };
      build();
      const panel = {
        contains: (el) => buttons.includes(el),
        querySelectorAll: (sel) => (sel === '[data-fold-key]' ? buttons : [])
      };
      return { doc, panel, render: build, current: () => buttons };
    }

    /**
     * Lift `renderKeepingFoldFocus` against a given document.
     *
     * @param {object} doc - Fake document.
     * @returns {Function}
     */
    const lift = (doc) => new Function('document', `${liftDeclaration(ui, 'function renderKeepingFoldFocus(')}\nreturn renderKeepingFoldFocus;`)(doc);

    it('puts focus back on the re-rendered toggle with the same key', () => {
      const { doc, panel, render, current } = setup(["O'Brien DB", 'SomeProject']);
      current()[1].focus();
      const before = current()[1];
      lift(doc)(panel, render);
      assert.notEqual(current()[1], before, 'the render replaced the button');
      assert.equal(doc.activeElement, current()[1], 'focus followed it');
    });

    it('restores focus without scrolling the page to the toggle', () => {
      const { doc, panel, render, current } = setup(['a']);
      current()[0].focus();
      lift(doc)(panel, render);
      assert.deepEqual(doc.focusOptions, { preventScroll: true }, 'a poll must not pull a scrolled-away operator back');
    });

    it('leaves focus alone when it was not on a toggle in this panel', () => {
      const { doc, panel, render } = setup(['a']);
      const elsewhere = { dataset: {} };
      doc.activeElement = elsewhere;
      lift(doc)(panel, render);
      assert.equal(doc.activeElement, elsewhere);
    });

    it('moves nothing when the focused toggle is gone after the render', () => {
      const s = setup(['a']);
      s.current()[0].focus();
      const gone = s.doc.activeElement;
      s.panel.querySelectorAll = () => [];
      lift(s.doc)(s.panel, s.render);
      assert.equal(s.doc.activeElement, gone, 'no toggle to hand focus to, so none is stolen');
    });
  });

  it('the polling loaders re-render through renderKeepingFoldFocus', () => {
    for (const [fn, panel, render] of [
      ['loadPorts', 'portsGrid', 'renderPorts'],
      ['loadGroups', 'groupsPanel', 'renderGroups'],
      ['loadOpenclawConnections', 'openclawPanel', 'renderOpenclawConnections']
    ]) {
      const body = liftDeclaration(landing, `async function ${fn}(`);
      assert.match(body, new RegExp(`renderKeepingFoldFocus\\(document\\.getElementById\\('${panel}'\\), ${render}\\)`), fn);
    }
  });
});

/*
 * #2092 — #1946 fixed fold TOGGLES specifically; the same panels have other
 * controls (Edit group, Kill Tunnel, Web UI, SSH, Remove, +New Group) that
 * still lost focus on the same poll, because they weren't keyed with
 * `data-fold-key` at all. `renderKeepingFoldFocus` already restores ANY
 * `[data-fold-key]` element generically (it never checked for a toggle
 * specifically) — the fix is keying these controls too, not changing the
 * restore mechanism.
 */
describe('other panel controls carry a fold key for the poll restore too (#2092)', () => {
  it('groups panel: +New Group (both the empty-state and header-actions branches) and Edit group', () => {
    const emptyHtml = renderPanel('renderGroups', 'groupsPanel', { groups: [], groupItemsOpen: {} });
    assert.match(emptyHtml, /data-fold-key="new-group"/, '+New Group in the empty-state branch');

    const html = renderPanel('renderGroups', 'groupsPanel', {
      groups: [{ id: 'g1', name: 'Backend', memberCount: 2, docCount: 1 }],
      groupItemsOpen: { g1: false }
    });
    const els = walk(html);
    assert.ok(els.some((e) => e.tag === 'button' && e.attrs.includes('data-fold-key="new-group"')),
      '+New Group in the header-actions branch (groups non-empty)');
    assert.ok(els.some((e) => e.tag === 'button' && e.attrs.includes('data-fold-key="edit-group-g1"')),
      'Edit group, keyed per group so it does not collide with the toggle\'s own key ("g1")');
  });

  it('openclaw panel: Edit connection, Web UI, SSH', () => {
    const els = walk(PANELS.openclaw.html());
    for (const key of ['edit-conn-c1', 'web-ui-c1', 'ssh-c1']) {
      assert.ok(els.some((e) => e.tag === 'button' && e.attrs.includes(`data-fold-key="${key}"`)),
        `expected a button with data-fold-key="${key}"`);
    }
  });

  it('openclaw panel: Kill Tunnel is keyed while a tunnel is active (and absent, so untested, while none is)', () => {
    const noTunnel = walk(PANELS.openclaw.html());
    assert.ok(!noTunnel.some((e) => e.attrs.includes('kill-tunnel-')), 'no Kill Tunnel button without an active tunnel');

    const html = renderPanel('renderOpenclawConnections', 'openclawPanel', {
      openclawConnections: [{ id: 'c1', name: 'Lab', host: 'lab.local', port: 18789, sshUser: 'u', sshKeyPath: '/k', localPort: 18790 }],
      openclawItemsOpen: { c1: false },
      openclawTunnelStatus: { c1: { active: true, localPort: 9999 } }
    });
    const els = walk(html);
    assert.ok(els.some((e) => e.tag === 'button' && e.attrs.includes('data-fold-key="kill-tunnel-c1"')),
      'Kill Tunnel must carry a fold key while the tunnel is active');
  });

  it("loadGroupDetail wraps its own content.innerHTML replace in renderKeepingFoldFocus (Remove member/doc buttons only exist after this async step, which runs after renderGroups()'s own outer restore already returned)", () => {
    const body = liftDeclaration(ui, 'async function loadGroupDetail(');
    assert.match(body, /renderKeepingFoldFocus\(content, \(\) => \{ content\.innerHTML = html; \}\)/);
  });

  it('Remove member and Remove document buttons are keyed by group/member/doc id, not just "remove"', () => {
    const body = liftDeclaration(ui, 'async function loadGroupDetail(');
    assert.match(body, /data-fold-key="remove-member-\$\{esc\(groupId\)\}-\$\{m\.id\}"/,
      'must include both the group and member id, so two different groups\' Remove buttons never collide');
    assert.match(body, /data-fold-key="remove-doc-\$\{esc\(doc\.id\)\}"/);
  });
});

'use strict';

/*
 * A minimal DOM for lift-and-run frontend tests.
 *
 * TangleClaw ships zero npm dependencies, so there is no jsdom to reach for —
 * and the alternative these tests exist to avoid is worse: asserting on the
 * SOURCE of a render function instead of running it. #928 R-1 is the standing
 * example, where a source pin proved a branch existed while the real `api()`
 * made it unreachable.
 *
 * This covers only what `public/` render code actually touches: a real
 * parent/child tree, class-and-tag `querySelector`, `remove()`, and listeners
 * that a test can fire. It is deliberately NOT a DOM implementation — anything
 * a page needs that is missing here should be added with a test that needed
 * it, so the stub can never quietly answer a question the browser would not.
 */

/**
 * One element node.
 *
 * @param {string} tag - Tag name.
 * @param {object|null} doc - Owning document (for `createElement` on children).
 * @returns {object} The element.
 */
function makeElement(tag, doc) {
  const classes = new Set();
  const attrs = Object.create(null);
  const listeners = Object.create(null);
  const el = {
    tagName: String(tag).toUpperCase(),
    ownerDocument: doc,
    id: '',
    // Declared rather than left to spring into existence on first assignment,
    // so a render that reads it back before writing sees '' as a browser would
    // instead of `undefined`. Needed by the session unreachable banner (#941),
    // which fills itself once and checks whether it already has.
    innerHTML: '',
    // Mirrors `element.dataset`. A plain object is faithful here: production
    // code only reads and writes string flags on it (mount()'s bound-once
    // latch), and nothing depends on the attribute-name mapping.
    dataset: Object.create(null),
    type: '',
    title: '',
    href: '',
    target: '',
    rel: '',
    disabled: false,
    parentNode: null,
    childNodes: [],
    get className() { return [...classes].join(' '); },
    set className(v) {
      classes.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
    // Mirrors `element.hidden`. Declared so a render that hides before showing
    // reads `false` as a browser would rather than `undefined` — the Master
    // bar's model pill and error line both start hidden and are asserted on.
    hidden: false,
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
      // Two-arg form only, which is all production code here uses. The one-arg
      // flip is deliberately NOT implemented: nothing needs it, and a stub that
      // answers questions the callers never ask is a stub that can be wrong
      // without anything noticing.
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c))
    },
    setAttribute(name, value) { attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    addEventListener(type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    appendChild(child) {
      child.parentNode = el;
      el.childNodes.push(child);
      return child;
    },
    /**
     * Insert before every existing child. Needed by the Master bar's model
     * pill, which sets its text and then prepends a status dot — the order
     * matters to the render, so a stub that appended would pass while producing
     * the wrong DOM.
     * @param {object} child - Element to insert first.
     * @returns {object} The child.
     */
    prepend(child) {
      child.parentNode = el;
      el.childNodes.unshift(child);
      return child;
    },
    remove() {
      if (!el.parentNode) return;
      const i = el.parentNode.childNodes.indexOf(el);
      if (i !== -1) el.parentNode.childNodes.splice(i, 1);
      el.parentNode = null;
    },
    /**
     * First descendant matching a `.class` or bare tag selector.
     * @param {string} sel - `.class` or `tag`.
     * @returns {object|null}
     */
    querySelector(sel) {
      for (const child of el.childNodes) {
        if (matches(child, sel)) return child;
        const deeper = child.querySelector(sel);
        if (deeper) return deeper;
      }
      return null;
    },
    /**
     * Fire an event at this element. Returns whether any listener ran, so a
     * test can tell "clicked nothing" from "clicked something inert".
     * @param {string} type - Event type.
     * @returns {boolean}
     */
    dispatch(type) {
      const fns = listeners[type] || [];
      const evt = { type, target: el, stopPropagation() {}, preventDefault() {} };
      fns.forEach((fn) => fn(evt));
      return fns.length > 0;
    },
    /** @returns {string} The element's own text plus its descendants'. */
    get text() {
      return (el.textContent || '') + el.childNodes.map((c) => c.text).join('');
    },
    /** @returns {object|null} First child element, or null when there are none. */
    get firstElementChild() {
      return el.childNodes[0] || null;
    }
  };
  // Own text, separate from the composed `text` getter above.
  el.textContent = '';
  return el;
}

/**
 * Does an element match a `.class` or bare-tag selector?
 * @param {object} el - Element.
 * @param {string} sel - Selector.
 * @returns {boolean}
 */
function matches(el, sel) {
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  return el.tagName === sel.toUpperCase();
}

/**
 * A document with a registry of id-addressable elements.
 *
 * @param {string[]} [ids] - Ids to pre-create as `<span>` roots.
 * @returns {object} `{doc, ids: {<id>: element}}`
 */
function makeDocument(ids) {
  const byId = Object.create(null);
  const doc = {
    createElement: (tag) => makeElement(tag, doc),
    getElementById: (id) => byId[id] || null,
    /** Register an element so `getElementById` can find it. */
    _register(el) { if (el.id) byId[el.id] = el; },
    body: null
  };
  doc.body = makeElement('body', doc);
  for (const id of ids || []) {
    const el = makeElement('span', doc);
    el.id = id;
    byId[id] = el;
    doc.body.appendChild(el);
  }
  return { doc, ids: byId };
}

/**
 * Give an element an `innerHTML` setter that extracts ids from assigned markup,
 * registers them on the document, and exposes the first as a single root child.
 *
 * This is the narrowest stand-in for the browser's parser that lets a component
 * which BUILDS its own markup be mounted and driven — the alternative is
 * asserting on the source of a mount function, which is what #928 R-1 and the
 * `mount()` idempotence pins showed proves nothing about runtime.
 *
 * DELIBERATELY NOT A PARSER. It produces a FLAT list of id-bearing elements
 * with no nesting, no attributes and no text, so it can answer only "does this
 * id now exist, and is there one root". Never assert structure, ancestry or
 * content through it — for that the markup is a string and a regex is honest.
 *
 * @param {object} el - Element to upgrade (from `makeElement`).
 * @param {object} doc - Owning document (from `makeDocument`).
 * @returns {object} The same element.
 */
function withIdParsingInnerHTML(el, doc) {
  let raw = '';
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get() { return raw; },
    set(v) {
      raw = String(v);
      el.childNodes.length = 0;
      const seen = [...raw.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
      seen.forEach((id, i) => {
        const child = makeElement('div', doc);
        child.id = id;
        doc._register(child);
        // Flat by construction: only the first id becomes the root child, so
        // `firstElementChild` answers correctly without implying a real tree.
        if (i === 0) el.appendChild(child);
      });
    }
  });
  return el;
}

module.exports = { makeElement, makeDocument, withIdParsingInnerHTML };

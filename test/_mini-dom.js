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
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c)
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

module.exports = { makeElement, makeDocument };

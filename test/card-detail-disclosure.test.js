'use strict';

/*
 * #1015 — the project card's detail panel, and the "Next action" disclosure
 * nested inside it.
 *
 * Two properties are under test, and the second is a bug fix:
 *
 *   1. The Next action is off the card ROW entirely and behind a toggle in the
 *      panel, rendered as Markdown rather than flattened onto one line.
 *   2. Open-ness lives in module state, NOT in the DOM. `renderProjects`
 *      assigns `grid.innerHTML` and the dashboard re-renders on a 10s poll, so
 *      a panel appended to a card was destroyed within ten seconds of being
 *      opened. Re-rendering must now REDRAW an open panel, not close it — the
 *      same source-of-truth rule TC#561 established for the loops panel.
 *
 * The renderers are lifted out of `public/ui.js` (a browser global script) and
 * RUN, the way test/degraded-reads-frontend.test.js does: a source guard over
 * markup stays green against a dead branch.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderNextMarkdown } = require('../public/next-markdown');

const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');

/**
 * Slice out a top-level function body by brace-matching from its declaration.
 *
 * @param {string} src - File source text.
 * @param {string} decl - The declaration to find.
 * @returns {string} The body including its braces.
 */
function functionBody(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(bodyStart, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/**
 * Lift a pure renderer out of `ui.js` and run it with its free variables
 * supplied.
 *
 * @param {string} decl - The declaration.
 * @param {string} name - The function's name.
 * @param {object} scope - Free variables by name.
 * @returns {Function} The real renderer.
 */
function lift(decl, name, scope) {
  const names = Object.keys(scope);
  const factory = new Function(...names, `${decl}${functionBody(ui, decl)}\nreturn ${name};`);
  return factory(...names.map((k) => scope[k]));
}

/**
 * The production `esc`, copied from `public/landing.js` including its
 * non-string rejection.
 *
 * @param {*} str - Value to escape.
 * @returns {string}
 */
function esc(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Run the real `renderNextActionRow`.
 *
 * @param {object} project - Project data.
 * @param {string|null} openNextAction - Which project's action is expanded.
 * @returns {string} HTML.
 */
function nextRow(project, openNextAction = null) {
  return lift('function renderNextActionRow(project)', 'renderNextActionRow', {
    esc,
    renderNextMarkdown,
    openNextAction,
    cssId: lift('function cssId(name)', 'cssId', {})
  })(project);
}

/** A project carrying a realistic multi-bullet next action. */
const WITH_NEXT = {
  name: 'Medusa',
  engine: { name: 'Claude Code' },
  tags: [],
  groups: [],
  continuityIndex: {
    nextAction: '- Coordinate non-destructive queue reads (#33)\n- Document the `WebSocket` contract (#34)'
  }
};

describe('the Next action row (#1015)', () => {
  describe('when there is nothing to show', () => {
    // The paths a populated fixture never reaches — and the ones most projects
    // on a real dashboard actually take (learnings, #885).
    it('renders nothing when continuityIndex is absent', () => {
      assert.equal(nextRow({ name: 'p' }), '');
    });

    it('renders nothing when nextAction is absent', () => {
      assert.equal(nextRow({ name: 'p', continuityIndex: {} }), '');
    });

    it('renders nothing when nextAction is whitespace-only', () => {
      // A wrap that captured nothing writes a flagged-empty marker that parses
      // back to ''. That must not draw an empty disclosure the operator can
      // open onto nothing.
      assert.equal(nextRow({ name: 'p', continuityIndex: { nextAction: '  \n \t' } }), '');
    });
  });

  describe('collapsed', () => {
    it('says outright that it opens', () => {
      // The chevron alone was not findable at the size the panel's other
      // glyphs use, so the row carries hint text while collapsed.
      const html = nextRow(WITH_NEXT);
      assert.match(html, /\(click to reveal\)/,
        'the collapsed row must state that it opens');
    });

    it('marks itself unexpanded and hides the body', () => {
      const html = nextRow(WITH_NEXT);
      assert.match(html, /aria-expanded="false"/);
      assert.match(html, /<div class="next-block"[^>]*hidden>/,
        'the body must be hidden, not merely unstyled');
    });

    it('carries a chevron', () => {
      assert.match(nextRow(WITH_NEXT), /class="next-chev"/);
    });
  });

  describe('expanded', () => {
    it('marks itself expanded and drops the hidden attribute', () => {
      const html = nextRow(WITH_NEXT, 'Medusa');
      assert.match(html, /aria-expanded="true"/);
      assert.doesNotMatch(html, /<div class="next-block"[^>]*hidden>/);
    });

    it('drops the hint once open', () => {
      // Open, the label and the rotated chevron carry the state; repeating
      // "click to reveal" over revealed content would be untrue.
      assert.doesNotMatch(nextRow(WITH_NEXT, 'Medusa'), /\(click to reveal\)/);
    });

    it('renders the action as Markdown, not as one flattened line', () => {
      // This is the defect #1015 was filed for.
      const html = nextRow(WITH_NEXT, 'Medusa');
      assert.equal((html.match(/<li>/g) || []).length, 2, 'both bullets must be list items');
      assert.match(html, /<code>WebSocket<\/code>/, 'inline code must render as code');
      assert.doesNotMatch(html, /- Coordinate/, 'raw bullet markers must not survive');
    });

    it('expands only the named project', () => {
      assert.match(nextRow(WITH_NEXT, 'SomeOtherProject'), /aria-expanded="false"/);
    });
  });

  describe('nesting', () => {
    it('stops the click reaching the card, which would close the panel under it', () => {
      // The whole card is the control that toggles the panel. Without
      // stopPropagation the card handler also fires and the panel this row
      // lives in closes at the same moment the row tries to open.
      assert.match(nextRow(WITH_NEXT), /onclick="event\.stopPropagation\(\)/);
    });

    it('points aria-controls at the id the body actually has', () => {
      const html = nextRow(WITH_NEXT);
      const controls = html.match(/aria-controls="([^"]+)"/);
      assert.ok(controls, 'the toggle must name its body');
      assert.ok(html.includes(`id="${controls[1]}"`),
        'aria-controls must resolve to a real element');
    });

    it('builds an id-safe token from a name with spaces and punctuation', () => {
      const html = nextRow({
        name: 'My Project (v2)!',
        continuityIndex: { nextAction: '- go' }
      });
      const id = html.match(/id="([^"]+)"/)[1];
      assert.doesNotMatch(id, /[^a-zA-Z0-9_-]/, 'an id must not carry spaces or punctuation');
    });
  });
});

describe('the card detail panel (#1015)', () => {
  /**
   * Run the real `renderCardDetail`.
   *
   * @param {object} project - Project data.
   * @param {string} nextRowHtml - What the Next row contributes.
   * @returns {string} HTML.
   */
  function detail(project, nextRowHtml = '<NEXT-ROW>') {
    return lift('function renderCardDetail(project)', 'renderCardDetail', {
      esc,
      renderSessionDetail: () => 'session',
      renderGitDetail: () => 'git',
      tcUnreadableNotice: () => null,
      renderNextActionRow: () => nextRowHtml
    })(project);
  }

  it('includes the Next row', () => {
    // Mutation guard: dropping renderNextActionRow from the panel template
    // removes the entire feature while every other assertion stays green.
    assert.match(detail(WITH_NEXT), /<NEXT-ROW>/);
  });

  it('places the Next row after the standing rows and before the actions', () => {
    const html = detail(WITH_NEXT);
    assert.ok(html.indexOf('Groups') < html.indexOf('<NEXT-ROW>'),
      'Next belongs below the uniform label/value rows');
    assert.ok(html.indexOf('<NEXT-ROW>') < html.indexOf('detail-actions'),
      'Next belongs above the buttons');
  });

  it('is a string, touching no DOM, so a re-render can emit it inline', () => {
    assert.equal(typeof detail(WITH_NEXT), 'string');
  });
});

describe('open-ness survives a re-render (#1015)', () => {
  /**
   * Run the real `renderCard` for a registered project.
   *
   * @param {object} project - Project data.
   * @param {string|null} openCardDetail - Which project's panel is open.
   * @returns {string} The card's HTML.
   */
  function card(project, openCardDetail = null) {
    return lift('function renderCard(project)', 'renderCard', {
      esc,
      openCardDetail,
      renderUnregisteredCard: () => '<UNREGISTERED>',
      renderArchivedCard: () => '<ARCHIVED>',
      renderCardDetail: () => '<PANEL>',
      renderVersionBadge: () => '',
      renderGitBadge: () => '',
      renderEngineBadge: () => '',
      renderUnreadableBadge: () => '',
      degradedTooltip: () => '',
      tcSessionLiveness: () => 'none',
      tcSessionRead: () => ({ why: '', remedy: '' }),
      // renderCard reads engine health off `state` to tint the engine pill.
      state: { modelStatus: {} }
    })(project);
  }

  it('draws the panel for the open project on every render', () => {
    // The bug: the panel was appended to the card, and renderProjects assigns
    // grid.innerHTML, so the 10s poll destroyed it. Rendering from state means
    // every subsequent render redraws it.
    const first = card(WITH_NEXT, 'Medusa');
    const afterPoll = card(WITH_NEXT, 'Medusa');
    assert.match(first, /<PANEL>/);
    assert.equal(first, afterPoll, 'a re-render must reproduce the open panel exactly');
  });

  it('draws no panel for a project that is not the open one', () => {
    assert.doesNotMatch(card(WITH_NEXT, 'SomethingElse'), /<PANEL>/);
    assert.doesNotMatch(card(WITH_NEXT, null), /<PANEL>/);
  });

  it('marks the open card for assistive technology and for the chevron', () => {
    const open = card(WITH_NEXT, 'Medusa');
    assert.match(open, /aria-expanded="true"/);
    assert.match(open, /class="project-card compact[^"]*is-open/);
    assert.match(card(WITH_NEXT, null), /aria-expanded="false"/);
  });

  it('carries a row chevron, so the card says it opens at all', () => {
    // The card has always been the control and never looked like one: there is
    // no hover on a touch device, and the `i` button in the same row opens the
    // Settings modal instead.
    assert.match(card(WITH_NEXT, null), /class="card-chev"/);
  });

  it('keeps the next action off the card row', () => {
    // The whole complaint in #1015: a nowrap line under every row, carrying a
    // flattened copy of the action.
    const html = card(WITH_NEXT, null);
    assert.doesNotMatch(html, /card-preview/, 'the flattened preview line must be gone');
    assert.doesNotMatch(html, /Coordinate non-destructive/,
      'no next-action text may appear on a collapsed card');
  });
});

describe('the toggles flip state rather than editing the DOM (#1015)', () => {
  it('toggleCardDetail re-renders instead of appending to a card', () => {
    const body = functionBody(ui, 'function toggleCardDetail(name)');
    assert.match(body, /openCardDetail = /, 'it must own the state');
    assert.match(body, /renderProjects\(\)/, 'it must re-render');
    assert.doesNotMatch(body, /appendChild|\.remove\(\)/,
      'DOM surgery is what the 10s poll used to undo');
  });

  it('toggleCardDetail closes the nested Next with its panel', () => {
    // The Next disclosure lives inside the panel, so it cannot outlive it —
    // otherwise reopening the card would show an action already expanded.
    const body = functionBody(ui, 'function toggleCardDetail(name)');
    assert.match(body, /openNextAction = null/);
  });

  it('both toggles restore focus, which the grid re-render destroys', () => {
    // renderProjects replaces the whole grid, so the element the operator was
    // on stops existing. Without this a keyboard user lands on <body>.
    assert.match(functionBody(ui, 'function toggleCardDetail(name)'), /focusCard\(name\)/);
    assert.match(functionBody(ui, 'function toggleNextAction(name)'), /focusNextToggle\(name\)/);
  });
});

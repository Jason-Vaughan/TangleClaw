/*
 * Renders a continuity index's "Next action" as a small, safe subset of
 * Markdown.
 *
 * `nextAction` is authored by an engine session at wrap and arrives as real
 * multi-line Markdown — the bullet lists, inline code and issue refs a session
 * writes about its own unfinished work. The dashboard used to draw it into a
 * single `white-space: nowrap` line, which flattened every bullet into one run
 * of text and printed backticks raw.
 *
 * Two properties matter more than coverage here:
 *
 *   1. ESCAPE FIRST. The source is written by a session, not by a person
 *      typing into a trusted field, so nothing may reach `innerHTML` without
 *      passing through `escHtml` first. Marks are applied to already-escaped
 *      text; no raw HTML can survive.
 *   2. Deliberately SMALL. Bullets, bold and inline code cover every construct
 *      the real wrap data uses. Autolinking is declined on purpose: building
 *      an href out of session-authored text is the one place an escaping slip
 *      would turn into a live link.
 *
 * Exposed on `window` for the browser and via `module.exports` for tests, the
 * same shape as `public/openclaw-cache.js`.
 */
(function () {
  'use strict';

  /**
   * Escape the five characters that let text become markup.
   *
   * @param {*} s - Any value; coerced to string.
   * @returns {string} Text safe to place in an HTML document.
   */
  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  /**
   * Apply inline marks to one already-escaped line.
   *
   * Code spans and bold are matched in a SINGLE alternating pass rather than
   * two sequential replaces: one pass consumes left to right, so a code span
   * swallows its own content and `**` inside it stays literal. Two passes
   * would let bold reach inside a code span and emit `<strong>` where the
   * author wrote a literal asterisk.
   *
   * @param {string} escaped - Line text, already HTML-escaped.
   * @returns {string} The line with `<code>` and `<strong>` applied.
   */
  function inlineMarks(escaped) {
    return escaped.replace(
      /`([^`]+)`|\*\*([^*]+)\*\*/g,
      (_match, code, bold) => (code !== undefined
        ? `<code>${code}</code>`
        : `<strong>${bold}</strong>`)
    );
  }

  /**
   * Render a "Next action" body to HTML.
   *
   * Recognises `- ` / `* ` bullet lines (grouped into a `<ul>`) and treats
   * every other non-blank line as a paragraph. A blank line closes an open
   * list. Absent, empty and whitespace-only input all render as `''` — the
   * caller decides whether a project with no next action shows anything at
   * all, so this must not invent an empty `<ul>` for it to draw.
   *
   * @param {string} src - Raw `nextAction` text.
   * @returns {string} HTML, safe to assign to `innerHTML`.
   */
  function renderNextMarkdown(src) {
    const out = [];
    let inList = false;

    for (const raw of String(src == null ? '' : src).split('\n')) {
      const line = raw.trim();
      if (!line) {
        if (inList) { out.push('</ul>'); inList = false; }
        continue;
      }
      const bullet = line.match(/^[-*]\s+(.*)$/);
      if (bullet) {
        if (!inList) { out.push('<ul class="next-list">'); inList = true; }
        out.push(`<li>${inlineMarks(escHtml(bullet[1]))}</li>`);
      } else {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(`<p>${inlineMarks(escHtml(line))}</p>`);
      }
    }
    if (inList) out.push('</ul>');

    return out.join('');
  }

  const api = { renderNextMarkdown, escHtml };

  // Browser: expose on window for ui.js, which is a global script.
  if (typeof window !== 'undefined') {
    window.renderNextMarkdown = renderNextMarkdown;
  }
  // Node (tests): expose via CommonJS module.exports too.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();

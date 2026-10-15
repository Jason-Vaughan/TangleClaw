'use strict';

/*
 * Pointers between documents go stale silently: a renamed heading, a moved page or a new failure
 * code leaves a link or a table that still reads well and no longer says what is true. Three such
 * gaps were found the hard way: the entry pages never mentioned the Discord operator bridge (#2417),
 * the merge queue's page left out two of the codes an entry fails with (#2365), and the user guide
 * sent readers to a "pane-check section" the engine guide does not have (#2312).
 *
 * The guard is source-scanning: it reads the pages and `lib/merge-queue.js`, and nothing else.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Read a repository file as text.
 * @param {string} rel - Path relative to the repository root.
 * @returns {string} The file's contents.
 */
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/**
 * The anchor GitHub gives a heading: lower case, punctuation other than `-` and `_` dropped,
 * each space a hyphen.
 * @param {string} heading - The heading's text, without its leading `#`s.
 * @returns {string} The anchor, without the `#`.
 */
function slug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

/**
 * Every heading anchor a markdown file has, fenced code excluded.
 * @param {string} rel - Path relative to the repository root.
 * @returns {Set<string>} The anchors.
 */
function anchorsOf(rel) {
  const text = read(rel).replace(/```[\s\S]*?```/g, '');
  const anchors = new Set();
  for (const m of text.matchAll(/^#{1,6}\s+(.+)$/gm)) anchors.add(slug(m[1]));
  for (const m of text.matchAll(/<a id="([^"]+)"><\/a>/g)) anchors.add(m[1]);
  return anchors;
}

/**
 * The relative links in a piece of markdown, resolved against the file it is in.
 * @param {string} fromRel - The file holding the markdown, relative to the repository root.
 * @param {string} markdown - The markdown to scan.
 * @returns {{target: string, anchor: (string|null), raw: string}[]} One entry per link.
 */
function relativeLinks(fromRel, markdown) {
  const links = [];
  for (const m of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    const raw = m[1];
    if (/^[a-z]+:/i.test(raw)) continue;
    const [file, anchor] = raw.split('#');
    const target = file ? path.posix.join(path.posix.dirname(fromRel), file) : fromRel;
    links.push({ target, anchor: anchor === undefined ? null : anchor, raw });
  }
  return links;
}

/**
 * Assert that every relative link resolves to an existing file, and every anchor to a heading in it.
 * @param {string} fromRel - The file holding the links.
 * @param {string} markdown - The markdown holding the links.
 * @returns {number} How many links were checked.
 */
function assertLinksResolve(fromRel, markdown) {
  const links = relativeLinks(fromRel, markdown);
  for (const { target, anchor, raw } of links) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, target)), `${fromRel}: ${raw} names a file that exists`);
    if (anchor !== null) assert.ok(anchorsOf(target).has(anchor), `${fromRel}: ${raw} names a heading in ${target}`);
  }
  return links.length;
}

/**
 * The body of one `## ` section: from its heading to the next `## ` heading.
 * @param {string} text - The page.
 * @param {string} heading - The section's heading text.
 * @returns {string} The section, heading included.
 */
function sectionOf(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `the page has a "## ${heading}" section`);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

describe('entry pages point to the Discord operator bridge (#2417)', () => {
  const ENTRY_PAGES = ['README.md', 'docs/setup-guide.md', 'docs/user-guide.md'];
  const TARGETS = ['docs/operator-bridge.md', 'docs/operator-bridge-helper.md', 'docs/runbooks/activate-the-operator-bridge.md'];

  for (const page of ENTRY_PAGES) {
    it(`${page} has exactly one bridge section, linking all three pages, and every link resolves`, () => {
      const text = read(page);
      assert.equal(text.match(/^## Discord operator bridge$/gm)?.length, 1, 'exactly one section');
      const section = sectionOf(text, 'Discord operator bridge');
      const targets = relativeLinks(page, section).map((l) => l.target);
      for (const t of TARGETS) assert.ok(targets.includes(t), `the section links ${t}`);
      assertLinksResolve(page, section);
    });
  }

  it('the helper page\'s status and quick start link only to files and headings that exist', () => {
    const page = 'docs/operator-bridge-helper.md';
    const status = sectionOf(read(page), 'Status');
    assert.ok(assertLinksResolve(page, status) >= 8, 'the quick start\'s links were found');
    assert.match(status, /set-secret bot/, 'a fresh install is told to store the bot token');
  });

  it('no bridge page still says it has not been run against Discord or that cutover has not started', () => {
    for (const page of ['docs/operator-bridge-helper.md', 'docs/operator-bridge.md', 'docs/discord-operator-notifications.md']) {
      const text = read(page);
      for (const stale of [/has not been\s+run against Discord/, /cutover has not happened/, /Cutover \| Not started/, /Built; not yet run against Discord/]) {
        assert.doesNotMatch(text, stale, `${page} no longer says ${stale}`);
      }
    }
  });

  it('no bridge page claims the bridge is in force everywhere since a release', () => {
    for (const page of ['README.md', 'docs/setup-guide.md', 'docs/user-guide.md', 'docs/operator-bridge-helper.md', 'docs/operator-bridge.md', 'docs/discord-operator-notifications.md']) {
      assert.doesNotMatch(read(page), /supported since v5\.31/i, `${page}: shipping is a fact about the release, not a cutover`);
    }
  });
});

describe('the merge queue page names every failure code (#2365)', () => {
  it('each code in FAILURES appears in docs/merge-queue.md', () => {
    const { FAILURES } = require('../lib/merge-queue');
    const codes = Object.values(FAILURES);
    assert.ok(codes.length > 0, 'there are codes to check');
    const page = read('docs/merge-queue.md');
    for (const code of codes) assert.ok(page.includes(`\`${code}\``), `docs/merge-queue.md names \`${code}\``);
  });
});

describe('the user guide\'s pointer into the engine guide resolves (#2312)', () => {
  it('the launch-identity notice points to a heading the engine guide has', () => {
    const page = 'docs/user-guide.md';
    const line = read(page).split('\n').find((l) => l.includes('`launchIdentityNotice`'));
    assert.ok(line, 'the user guide still mentions launchIdentityNotice');
    assert.doesNotMatch(line, /pane-check section/, 'it no longer names a section that does not exist');
    const links = relativeLinks(page, line).filter((l) => l.target === 'docs/engine-guide.md');
    assert.equal(links.length, 1, 'it links the engine guide once');
    assert.ok(links[0].anchor, 'the link names a heading');
    assertLinksResolve(page, line);
  });
});

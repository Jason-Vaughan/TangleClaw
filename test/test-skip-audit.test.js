'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const skipAudit = require('../scripts/test-skip-audit');

/**
 * Build a junit document in the shape node:test's reporter emits.
 *
 * @param {string} body - Inner `<testsuite>` markup
 * @returns {string} A complete report
 */
function junit(body) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${body}\n</testsuites>\n`;
}

const NESTED = junit(`
\t<testsuite name="outer" tests="4" skipped="3">
\t\t<testcase name="passes" time="0.1" classname="test"/>
\t\t<testcase name="skips with reason" time="0.1" classname="test">
\t\t\t<skipped type="skipped" message="because host"/>
\t\t</testcase>
\t\t<testsuite name="inner &amp; deeper" tests="2" skipped="2">
\t\t\t<testcase name="todo later" time="0.1" classname="test">
\t\t\t\t<skipped type="todo" message="later"/>
\t\t\t</testcase>
\t\t\t<testcase name="quoted &amp;quot;mode&amp;quot; arrow &#8594; end &lt;x>
spanning lines" time="0.1" classname="test">
\t\t\t\t<skipped type="skipped"/>
\t\t\t</testcase>
\t\t</testsuite>
\t</testsuite>
\t<testsuite name="second" tests="1" skipped="0">
\t\t<testcase name="fails" time="0.1" classname="test">
\t\t\t<failure message="boom"/>
\t\t</testcase>
\t</testsuite>`);

describe('scripts/test-skip-audit — parseJunit', () => {
  it('counts every testcase and lists the skipped ones with full suite paths', () => {
    const run = skipAudit.parseJunit(NESTED);
    assert.equal(run.total, 5);
    assert.deepEqual(run.skipped.map((s) => s.path), [
      'outer > skips with reason',
      'outer > inner & deeper > todo later',
      'outer > inner & deeper > quoted "mode" arrow → end <x>\nspanning lines'
    ]);
  });

  it('keeps the skip kind and message, and reads a self-closing skipped tag', () => {
    const run = skipAudit.parseJunit(NESTED);
    assert.deepEqual(run.skipped.map((s) => [s.kind, s.message]), [
      ['skipped', 'because host'],
      ['todo', 'later'],
      ['skipped', '']
    ]);
  });

  it('a failed testcase is counted but not skipped', () => {
    const run = skipAudit.parseJunit(NESTED);
    assert.equal(run.skipped.some((s) => s.path.endsWith('fails')), false);
  });

  it('an empty report certifies nothing', () => {
    assert.deepEqual(skipAudit.parseJunit(junit('')), { total: 0, skipped: [] });
  });
});

describe('scripts/test-skip-audit — compileLedger', () => {
  it('compiles well-formed entries into regexes', () => {
    const entries = skipAudit.compileLedger({ entries: [
      { id: 'a', match: '^outer > skips', why: 'w', runsWhere: 'r' }
    ] });
    assert.equal(entries.length, 1);
    assert.ok(entries[0].match instanceof RegExp);
  });

  it('refuses a ledger that is not an entries array', () => {
    assert.throws(() => skipAudit.compileLedger({}), /entries/);
    assert.throws(() => skipAudit.compileLedger(null), /entries/);
  });

  it('refuses an entry missing id, match, why, or runsWhere — a half-loaded ledger half-checks', () => {
    for (const missing of ['id', 'match', 'why', 'runsWhere']) {
      const entry = { id: 'a', match: 'x', why: 'w', runsWhere: 'r' };
      delete entry[missing];
      assert.throws(() => skipAudit.compileLedger({ entries: [entry] }), new RegExp(missing));
    }
  });

  it('refuses duplicate ids', () => {
    assert.throws(() => skipAudit.compileLedger({ entries: [
      { id: 'a', match: 'x', why: 'w', runsWhere: 'r' },
      { id: 'a', match: 'y', why: 'w', runsWhere: 'r' }
    ] }), /two entries with id "a"/);
  });
});

describe('scripts/test-skip-audit — audit', () => {
  const entries = skipAudit.compileLedger({ entries: [
    { id: 'reasoned', match: '^outer > skips with reason$', why: 'w', runsWhere: 'r' },
    { id: 'inner', match: '^outer > inner & deeper > ', why: 'w', runsWhere: 'r' }
  ] });

  it('passes when every skip matches a ledger entry, grouping by entry', () => {
    const result = skipAudit.audit(skipAudit.parseJunit(NESTED), entries);
    assert.equal(result.ok, true);
    assert.equal(result.total, 5);
    assert.equal(result.ran, 2);
    assert.equal(result.expected.get('reasoned').length, 1);
    assert.equal(result.expected.get('inner').length, 2);
    assert.deepEqual(result.unknown, []);
  });

  it('FAILS on a skip the ledger does not name — the guard the whole script exists for', () => {
    const narrower = entries.slice(0, 1);
    const result = skipAudit.audit(skipAudit.parseJunit(NESTED), narrower);
    assert.equal(result.ok, false);
    assert.equal(result.unknown.length, 2);
    assert.match(result.unknown[0].path, /todo later/);
  });

  it('FAILS when the report holds no tests — an empty report must not read as "nothing skipped"', () => {
    const result = skipAudit.audit({ total: 0, skipped: [] }, entries);
    assert.equal(result.ok, false);
  });

  it('passes a run with no skips at all', () => {
    const result = skipAudit.audit({ total: 3, skipped: [] }, entries);
    assert.equal(result.ok, true);
    assert.equal(result.ran, 3);
  });
});

describe('scripts/test-skip-audit — formatReport', () => {
  it('leads with what was certified and lists unknown skips under a failing heading', () => {
    const entries = skipAudit.compileLedger({ entries: [
      { id: 'reasoned', match: '^outer > skips with reason$', why: 'Needs a host.', runsWhere: 'dev boxes.' }
    ] });
    const result = skipAudit.audit(skipAudit.parseJunit(NESTED), entries);
    const text = skipAudit.formatReport(result, entries);
    assert.match(text, /^## Test run certified 2 of 5 tests/);
    assert.match(text, /\*\*reasoned\*\* — 1 skipped\. Needs a host\. Runs: dev boxes\./);
    assert.match(text, /2 skipped test\(s\) NOT on the ledger — this fails the audit/);
    assert.match(text, /todo later \(todo\) — _later_/);
  });

  it('names ledger entries that matched nothing — the ledger\'s lifecycle signal', () => {
    const entries = skipAudit.compileLedger({ entries: [
      { id: 'reasoned', match: '^outer > skips with reason$', why: 'w', runsWhere: 'r' },
      { id: 'inner', match: '^outer > inner & deeper > ', why: 'w', runsWhere: 'r' },
      { id: 'retired-tier', match: '^gone > ', why: 'w', runsWhere: 'r' }
    ] });
    const text = skipAudit.formatReport(skipAudit.audit(skipAudit.parseJunit(NESTED), entries), entries);
    assert.match(text, /no skipped test on this host .*: retired-tier$/m);
    assert.doesNotMatch(text, /no skipped test on this host .*reasoned/);
  });

  it('says so when nothing was skipped', () => {
    const text = skipAudit.formatReport(skipAudit.audit({ total: 3, skipped: [] }, []), []);
    assert.match(text, /Every test ran\. Nothing was skipped\./);
  });

  it('says so when nothing was certified', () => {
    const text = skipAudit.formatReport(skipAudit.audit({ total: 0, skipped: [] }, []), []);
    assert.match(text, /nothing was certified/);
  });
});

describe('scripts/test-skip-audit — main', () => {
  /**
   * Run `main` against a report and ledger written to a scratch dir, capturing
   * stdout and the step-summary file.
   *
   * @param {string} xml - Report text
   * @param {object} ledger - Ledger object
   * @returns {{code: number, out: string, summary: string}}
   */
  function run(xml, ledger) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-audit-'));
    try {
      const report = path.join(dir, 'r.xml');
      const ledgerPath = path.join(dir, 'l.json');
      const summary = path.join(dir, 'summary.md');
      fs.writeFileSync(report, xml);
      fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
      let out = '';
      const code = skipAudit.main(['--ledger', ledgerPath, report], {
        env: { GITHUB_STEP_SUMMARY: summary },
        stdout: { write: (s) => { out += s; } }
      });
      return { code, out, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '' };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const fullLedger = { entries: [
    { id: 'reasoned', match: '^outer > skips with reason$', why: 'w', runsWhere: 'r' },
    { id: 'inner', match: '^outer > inner & deeper > ', why: 'w', runsWhere: 'r' }
  ] };

  it('exits 0 and writes the same report to stdout and the step summary', () => {
    const r = run(NESTED, fullLedger);
    assert.equal(r.code, 0);
    assert.match(r.out, /certified 2 of 5/);
    assert.equal(r.summary, r.out);
  });

  it('exits 1 on an unknown skip', () => {
    const r = run(NESTED, { entries: fullLedger.entries.slice(0, 1) });
    assert.equal(r.code, 1);
    assert.match(r.out, /NOT on the ledger/);
  });

  it('exits 1 when the report file is missing — no report is not a clean report', () => {
    let out = '';
    const code = skipAudit.main(['--ledger', skipAudit.DEFAULT_LEDGER, path.join(os.tmpdir(), 'no-such-report.xml')], {
      env: {},
      stdout: { write: (s) => { out += s; } }
    });
    assert.equal(code, 1);
    assert.match(out, /report not found/);
  });

  it('exits 1 with usage when given no report', () => {
    let out = '';
    assert.equal(skipAudit.main([], { env: {}, stdout: { write: (s) => { out += s; } } }), 1);
    assert.match(out, /usage/);
  });
});

describe('scripts/test-skip-audit — against the real producer', () => {
  // The hand-written NESTED fixture pins the parser's MODEL of node:test's
  // junit reporter. This pins the reporter itself: a fixture test file is run
  // through `node --test --test-reporter=junit`, exactly as the CI step runs
  // the suite, and the report is parsed. If the reporter stopped emitting
  // `<skipped>` — or changed how it escapes names — the audit would print
  // "Every test ran" and exit 0, and nothing above would notice.
  it('a skipped test in a real node:test run is reported with its full path, message, and decoded name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-audit-real-'));
    try {
      const fixture = path.join(dir, 'fixture.test.js');
      fs.writeFileSync(fixture, [
        "const { describe, it } = require('node:test');",
        "describe('outer <suite>', () => {",
        "  it('passes', () => {});",
        '  describe(\'mode "auto" & more\', () => {',
        "    it('skips here', (t) => { t.skip('not on this host'); });",
        "  });",
        "});"
      ].join('\n'));
      const report = path.join(dir, 'r.xml');
      // This test itself runs inside node:test, which marks its children with
      // NODE_TEST_CONTEXT; a nested `node --test` that inherits it behaves as
      // a child of THIS run and honours no reporter flags. Strip it so the
      // nested run is a top-level runner, exactly as CI invokes it.
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      execFileSync(process.execPath, [
        '--test', '--test-reporter=junit', `--test-reporter-destination=${report}`, fixture
      ], { stdio: 'pipe', env });
      const run = skipAudit.parseJunit(fs.readFileSync(report, 'utf8'));
      assert.equal(run.total, 2);
      assert.deepEqual(run.skipped, [
        { path: 'outer <suite> > mode "auto" & more > skips here', kind: 'skipped', message: 'not on this host' }
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('test/skip-ledger.json — the shipped ledger', () => {
  const ledger = JSON.parse(fs.readFileSync(skipAudit.DEFAULT_LEDGER, 'utf8'));

  // The set CI does not run today, by full path, as of the run this ledger was
  // written against. Bookkeeping, not a count anyone relies on: the live guard
  // is the CI step, which fails on any path this list has drifted from. What
  // this fixture protects is the other direction — a ledger pattern that is
  // too narrow to cover its own tier would only be found out on the next CI
  // run of somebody else's PR.
  const CI_SKIPS = [
    'engine launch flags exist in the installed CLI (#731) > aider > launch mode "yesAlways" uses args the installed CLI accepts',
    'engine launch flags exist in the installed CLI (#731) > antigravity > launch mode "sandbox" uses args the installed CLI accepts',
    'engine launch flags exist in the installed CLI (#731) > antigravity > launch mode "bypassPermissions" uses args the installed CLI accepts',
    'engine launch flags exist in the installed CLI (#731) > claude > launch mode "acceptEdits" uses args the installed CLI accepts',
    'engine launch flags exist in the installed CLI (#731) > claude > launch mode "plan" uses args the installed CLI accepts',
    'engine launch flags exist in the installed CLI (#731) > claude > launch mode "auto" uses args the installed CLI accepts',
    'engine launch flags exist in the installed CLI (#731) > claude > launch mode "bypassPermissions" uses args the installed CLI accepts',
    'engine launch flags exist in the installed CLI (#731) > codex > launch mode "fullAuto" uses args the installed CLI accepts',
    'engine launch flags exist in the installed CLI (#731) > codex > launch mode "bypassPermissions" uses args the installed CLI accepts',
    'engine launch flags exist in the installed CLI (#731) > actually probed something, or says plainly that it did not',
    'C1 — per-project plugin migration (#262) > engines.PRAWDUCT_INSTALL_REFERENCE > matches the installed plugin’s INSTALL_REFERENCE (skipped when not installed)',
    'classifyIngressState > classifies THIS machine\'s live Caddyfile as protected, when one is present',
    'ttyd-watcher > production runner smoke test (darwin only) > _isPtyPoolExhausted returns finite values when run against the real host shell',
    'ttyd-watcher > production runner smoke test (darwin only) > _countTtydZombies returns a finite non-negative count against the real host shell',
    'lib/wrap-steps/_date.todayIsoLocal (shared helper extraction) > local vs UTC behavior > returns LOCAL date (not UTC) when the host is in a non-UTC zone',
    'wrap-step version-bump — pure helpers (open-queue #3, post-#139) > _todayIsoLocal (#205 — local-zoned date) > returns LOCAL date (not UTC) when the host is in a non-UTC zone (#205 bug-distinguishing pin)',
    'wrap-step features-toc (#207 Chunk 3) > _todayIsoLocal (#205 parity — local-zoned date) > returns LOCAL date (not UTC) when the host is in a non-UTC zone',
    // Skips on macOS, runs on the Linux runner — listed so a case-insensitive
    // CI host would not read it as an unknown skip.
    'projects > updateProject > rename — case-insensitive collision handling (#221, sibling to #188) > allows a case-only self-rename at the DB-validator level (foo-1 → Foo-1)'
  ];

  it('compiles — every entry carries id, match, why and runsWhere, ids unique', () => {
    const entries = skipAudit.compileLedger(ledger);
    assert.ok(entries.length > 0);
  });

  it('covers every known CI skip', () => {
    const entries = skipAudit.compileLedger(ledger);
    const result = skipAudit.audit({
      total: CI_SKIPS.length + 1,
      skipped: CI_SKIPS.map((p) => ({ path: p, kind: 'skipped', message: '' }))
    }, entries);
    assert.deepEqual(result.unknown.map((u) => u.path), [], 'a known CI skip has no ledger entry');
    assert.equal(result.ok, true);
  });

  it('is not a wildcard — a test outside every tier is still unknown', () => {
    const entries = skipAudit.compileLedger(ledger);
    const strangers = [
      'sessions > launchSession > adopts an orphaned tmux session',
      'engine launch flags exist in the installed CLI (#731) > claude > some new unrelated probe',
      'ttyd-watcher > lifecycle > start() is a no-op on non-darwin platforms'
    ];
    const result = skipAudit.audit({
      total: strangers.length,
      skipped: strangers.map((p) => ({ path: p, kind: 'skipped', message: '' }))
    }, entries);
    assert.deepEqual(result.unknown.map((u) => u.path), strangers);
  });

  it('every entry names a place the test actually runs — a skip with nowhere to run is a test nobody executes', () => {
    for (const e of ledger.entries) {
      assert.ok(e.runsWhere.length > 20, `${e.id}: runsWhere is too thin to name a host: "${e.runsWhere}"`);
    }
  });
});

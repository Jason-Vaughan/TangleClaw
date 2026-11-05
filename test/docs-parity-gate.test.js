'use strict';

/**
 * `lib/docs-parity-gate.js` + `scripts/docs-parity-gate.js` (#533).
 *
 * `evaluate` is exercised directly for the gate's rules; the CLI is
 * exercised end to end over the `--files`/`--body-file` test seam, so the
 * argument parsing and exit codes are covered with no network call to `gh`.
 * Unlike `scripts/changelog-fragment-gate.js`, every judged run exits 0 —
 * the signal is non-blocking by design (#533's own acceptance criterion).
 */

const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const gate = require('../lib/docs-parity-gate');
const cli = require('../scripts/docs-parity-gate.js');
const exec = require('../lib/exec');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'docs-parity-gate.js');

describe('the declared constants match what isUserFacingPath/isDocsPath/userFacingFragmentType actually use', () => {
  it('names the prefixes isUserFacingPath checks', () => {
    assert.deepEqual([...gate.USER_FACING_PREFIXES], ['public/', 'lib/routes/']);
    for (const prefix of gate.USER_FACING_PREFIXES) assert.equal(gate.isUserFacingPath(`${prefix}anything.js`), true, prefix);
  });

  it('names the prefixes, suffix and files isDocsPath checks', () => {
    assert.deepEqual([...gate.DOCS_PREFIXES], ['docs/']);
    assert.equal(gate.DOCS_SUFFIX, '.md');
    assert.deepEqual([...gate.DOCS_FILES], ['README.md']);
    for (const prefix of gate.DOCS_PREFIXES) {
      assert.equal(gate.isDocsPath(`${prefix}anything${gate.DOCS_SUFFIX}`), true, prefix);
      assert.equal(gate.isDocsPath(`${prefix}anything.json`), false, `${prefix}anything.json`);
    }
    for (const file of gate.DOCS_FILES) assert.equal(gate.isDocsPath(file), true, file);
  });

  it('names the changelog fragment types userFacingFragmentType treats as user-visible', () => {
    assert.deepEqual([...gate.USER_FACING_FRAGMENT_TYPES], ['added', 'changed']);
    for (const type of gate.USER_FACING_FRAGMENT_TYPES) {
      assert.equal(gate.userFacingFragmentType(`changelog.d/1.x.${type}.md`), type, type);
    }
  });

  it('exposes the exact escape-line pattern evaluate uses', () => {
    assert.match('Docs: none a reason', gate.ESCAPE_LINE_RE);
    assert.doesNotMatch('Changelog: none a reason', gate.ESCAPE_LINE_RE);
  });
});

describe('isUserFacingPath / isDocsPath / userFacingFragmentType', () => {
  it('treats server.js, public/** and lib/routes/** as user-facing', () => {
    assert.equal(gate.isUserFacingPath('server.js'), true);
    assert.equal(gate.isUserFacingPath('public/setup.js'), true);
    assert.equal(gate.isUserFacingPath('lib/routes/sessions.js'), true);
    assert.equal(gate.isUserFacingPath('lib/store.js'), false);
    assert.equal(gate.isUserFacingPath('scripts/soak.js'), false);
  });

  it('treats README.md and markdown under docs/** as docs, nothing else', () => {
    assert.equal(gate.isDocsPath('README.md'), true);
    assert.equal(gate.isDocsPath('docs/user-guide.md'), true);
    assert.equal(gate.isDocsPath('docs/sub/dir/page.md'), true);
    assert.equal(gate.isDocsPath('readme.md'), false, 'case-sensitive, like git itself');
    assert.equal(gate.isDocsPath('lib/docs-parity-gate.js'), false);
  });

  it('does not treat docs/areas.json — registry metadata, not documentation — as a docs touch (I-Gate Round 1, #2890)', () => {
    assert.equal(gate.isDocsPath('docs/areas.json'), false);
    assert.equal(gate.isDocsPath('docs/anything.json'), false);
    assert.equal(gate.isDocsPath('docs/anything.toml'), false);
  });

  it('a user-facing change touching only docs/areas.json still signals: the registry edit is not a docs touch', () => {
    const v = gate.evaluate(['public/setup.js', 'docs/areas.json'], '');
    assert.equal(v.signal, true);
    assert.deepEqual(v.docsFiles, []);
  });

  it('reads a changelog fragment\'s type only when the name parses and the type is user-visible', () => {
    assert.equal(gate.userFacingFragmentType('changelog.d/533.docs-parity-gate.added.md'), 'added');
    assert.equal(gate.userFacingFragmentType('changelog.d/1.x.changed.md'), 'changed');
    assert.equal(gate.userFacingFragmentType('changelog.d/1.x.fixed.md'), null, 'fixed is patch-tier, not user-visible here');
    assert.equal(gate.userFacingFragmentType('changelog.d/1.x.internal.md'), null);
    assert.equal(gate.userFacingFragmentType('changelog.d/not-a-fragment.txt'), null, 'malformed names are not this gate\'s to judge');
    assert.equal(gate.userFacingFragmentType('lib/store.js'), null);
  });
});

describe('evaluate', () => {
  it('is clear, no signal, when nothing user-facing changed', () => {
    const v = gate.evaluate(['lib/store.js', 'test/store.test.js'], '');
    assert.equal(v.ok, true);
    assert.equal(v.signal, false);
    assert.match(v.reason, /no docs touch asked for/);
  });

  it('is clear when a user-facing file changes alongside a docs touch', () => {
    const v = gate.evaluate(['public/setup.js', 'docs/user-guide.md'], '');
    assert.equal(v.signal, false);
    assert.match(v.reason, /docs touched alongside/);
  });

  it('signals when a user-facing file changes with no docs touch and no escape', () => {
    const v = gate.evaluate(['public/setup.js'], 'just a description');
    assert.equal(v.ok, true, 'non-blocking: ok is always true');
    assert.equal(v.signal, true);
    assert.deepEqual(v.userFacingFiles, ['public/setup.js']);
  });

  it('a user-visible changelog fragment alone also signals', () => {
    const v = gate.evaluate(['changelog.d/533.x.added.md'], '');
    assert.equal(v.signal, true);
    assert.deepEqual(v.userFacingFragments, [{ path: 'changelog.d/533.x.added.md', type: 'added' }]);
  });

  it('a patch-tier fragment (fixed/internal) alone never signals', () => {
    assert.equal(gate.evaluate(['changelog.d/1.x.fixed.md'], '').signal, false);
    assert.equal(gate.evaluate(['changelog.d/1.x.internal.md'], '').signal, false);
  });

  it('the Docs: none escape line, with a reason, clears the signal', () => {
    const v = gate.evaluate(['public/setup.js'], 'tweak\n\nDocs: none internal refactor, no visible change\n');
    assert.equal(v.signal, false);
    assert.match(v.reason, /escaped: Docs: none/);
  });

  it('the escape line with no reason does not clear the signal', () => {
    const v = gate.evaluate(['public/setup.js'], 'Docs: none\n');
    assert.equal(v.signal, true);
  });

  it('tolerates a non-array files argument and a non-string body', () => {
    assert.equal(gate.evaluate(null, null).signal, false);
    assert.equal(gate.evaluate(undefined, undefined).ok, true);
  });
});

describe('dismissSignal', () => {
  it('records by and reason, and carries the original verdict fields forward', () => {
    const v = gate.evaluate(['public/setup.js'], '');
    const d = gate.dismissSignal(v, { by: 'operator', reason: 'internal-only change, nothing user-visible' });
    assert.equal(d.ok, true);
    assert.equal(d.dismissed, true);
    assert.equal(d.dismissedBy, 'operator');
    assert.equal(d.dismissedReason, 'internal-only change, nothing user-visible');
    assert.ok(d.dismissedAt);
    assert.deepEqual(d.userFacingFiles, v.userFacingFiles);
  });

  it('refuses to dismiss a verdict that never signalled', () => {
    const v = gate.evaluate(['lib/store.js'], '');
    assert.equal(gate.dismissSignal(v, { by: 'x', reason: 'y' }).code, 'NOT_SIGNALED');
  });

  it('requires both by and reason, non-blank', () => {
    const v = gate.evaluate(['public/setup.js'], '');
    assert.equal(gate.dismissSignal(v, { reason: 'y' }).code, 'INVALID_INPUT');
    assert.equal(gate.dismissSignal(v, { by: 'x' }).code, 'INVALID_INPUT');
    assert.equal(gate.dismissSignal(v, { by: '  ', reason: 'y' }).code, 'INVALID_INPUT');
  });
});

describe('checkScreenshotStaleness', () => {
  it('is stale when the screenshot marker predates the last UI ship', () => {
    const r = gate.checkScreenshotStaleness({ screenshotsAsOf: '2026-03-30T00:00:00Z', lastUiShipAt: '2026-07-10T00:00:00Z' });
    assert.equal(r.stale, true);
    assert.match(r.reason, /before the last UI ship/);
  });

  it('is not stale at or after the last UI ship', () => {
    assert.equal(gate.checkScreenshotStaleness({ screenshotsAsOf: '2026-07-10T00:00:00Z', lastUiShipAt: '2026-07-10T00:00:00Z' }).stale, false);
    assert.equal(gate.checkScreenshotStaleness({ screenshotsAsOf: '2026-08-01T00:00:00Z', lastUiShipAt: '2026-07-10T00:00:00Z' }).stale, false);
  });

  it('is not stale, and says why, on an unreadable timestamp rather than throwing', () => {
    const r = gate.checkScreenshotStaleness({ screenshotsAsOf: 'not a date', lastUiShipAt: '2026-07-10T00:00:00Z' });
    assert.equal(r.stale, false);
    assert.match(r.reason, /not a readable timestamp/);
  });
});

describe('readFromGh — paginated file lists (I-Gate Round 1, #2890)', () => {
  /**
   * One `gh api ... --paginate` "page": a JSON array of file-change objects.
   * @param {string[]} filenames - Filenames for this page.
   * @returns {object[]}
   */
  function page(filenames) {
    return filenames.map((filename) => ({ filename, status: 'modified' }));
  }

  it('flattens two slurped pages into one file list, and passes --slurp alongside --paginate', async () => {
    const calls = [];
    const execMock = mock.method(exec, 'execFileArgs', async (file, args) => {
      calls.push(args);
      if (args.some((a) => a.includes('pulls/42/files'))) {
        return { exitCode: 0, stdout: JSON.stringify([page(['a.js', 'b.js']), page(['c.js'])]), stderr: '' };
      }
      return { exitCode: 0, stdout: JSON.stringify({ body: 'a body' }), stderr: '' };
    });
    try {
      const result = await cli.readFromGh('42');
      assert.deepEqual(result.files, ['a.js', 'b.js', 'c.js']);
      assert.equal(result.body, 'a body');
      const filesCall = calls.find((a) => a.some((x) => x.includes('pulls/42/files')));
      assert.ok(filesCall.includes('--paginate'), filesCall.join(' '));
      assert.ok(filesCall.includes('--slurp'), filesCall.join(' '));
    } finally {
      execMock.mock.restore();
    }
  });

  it('flattens a single slurped page the same way (gh wraps every page, one included)', async () => {
    const execMock = mock.method(exec, 'execFileArgs', async (file, args) => {
      if (args.some((a) => a.includes('pulls/7/files'))) {
        return { exitCode: 0, stdout: JSON.stringify([page(['only.js'])]), stderr: '' };
      }
      return { exitCode: 0, stdout: JSON.stringify({ body: null }), stderr: '' };
    });
    try {
      const result = await cli.readFromGh('7');
      assert.deepEqual(result.files, ['only.js']);
      assert.equal(result.body, '');
    } finally {
      execMock.mock.restore();
    }
  });

  it('throws Unreadable, not a raw JSON.parse error, when gh does not answer with slurped page arrays', async () => {
    const execMock = mock.method(exec, 'execFileArgs', async () => ({ exitCode: 0, stdout: JSON.stringify({ not: 'an array of pages' }), stderr: '' }));
    try {
      await assert.rejects(() => cli.readFromGh('1'), cli.Unreadable);
    } finally {
      execMock.mock.restore();
    }
  });

  it('throws Unreadable on the pre-fix failure mode too: concatenated raw JSON from a bare --paginate would not even parse', async () => {
    // Guards against silently reverting to the unslurped call: two raw concatenated arrays
    // are not one JSON document, so a naive JSON.parse must fail — this is the exact shape
    // the Round 1 finding reproduced.
    assert.throws(() => JSON.parse(`${JSON.stringify(page(['a.js']))}${JSON.stringify(page(['b.js']))}`));
  });
});

describe('docs-parity-gate: the CLI over the --files/--body-file seam', () => {
  /**
   * @param {string[]} files - Changed paths.
   * @param {string} body - PR body text.
   * @returns {{status: number, out: string}}
   */
  function run(files, body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-parity-gate-'));
    try {
      const filesPath = path.join(dir, 'files.json');
      const bodyFilePath = path.join(dir, 'body.txt');
      fs.writeFileSync(filesPath, JSON.stringify(files));
      fs.writeFileSync(bodyFilePath, body);
      const res = spawnSync(process.execPath, [SCRIPT, '--files', filesPath, '--body-file', bodyFilePath], { encoding: 'utf8' });
      return { status: res.status, out: `${res.stdout}${res.stderr}` };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('exits 0 and says clear when nothing user-facing changed', () => {
    const { status, out } = run(['lib/store.js'], '');
    assert.equal(status, 0, out);
    assert.ok(out.includes('clear'), out);
  });

  it('exits 0 even when the signal fires: non-blocking by design', () => {
    const { status, out } = run(['public/setup.js'], '');
    assert.equal(status, 0, out);
    assert.ok(out.includes('signal'), out);
    assert.ok(out.includes('non-blocking'), out);
  });

  it('exits 0 when the escape line clears the signal', () => {
    const { status, out } = run(['public/setup.js'], 'Docs: none no visible change\n');
    assert.equal(status, 0, out);
    assert.ok(out.includes('clear'), out);
  });

  it('writes a GITHUB_STEP_SUMMARY line when the signal fires and the env var is set, but still exits 0', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-parity-gate-summary-'));
    try {
      const filesPath = path.join(dir, 'files.json');
      const bodyFilePath = path.join(dir, 'body.txt');
      const summaryPath = path.join(dir, 'summary.md');
      fs.writeFileSync(filesPath, JSON.stringify(['public/setup.js']));
      fs.writeFileSync(bodyFilePath, '');
      fs.writeFileSync(summaryPath, '');
      const res = spawnSync(process.execPath, [SCRIPT, '--files', filesPath, '--body-file', bodyFilePath],
        { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath } });
      assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
      assert.match(fs.readFileSync(summaryPath, 'utf8'), /docs-parity-gate.*public\/setup\.js/s);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 4 when --files holds something unreadable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-parity-gate-'));
    try {
      const filesPath = path.join(dir, 'missing.json');
      const bodyFilePath = path.join(dir, 'body.txt');
      fs.writeFileSync(bodyFilePath, '');
      const res = spawnSync(process.execPath, [SCRIPT, '--files', filesPath, '--body-file', bodyFilePath], { encoding: 'utf8' });
      assert.equal(res.status, 4, `${res.stdout}${res.stderr}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 4 with neither --pr nor the --files/--body-file pair', () => {
    const res = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(res.status, 4, `${res.stdout}${res.stderr}`);
  });
});

describe('parseArgs', () => {
  it('accepts --pr alone, and --files + --body-file together', () => {
    assert.deepEqual(cli.parseArgs(['--pr', '42']), { pr: '42', filesPath: null, bodyFilePath: null });
    assert.deepEqual(cli.parseArgs(['--files', 'a.json', '--body-file', 'b.txt']), { pr: null, filesPath: 'a.json', bodyFilePath: 'b.txt' });
  });

  it('refuses no arguments, both forms at once, or an incomplete pair', () => {
    assert.throws(() => cli.parseArgs([]));
    assert.throws(() => cli.parseArgs(['--pr', '1', '--files', 'a.json', '--body-file', 'b.txt']));
    assert.throws(() => cli.parseArgs(['--files', 'a.json']));
  });

  it('refuses an unrecognized flag, and a flag missing its value', () => {
    assert.throws(() => cli.parseArgs(['--nope', 'x']));
    assert.throws(() => cli.parseArgs(['--pr']));
  });
});

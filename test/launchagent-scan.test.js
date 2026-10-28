'use strict';

/*
 * #1148 — a project rename leaves user LaunchAgents pointing at the old path.
 *
 * The scanner is the load-bearing half: it must find the path wherever a
 * plist keeps it (ProgramArguments, WorkingDirectory, stdout/stderr paths),
 * must NOT match a sibling whose name merely starts with it, must never
 * throw (the rename has already happened on disk when it runs), and must
 * report a plist it could not read as unread rather than as a non-match.
 *
 * The surfacing half — the route merging the result's `warnings` onto the
 * wire and the dashboard rendering them somewhere the operator sees — is
 * pinned by source probes at the bottom, the documented scope limit of the
 * zero-dep / no-browser-harness choice (same pattern as
 * create-project-modal.test.js). The route's wire shape itself is exercised
 * for real in api-projects.test.js.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scan = require('../lib/launchagent-scan');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/**
 * Write a minimal XML LaunchAgent plist.
 * @param {string} dir - Directory to write into.
 * @param {string} name - File name (with or without `.plist`).
 * @param {object} keys - `{ Label, ProgramArguments: string[], WorkingDirectory, StandardOutPath }`; omit any.
 * @returns {string} The written file's absolute path.
 */
function writePlist(dir, name, keys) {
  const file = path.join(dir, name.endsWith('.plist') ? name : `${name}.plist`);
  const body = [];
  if (keys.Label) body.push(`  <key>Label</key>\n  <string>${keys.Label}</string>`);
  if (keys.ProgramArguments) {
    body.push('  <key>ProgramArguments</key>\n  <array>'
      + keys.ProgramArguments.map(a => `\n    <string>${a}</string>`).join('')
      + '\n  </array>');
  }
  if (keys.WorkingDirectory) body.push(`  <key>WorkingDirectory</key>\n  <string>${keys.WorkingDirectory}</string>`);
  if (keys.StandardOutPath) body.push(`  <key>StandardOutPath</key>\n  <string>${keys.StandardOutPath}</string>`);
  fs.writeFileSync(file,
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0">\n<dict>\n' + body.join('\n') + '\n</dict>\n</plist>\n');
  return file;
}

describe('launchagent-scan (#1148)', () => {
  let dir;
  const OLD = '/Users/me/Projects/calendar-sync';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-la-scan-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('scanLaunchAgents', () => {
    it('finds the path in ProgramArguments and reports the job label and file', () => {
      const file = writePlist(dir, 'com.example.calendar-sync', {
        Label: 'com.example.calendar-sync',
        ProgramArguments: ['/usr/bin/swift', `${OLD}/scripts/sync.swift`, '--apply']
      });
      const result = scan.scanLaunchAgents(OLD, dir);
      assert.deepEqual(result, { matches: [{ file, label: 'com.example.calendar-sync' }], unreadable: [] });
    });

    it('finds the path when it appears only in WorkingDirectory', () => {
      writePlist(dir, 'com.example.wd', { Label: 'com.example.wd', ProgramArguments: ['/bin/sh', 'run.sh'], WorkingDirectory: OLD });
      assert.equal(scan.scanLaunchAgents(OLD, dir).matches.length, 1);
    });

    it('finds the path when it appears only in a log path', () => {
      writePlist(dir, 'com.example.log', { Label: 'com.example.log', ProgramArguments: ['/bin/true'], StandardOutPath: `${OLD}/logs/out.log` });
      assert.equal(scan.scanLaunchAgents(OLD, dir).matches.length, 1);
    });

    it('returns no match when no plist names the path', () => {
      writePlist(dir, 'com.example.other', { Label: 'com.example.other', ProgramArguments: ['/Users/me/Projects/other/run.sh'] });
      assert.deepEqual(scan.scanLaunchAgents(OLD, dir), { matches: [], unreadable: [] });
    });

    it('does not match a sibling whose name merely starts with the path', () => {
      writePlist(dir, 'com.example.sibling', { Label: 'com.example.sibling', WorkingDirectory: `${OLD}-2` });
      writePlist(dir, 'com.example.sibling-dot', { Label: 'com.example.sibling-dot', WorkingDirectory: `${OLD}.bak` });
      // A space or a non-ASCII character is also a sibling's suffix; a
      // character-class denylist let both of these through.
      writePlist(dir, 'com.example.sibling-space', { Label: 'com.example.sibling-space', WorkingDirectory: `${OLD} (old)` });
      writePlist(dir, 'com.example.sibling-unicode', { Label: 'com.example.sibling-unicode', WorkingDirectory: `${OLD}日本` });
      assert.deepEqual(scan.scanLaunchAgents(OLD, dir).matches, []);
    });

    it('matches a path boundary: a directory beneath the path, the closing tag, a quote, or end of line', () => {
      writePlist(dir, 'a-prefix', { WorkingDirectory: `${OLD}/sub` });
      writePlist(dir, 'b-exact', { WorkingDirectory: OLD });
      writePlist(dir, 'c-quoted', { ProgramArguments: ['/bin/sh', '-c', `cd "${OLD}" &amp;&amp; ./run.sh`] });
      writePlist(dir, 'd-single-quoted', { ProgramArguments: ['/bin/sh', '-c', `cd '${OLD}'`] });
      fs.writeFileSync(path.join(dir, 'e-eol.plist'), `${OLD}\nmore\n`);
      assert.deepEqual(scan.scanLaunchAgents(OLD, dir).matches.map(m => m.label),
        ['a-prefix', 'b-exact', 'c-quoted', 'd-single-quoted', 'e-eol']);
    });

    it('is case-sensitive and does not read an unquoted path followed by a space in a one-liner (documented limits)', () => {
      writePlist(dir, 'com.example.case', { WorkingDirectory: OLD.toUpperCase() });
      writePlist(dir, 'com.example.unquoted', { ProgramArguments: ['/bin/sh', '-c', `cd ${OLD} &amp;&amp; ./run.sh`] });
      assert.deepEqual(scan.scanLaunchAgents(OLD, dir).matches, []);
    });

    it('ignores files that are not plists', () => {
      fs.writeFileSync(path.join(dir, 'notes.txt'), OLD);
      fs.writeFileSync(path.join(dir, 'com.example.plist.bak'), OLD);
      assert.deepEqual(scan.scanLaunchAgents(OLD, dir).matches, []);
    });

    it('falls back to the file basename as the label when the plist has no Label key', () => {
      writePlist(dir, 'com.example.nolabel', { ProgramArguments: [`${OLD}/run.sh`] });
      assert.equal(scan.scanLaunchAgents(OLD, dir).matches[0].label, 'com.example.nolabel');
    });

    it('treats a regex metacharacter in the path literally', () => {
      const odd = '/Users/me/Projects/app (v2)+beta';
      writePlist(dir, 'com.example.odd', { WorkingDirectory: odd });
      writePlist(dir, 'com.example.notodd', { WorkingDirectory: '/Users/me/Projects/app v2beta' });
      assert.equal(scan.scanLaunchAgents(odd, dir).matches.length, 1);
    });

    it('returns an empty result, without throwing, when the directory is absent', () => {
      const missing = path.join(dir, 'no', 'such', 'LaunchAgents');
      assert.deepEqual(scan.scanLaunchAgents(OLD, missing), { matches: [], unreadable: [] });
      assert.deepEqual(scan.scanForPath(OLD, missing), []);
    });

    it('returns an empty result for a missing or empty needle or directory', () => {
      assert.deepEqual(scan.scanLaunchAgents('', dir), { matches: [], unreadable: [] });
      assert.deepEqual(scan.scanLaunchAgents(undefined, dir), { matches: [], unreadable: [] });
      assert.deepEqual(scan.scanLaunchAgents(OLD, ''), { matches: [], unreadable: [] });
      assert.deepEqual(scan.scanLaunchAgents(OLD, null), { matches: [], unreadable: [] });
    });

    it('lists a plist it cannot read under unreadable instead of counting it as a non-match', () => {
      // A directory wearing a .plist name fails readFileSync with EISDIR on
      // every platform and for every uid — unlike chmod 000, which root
      // ignores — so the "could not read" branch is exercised deterministically.
      const bogus = path.join(dir, 'com.example.unreadable.plist');
      fs.mkdirSync(bogus);
      const good = writePlist(dir, 'com.example.good', { Label: 'com.example.good', WorkingDirectory: OLD });
      const result = scan.scanLaunchAgents(OLD, dir);
      assert.deepEqual(result.matches, [{ file: good, label: 'com.example.good' }]);
      assert.deepEqual(result.unreadable, [bogus]);
    });
  });

  describe('scanForPath', () => {
    it('is the matches array of scanLaunchAgents', () => {
      const file = writePlist(dir, 'com.example.one', { Label: 'com.example.one', WorkingDirectory: OLD });
      assert.deepEqual(scan.scanForPath(OLD, dir), [{ file, label: 'com.example.one' }]);
    });
  });

  describe('formatWarning', () => {
    it('is null when nothing matched and everything was readable', () => {
      assert.equal(scan.formatWarning(OLD, { matches: [], unreadable: [] }), null);
      assert.equal(scan.formatWarning(OLD, null), null);
    });

    it('counts the jobs, names each label and plist, and says the plists were not rewritten', () => {
      const msg = scan.formatWarning(OLD, {
        matches: [
          { file: '/Users/me/Library/LaunchAgents/com.a.plist', label: 'com.a' },
          { file: '/Users/me/Library/LaunchAgents/com.b.plist', label: 'com.b' }
        ],
        unreadable: []
      });
      assert.match(msg, /^2 LaunchAgents still reference the old path \/Users\/me\/Projects\/calendar-sync: /);
      assert.match(msg, /com\.a \(\/Users\/me\/Library\/LaunchAgents\/com\.a\.plist\)/);
      assert.match(msg, /com\.b \(\/Users\/me\/Library\/LaunchAgents\/com\.b\.plist\)/);
      assert.match(msg, /does not rewrite LaunchAgents/);
      assert.match(msg, /docs\/macos-tcc-automations\.md/);
    });

    it('uses the singular for one job', () => {
      const msg = scan.formatWarning(OLD, { matches: [{ file: '/x/com.a.plist', label: 'com.a' }], unreadable: [] });
      assert.match(msg, /^1 LaunchAgent still references the old path /);
    });

    it('names an unreadable plist as one that may also reference the path', () => {
      const msg = scan.formatWarning(OLD, { matches: [], unreadable: ['/x/com.locked.plist'] });
      assert.match(msg, /1 LaunchAgent plist could not be read and may also reference it: \/x\/com\.locked\.plist/);
      assert.doesNotMatch(msg, /still reference/);
    });
  });

  describe('readWorkingDirectory (#1369)', () => {
    it('extracts the WorkingDirectory string', () => {
      const file = writePlist(dir, 'com.tangleclaw.server', { Label: 'com.tangleclaw.server', WorkingDirectory: OLD });
      assert.equal(scan.readWorkingDirectory(fs.readFileSync(file, 'utf8')), OLD);
    });

    it('is null when the key is absent', () => {
      const file = writePlist(dir, 'no-wd', { Label: 'no-wd', ProgramArguments: ['/bin/true'] });
      assert.equal(scan.readWorkingDirectory(fs.readFileSync(file, 'utf8')), null);
    });

    it('is null for non-string input, never throwing', () => {
      assert.equal(scan.readWorkingDirectory(undefined), null);
      assert.equal(scan.readWorkingDirectory(null), null);
      assert.equal(scan.readWorkingDirectory(42), null);
    });
  });

  describe('auditStartupPaths (#1369)', () => {
    const CWD = '/Users/op/Projects/tangleclaw';

    it('reports no mismatch, and scans nothing, when no server plist exists', () => {
      const audit = scan.auditStartupPaths({ cwd: CWD, launchAgentsDir: dir });
      assert.equal(audit.mismatched, false);
      assert.equal(audit.plistWorkingDir, null);
      assert.deepEqual(audit.matches, []);
    });

    it('reports no mismatch when the plist WorkingDirectory matches cwd', () => {
      writePlist(dir, 'com.tangleclaw.server', { Label: 'com.tangleclaw.server', WorkingDirectory: CWD });
      const audit = scan.auditStartupPaths({ cwd: CWD, launchAgentsDir: dir });
      assert.equal(audit.mismatched, false);
    });

    it('flags a mismatch and scans the OLD WorkingDirectory against the LaunchAgents dir', () => {
      const file = writePlist(dir, 'com.tangleclaw.server', { Label: 'com.tangleclaw.server', WorkingDirectory: OLD });
      writePlist(dir, 'com.example.other', { Label: 'com.example.other', WorkingDirectory: OLD });
      const audit = scan.auditStartupPaths({ cwd: CWD, launchAgentsDir: dir });
      assert.equal(audit.mismatched, true);
      assert.equal(audit.plistWorkingDir, OLD);
      assert.equal(audit.plistFile, file);
      // Both the server's own plist and the other LaunchAgent still name OLD.
      assert.deepEqual(audit.matches.map((m) => m.label).sort(),
        ['com.example.other', 'com.tangleclaw.server']);
    });

    it('names a config path still under the old WorkingDirectory as a configMatch', () => {
      writePlist(dir, 'com.tangleclaw.server', { Label: 'com.tangleclaw.server', WorkingDirectory: OLD });
      const audit = scan.auditStartupPaths({
        cwd: CWD, launchAgentsDir: dir,
        config: { httpsCertPath: `${OLD}/certs/cert.pem`, httpsKeyPath: '/elsewhere/key.pem' }
      });
      assert.deepEqual(audit.configMatches, [{ key: 'httpsCertPath', value: `${OLD}/certs/cert.pem` }]);
    });

    it('does not flag a config path merely prefixed by the old path (boundary rule)', () => {
      writePlist(dir, 'com.tangleclaw.server', { Label: 'com.tangleclaw.server', WorkingDirectory: OLD });
      const audit = scan.auditStartupPaths({
        cwd: CWD, launchAgentsDir: dir,
        config: { httpsCertPath: `${OLD}-2/cert.pem` }
      });
      assert.deepEqual(audit.configMatches, []);
    });

    it('flags a config path whose file AND parent directory are both gone, independent of any plist', () => {
      const missingDir = path.join(dir, 'gone', 'certs');
      const audit = scan.auditStartupPaths({
        cwd: CWD, launchAgentsDir: dir,
        config: { httpsCertPath: path.join(missingDir, 'cert.pem') }
      });
      assert.deepEqual(audit.staleConfigPaths, [{ key: 'httpsCertPath', value: path.join(missingDir, 'cert.pem') }]);
    });

    it('does not flag a config path whose file is missing but whose parent directory still exists', () => {
      // The file simply hasn't been issued yet — not evidence of a move.
      const audit = scan.auditStartupPaths({
        cwd: CWD, launchAgentsDir: dir,
        config: { httpsCertPath: path.join(dir, 'not-yet-issued.pem') }
      });
      assert.deepEqual(audit.staleConfigPaths, []);
    });

    it('never throws on a missing LaunchAgentsDir, a bad config shape, or missing args', () => {
      assert.doesNotThrow(() => scan.auditStartupPaths());
      assert.doesNotThrow(() => scan.auditStartupPaths({ cwd: CWD, launchAgentsDir: path.join(dir, 'nope'), config: 'not-an-object' }));
    });

    it('treats an unreadable server plist the same as an absent one', () => {
      const bogus = path.join(dir, 'com.tangleclaw.server.plist');
      fs.mkdirSync(bogus);
      const audit = scan.auditStartupPaths({ cwd: CWD, launchAgentsDir: dir });
      assert.equal(audit.mismatched, false);
      assert.equal(audit.plistFile, null);
    });
  });

  describe('formatStartupWarning (#1369)', () => {
    it('is null when nothing is mismatched or stale', () => {
      assert.equal(scan.formatStartupWarning({ mismatched: false, staleConfigPaths: [] }), null);
      assert.equal(scan.formatStartupWarning(null), null);
    });

    it('names the mismatched WorkingDirectory, the plist, and every affected LaunchAgent', () => {
      const msg = scan.formatStartupWarning({
        mismatched: true,
        plistFile: '/Users/op/Library/LaunchAgents/com.tangleclaw.server.plist',
        plistWorkingDir: OLD,
        cwd: '/Users/op/Projects/tangleclaw',
        matches: [{ file: '/Users/op/Library/LaunchAgents/com.tangleclaw.server.plist', label: 'com.tangleclaw.server' }],
        unreadable: [],
        configMatches: [],
        staleConfigPaths: []
      });
      assert.match(msg, /still names WorkingDirectory \/Users\/me\/Projects\/calendar-sync/);
      assert.match(msg, /running from \/Users\/op\/Projects\/tangleclaw/);
      assert.match(msg, /com\.tangleclaw\.server/);
    });

    it('names a stale config.json path even with no plist mismatch', () => {
      const msg = scan.formatStartupWarning({
        mismatched: false, matches: [], unreadable: [], configMatches: [],
        staleConfigPaths: [{ key: 'httpsCertPath', value: '/old/certs/cert.pem' }]
      });
      assert.match(msg, /config\.json names a path whose directory no longer exists: httpsCertPath \(\/old\/certs\/cert\.pem\)/);
    });

    it('names a config.json path still under the old WorkingDirectory', () => {
      const msg = scan.formatStartupWarning({
        mismatched: true, plistFile: '/x/com.tangleclaw.server.plist', plistWorkingDir: OLD, cwd: '/new/path',
        matches: [], unreadable: [], staleConfigPaths: [],
        configMatches: [{ key: 'httpsKeyPath', value: `${OLD}/key.pem` }]
      });
      assert.match(msg, /config\.json still points at the old path: httpsKeyPath \(\/Users\/me\/Projects\/calendar-sync\/key\.pem\)/);
    });
  });

  describe('the warning reaches the operator (source probes)', () => {
    it('server.js audits startup paths at boot and logs the warning (#1369)', () => {
      const src = read('server.js');
      assert.match(src, /^\s*const startupAudit = launchAgentScan\.auditStartupPaths\(\{$/m);
      assert.match(src, /^\s*cwd: __dirname,$/m);
      assert.match(src, /^\s*launchAgentsDir: launchAgentScan\.defaultLaunchAgentsDir\(\),$/m);
      assert.match(src, /^\s*if \(startupWarning\) log\.warn\(startupWarning\);$/m);
    });

    it('the rename branch of updateProject scans the OLD path against the real LaunchAgents dir and pushes into warnings', () => {
      const src = read('lib/projects.js');
      // Anchored at line start so a commented-out statement does not satisfy
      // the probe (a mutation check found the unanchored form vacuous).
      assert.match(src, /^\s*const laScan = launchAgentScan\.scanLaunchAgents\(oldPath, launchAgentScan\.defaultLaunchAgentsDir\(\)\);$/m);
      assert.match(src, /^\s*warnings\.push\(laWarning\);$/m);
      assert.match(src, /^\s*return \{ project: updated, errors, warnings \};$/m);
    });

    it('PATCH /api/projects/:name merges result.warnings onto the response warnings field', () => {
      const src = read('server.js');
      assert.match(src, /result\.errors\.concat\(Array\.isArray\(result\.warnings\) \? result\.warnings : \[\]\)/);
    });

    it('the settings save renders res.warnings into a persistent banner, not a timed toast', () => {
      const ui = read('public/ui.js');
      const submit = ui.slice(ui.indexOf('async function _submitSettings('));
      const body = submit.slice(0, submit.indexOf('\n}\n'));
      assert.match(body, /renderSettingsWarnings\(res\.warnings\)/, '_submitSettings must hand the warnings to the renderer');
      // The renderer itself moved to `tcRenderSettingsWarnings` in
      // api-helper.js when the session page needed the same banner (#758), and
      // is now RUN in test/launch-time-only-warning.test.js — no-timer, set as
      // text, dismiss-clears — rather than grepped. What stays pinned here is
      // that this page still routes through it.
      const render = read('public/api-helper.js');
      const renderBody = render.slice(render.indexOf('function tcRenderSettingsWarnings('));
      assert.doesNotMatch(renderBody.slice(0, renderBody.indexOf('\n  }\n')), /setTimeout/,
        'a warning that names a file to edit must not auto-dismiss');
      assert.match(renderBody, /text\.textContent = list\.join/, 'warning text is set as text, never as HTML');
      // The banner's markup moved to `tcSettingsWarningsMarkup` at the same
      // time and for the same reason, so the dashboard now hosts it rather than
      // declaring it. What this page still owes is the host and the fill.
      const html = read('public/index.html');
      assert.match(html, /id="settingsWarningsHost"/, 'the dashboard must host the banner');
      assert.match(ui, /settingsWarningsHost[\s\S]{0,120}tcSettingsWarningsMarkup\(\)/,
        'and fill it from the shared builder');
      assert.match(render, /function tcSettingsWarningsMarkup\(\)[\s\S]{0,600}role="alert"/);
      for (const id of ['settingsWarningsBanner', 'settingsWarningsText', 'settingsWarningsDismissBtn']) {
        assert.match(render, new RegExp(`id="${id}"`), `the builder must emit ${id}`);
      }
    });
  });
});

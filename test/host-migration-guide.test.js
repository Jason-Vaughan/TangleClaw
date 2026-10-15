'use strict';

/*
 * The host-migration guide (`docs/host-migration.md`) is public, and it is
 * written from a real migration, so the values most likely to leak into it are
 * the ones a migration handles: tailnet names, tailnet and LAN addresses, home
 * directories, and session or launch ids. This linter fails on any of those
 * shapes, allowing only the guide's documented placeholders.
 *
 * It is deliberately shape-based and carries no list of this install's real
 * values: a list of names or addresses in a public repository is itself the
 * leak, and a hashed one is guessable when the values are low-entropy. The
 * check against an install's own values is a private scan, run outside the
 * repository before the guide is published.
 *
 * Every rule is also run against synthetic sentinels, so a rule that stops
 * matching fails here rather than passing a leak silently.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const hostCheck = require('../lib/host-check');

const REPO_ROOT = path.resolve(__dirname, '..');
const GUIDE = path.join(REPO_ROOT, 'docs', 'host-migration.md');

/** The one address the guide may show: a documented placeholder in the CGNAT range. */
const PLACEHOLDER_IP = '100.64.0.10';

/**
 * Whether a dotted-quad IPv4 address is in a private, CGNAT or link-local range.
 * @param {number[]} o - The four octets.
 * @returns {boolean}
 */
function isPrivateIpv4(o) {
  if (o[0] === 10) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;
  if (o[0] === 169 && o[1] === 254) return true;
  return false;
}

/**
 * Every privacy finding in a text: the rule that matched and what it matched.
 * @param {string} text - The text to lint.
 * @returns {{rule: string, match: string}[]}
 */
function lintGuide(text) {
  const findings = [];
  const add = (rule, match) => findings.push({ rule, match });

  for (const m of text.matchAll(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)/g)) {
    const octets = m.slice(1, 5).map(Number);
    if (octets.some((n) => n > 255)) continue;
    if (isPrivateIpv4(octets) && m[0] !== PLACEHOLDER_IP) add('private-ipv4', m[0]);
  }
  // Unique-local IPv6, which includes the tailnet's own fd7a:115c:a1e0::/48.
  for (const m of text.matchAll(/(?<![0-9a-f:])f[cd][0-9a-f]{2}:[0-9a-f:]*[0-9a-f]/gi)) add('private-ipv6', m[0]);

  // A tailnet name is allowed only when every label in it is a `<placeholder>`.
  for (const m of text.matchAll(/[A-Za-z0-9<>_-]+(?:\.[A-Za-z0-9<>_-]+)*\.ts\.net\b/gi)) {
    const labels = m[0].slice(0, -'.ts.net'.length).split('.');
    if (!labels.every((l) => /^<[a-z0-9-]+>$/.test(l))) add('tailnet-name', m[0]);
  }

  // A machine's mDNS name, which every certificate carries and which often holds a person's name.
  for (const m of text.matchAll(/[A-Za-z0-9<>_-]+(?:\.[A-Za-z0-9<>_-]+)*\.local\b/gi)) {
    const labels = m[0].slice(0, -'.local'.length).split('.');
    if (!labels.every((l) => /^<[a-z0-9-]+>$/.test(l))) add('mdns-name', m[0]);
  }

  for (const m of text.matchAll(/\/(?:Users|home)\/[^\s/`'")<]+|[A-Za-z]:\\Users\\[^\s\\`'")]+/g)) add('home-path', m[0]);

  for (const m of text.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) add('uuid', m[0]);
  // A launch id or publication id: 22 base64url characters with mixed case and a digit.
  for (const m of text.matchAll(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/g)) {
    if (/[a-z]/.test(m[0]) && /[A-Z]/.test(m[0]) && /\d/.test(m[0])) add('launch-id', m[0]);
  }
  // A switchboard workspace id: a name followed by eight hex characters.
  for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-([0-9a-f]{8})\b/g)) {
    if (/\d/.test(m[1])) add('workspace-id', m[0]);
  }
  return findings;
}

describe('host-migration guide privacy linter (#1380)', () => {
  it('flags every leak shape it is meant to catch', () => {
    const sentinels = {
      'private-ipv4': ['100.101.102.103', '10.0.0.5', '172.20.1.1', '192.168.1.20', '169.254.10.20', '100.64.0.11'],
      'private-ipv6': ['fd7a:115c:a1e0::1', 'fc00::abcd'],
      'tailnet-name': ['studio.tailabc123.ts.net', 'studio.<tailnet>.ts.net', 'tailabc123.ts.net'],
      'mdns-name': ['someones-mac.local', 'Studio-2.local'],
      'home-path': ['/Users/someone/.tangleclaw', '/home/someone/x', 'C:\\Users\\someone\\x'],
      uuid: ['0f8e2a9c-1b3d-4e5f-8a7b-6c5d4e3f2a1b'],
      'launch-id': ['Ab3dEf6hIj9lMn2pQr5tUv'],
      'workspace-id': ['my-project-1a2b3c4d']
    };
    for (const [rule, values] of Object.entries(sentinels)) {
      for (const value of values) {
        const hits = lintGuide(`before ${value} after`).filter((f) => f.rule === rule);
        assert.equal(hits.length, 1, `${rule} should flag ${value}`);
      }
    }
  });

  it('allows the documented placeholders and ordinary text', () => {
    const allowed = [
      PLACEHOLDER_IP,
      '<tailnet>.ts.net',
      '<service-name>.<tailnet>.ts.net',
      '`<old-name>.<tailnet>.ts.net`',
      '<machine-name>.local',
      '~/.tangleclaw/Caddyfile',
      'https://localhost:8443 and 127.0.0.1',
      'v5.33.0 and node scripts/host-check.js --reveal',
      'gui/$(id -u)/com.tangleclaw.caddy'
    ];
    for (const text of allowed) assert.deepEqual(lintGuide(text), [], `should allow: ${text}`);
  });

  it('the guide carries none of those shapes', () => {
    const text = fs.readFileSync(GUIDE, 'utf8');
    assert.deepEqual(lintGuide(text), []);
  });
});

describe('host-migration guide matches the host check (#1380)', () => {
  const text = fs.readFileSync(GUIDE, 'utf8');

  it('names every script it tells the operator to run, and each exists', () => {
    const scripts = [...new Set([...text.matchAll(/scripts\/[a-z0-9-]+\.js/g)].map((m) => m[0]))];
    assert.ok(scripts.includes('scripts/host-check.js'), 'the guide should tell the operator to run the host check');
    for (const s of scripts) assert.ok(fs.existsSync(path.join(REPO_ROOT, s)), `${s} is named in the guide but does not exist`);
  });

  it('states the host check exit codes as the check defines them', () => {
    for (const code of [hostCheck.EXIT_OK, hostCheck.EXIT_DRIFT, hostCheck.EXIT_UNKNOWN, hostCheck.EXIT_USAGE]) {
      assert.match(text, new RegExp(`\\|\\s*\`${code}\`\\s*\\|`), `exit code ${code} should be a row of the guide's exit-code table`);
    }
  });

  it('names every row state the check can print', () => {
    for (const state of hostCheck.ROW_STATES) assert.ok(text.includes(`\`${state}\``), `row state ${state} should be explained`);
  });
});

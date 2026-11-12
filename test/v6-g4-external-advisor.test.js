'use strict';

/*
 * v6 (#3003, V6-33 / G4, Car V62-W1-B): the hardened external project
 * advisor (`lib/v6/g4-external-advisor.js`). Medium tier: the cap ledger
 * opens an in-memory `node:sqlite` database; file cases use temp dirs.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  DEFAULT_ADVISOR_ROOT, SLUG_PATTERN, DEFAULT_MAX_FILE_BYTES, DEFAULT_LIMITS, INTERNAL_SCOPE_FIELDS, AdvisorError,
  ensureSchema, readRepoFile, resolveRepoRoot, resolveWorkspace, createAdvisorLedger, advise
} = require('../lib/v6/g4-external-advisor');

/**
 * Assert `fn` throws an AdvisorError with `code`.
 * @param {Function} fn
 * @param {string} code
 */
function throwsCode(fn, code) {
  assert.throws(fn, (err) => err instanceof AdvisorError && err.code === code, code);
}

let tmp;
let repo;
let outside;
let protectedRoot;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v6-g4-')));
  repo = path.join(tmp, 'external-repo');
  outside = path.join(tmp, 'outside');
  protectedRoot = path.join(tmp, 'tc-projects');
  for (const d of [repo, path.join(repo, 'src'), outside, protectedRoot, path.join(protectedRoot, 'internal')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello advisor\n');
  fs.writeFileSync(path.join(repo, 'src', 'config.js'), 'module.exports = { password: "hunter2 two words" };\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE SECRET');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Read `rel` from the test repo with the test's protected root. */
const read = (rel, extra = {}) => readRepoFile({ repoRoot: repo, relativePath: rel, protectedRoots: [protectedRoot], ...extra });

describe('constants', () => {
  it('defaults the advisor root under ~/.tangleclaw/advisor and publishes its caps', () => {
    assert.equal(DEFAULT_ADVISOR_ROOT, path.join(os.homedir(), '.tangleclaw', 'advisor'));
    assert.equal(DEFAULT_MAX_FILE_BYTES, 256 * 1024);
    assert.deepEqual({ ...DEFAULT_LIMITS }, { maxRequests: 30, windowMs: 60000, dailyTokens: 200000, dailyUsd: 5 });
    assert.ok(SLUG_PATTERN.test('acme-repo') && !SLUG_PATTERN.test('Acme'));
    assert.ok(INTERNAL_SCOPE_FIELDS.includes('projectId') && INTERNAL_SCOPE_FIELDS.includes('medusaWorkspaceId'));
  });
});

describe('readRepoFile — read-only, contained, scrubbed', () => {
  it('reads a file and returns scrubbed text with the raw digest', () => {
    const out = read('src/config.js');
    assert.equal(out.relativePath, 'src/config.js');
    assert.match(out.text, /password: "\[REDACTED\]"/);
    assert.ok(!out.text.includes('hunter2'));
    assert.match(out.sha256, /^[0-9a-f]{64}$/);
  });

  it('canonicalizes . and empty segments', () => {
    assert.equal(read('./src//./config.js').relativePath, 'src/config.js');
  });

  it('refuses absolute, backslashed, NUL, traversal and empty paths', () => {
    for (const rel of ['/etc/passwd', 'src\\config.js', 'src/\0x', '../outside/secret.txt', 'src/../../outside/secret.txt', '', '.', './']) {
      throwsCode(() => read(rel), 'PATH_DENIED');
    }
  });

  it('refuses a symlinked file, a symlinked directory on the path, and a dangling link', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'link.txt'));
    fs.symlinkSync(outside, path.join(repo, 'linkdir'));
    fs.symlinkSync(path.join(tmp, 'nowhere'), path.join(repo, 'dangling'));
    throwsCode(() => read('link.txt'), 'SYMLINK_DENIED');
    throwsCode(() => read('linkdir/secret.txt'), 'SYMLINK_DENIED');
    throwsCode(() => read('dangling'), 'SYMLINK_DENIED');
  });

  it('refuses a missing file, a directory, an oversized file and a binary file', () => {
    throwsCode(() => read('nope.md'), 'NOT_FOUND');
    throwsCode(() => read('src'), 'NOT_A_FILE');
    fs.writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(2048));
    throwsCode(() => read('big.txt', { maxBytes: 1024 }), 'FILE_TOO_LARGE');
    fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0x50, 0x4b, 0x00, 0x01]));
    throwsCode(() => read('bin.dat'), 'BINARY_DENIED');
  });

  it('never writes to the target: the tree is byte-identical after reads', () => {
    const snapshot = () => fs.readdirSync(repo, { recursive: true }).sort().map((f) => {
      const p = path.join(repo, f);
      const st = fs.statSync(p);
      return `${f}:${st.isFile() ? fs.readFileSync(p, 'utf8') : 'dir'}:${st.mtimeMs}`;
    });
    const before = snapshot();
    read('README.md');
    read('src/config.js');
    assert.deepEqual(snapshot(), before);
  });

  it('a file swapped for a symlink between check and open is refused', () => {
    const target = path.join(repo, 'README.md');
    const realOpen = fs.openSync;
    let swapped = false;
    fs.openSync = function swapThenOpen(p, ...rest) {
      if (!swapped && p === target) {
        swapped = true;
        fs.rmSync(target);
        fs.symlinkSync(path.join(outside, 'secret.txt'), target);
      }
      return realOpen.call(fs, p, ...rest);
    };
    try {
      throwsCode(() => read('README.md'), 'SYMLINK_DENIED');
    } finally {
      fs.openSync = realOpen;
    }
  });

  it('a file replaced by a different file between check and open is refused', () => {
    const target = path.join(repo, 'README.md');
    const realOpen = fs.openSync;
    let swapped = false;
    fs.openSync = function replaceThenOpen(p, ...rest) {
      if (!swapped && p === target) {
        swapped = true;
        fs.rmSync(target);
        fs.writeFileSync(target, 'replaced');
      }
      return realOpen.call(fs, p, ...rest);
    };
    try {
      throwsCode(() => read('README.md'), 'FILE_CHANGED');
    } finally {
      fs.openSync = realOpen;
    }
  });
});

describe('resolveRepoRoot — isolation from internal checkouts', () => {
  it('refuses a target inside, equal to, or containing a protected root', () => {
    throwsCode(() => resolveRepoRoot(path.join(protectedRoot, 'internal'), [protectedRoot]), 'PROTECTED_ROOT');
    throwsCode(() => resolveRepoRoot(protectedRoot, [protectedRoot]), 'PROTECTED_ROOT');
    throwsCode(() => resolveRepoRoot(tmp, [protectedRoot]), 'PROTECTED_ROOT');
  });

  it('a symlink to a protected checkout is refused by its real path', () => {
    const alias = path.join(tmp, 'alias');
    fs.symlinkSync(path.join(protectedRoot, 'internal'), alias);
    throwsCode(() => resolveRepoRoot(alias, [protectedRoot]), 'PROTECTED_ROOT');
  });

  it('refuses a relative, missing or non-directory root, and needs a protected-root list', () => {
    throwsCode(() => resolveRepoRoot('external-repo', [protectedRoot]), 'REPO_ROOT_INVALID');
    throwsCode(() => resolveRepoRoot(path.join(tmp, 'missing'), [protectedRoot]), 'REPO_ROOT_INVALID');
    throwsCode(() => resolveRepoRoot(path.join(repo, 'README.md'), [protectedRoot]), 'REPO_ROOT_INVALID');
    assert.throws(() => resolveRepoRoot(repo), TypeError);
  });

  it('accepts a sibling whose name merely shares a prefix with a protected root', () => {
    const sibling = `${protectedRoot}-other`;
    fs.mkdirSync(sibling);
    assert.equal(resolveRepoRoot(sibling, [protectedRoot]), sibling);
  });
});

describe('resolveWorkspace — per-tenant isolated storage', () => {
  it('creates <root>/<tenant>/<repo> with 0700 and returns it', () => {
    const root = path.join(tmp, 'advisor');
    const dir = resolveWorkspace({ tenantId: 'acme', repoSlug: 'widget', root, create: true });
    assert.equal(dir, path.join(root, 'acme', 'widget'));
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(resolveWorkspace({ tenantId: 'acme', repoSlug: 'widget', root }), dir, 'idempotent');
  });

  it('refuses non-slug ids, which also rules out traversal', () => {
    const root = path.join(tmp, 'advisor');
    for (const bad of ['..', 'a/b', 'Acme', '', '-x']) {
      throwsCode(() => resolveWorkspace({ tenantId: bad, repoSlug: 'r', root }), 'TENANT_INVALID');
      throwsCode(() => resolveWorkspace({ tenantId: 't', repoSlug: bad, root }), 'REPO_SLUG_INVALID');
    }
    throwsCode(() => resolveWorkspace({ tenantId: 't', repoSlug: 'r', root: 'relative' }), 'ROOT_INVALID');
  });

  it('refuses a tenant directory that is a symlink', () => {
    const root = path.join(tmp, 'advisor');
    fs.mkdirSync(root);
    fs.symlinkSync(outside, path.join(root, 'evil'));
    throwsCode(() => resolveWorkspace({ tenantId: 'evil', repoSlug: 'r', root, create: true }), 'SYMLINK_DENIED');
  });
});

describe('createAdvisorLedger — persisted caps', () => {
  const NOW = Date.UTC(2026, 10, 12, 12);

  it('ensureSchema is idempotent', () => {
    const db = new DatabaseSync(':memory:');
    ensureSchema(db);
    ensureSchema(db);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'v6_advisor_requests'").get());
  });

  it('enforces the sliding request window per tenant', () => {
    const ledger = createAdvisorLedger(new DatabaseSync(':memory:'), { maxRequests: 2, windowMs: 1000 });
    assert.equal(ledger.reserve({ tenantId: 'a', tokens: 1, usd: 0, now: NOW }).ok, true);
    assert.equal(ledger.reserve({ tenantId: 'a', tokens: 1, usd: 0, now: NOW + 1 }).ok, true);
    assert.equal(ledger.reserve({ tenantId: 'a', tokens: 1, usd: 0, now: NOW + 2 }).code, 'RATE_LIMIT');
    assert.equal(ledger.reserve({ tenantId: 'b', tokens: 1, usd: 0, now: NOW + 2 }).ok, true, 'tenants are independent');
    assert.equal(ledger.reserve({ tenantId: 'a', tokens: 1, usd: 0, now: NOW + 1001 }).ok, true, 'the window slides');
  });

  it('enforces the daily token and USD budgets, resetting at UTC midnight', () => {
    const ledger = createAdvisorLedger(new DatabaseSync(':memory:'), { dailyTokens: 150, dailyUsd: 0.15 });
    assert.equal(ledger.reserve({ tenantId: 'a', tokens: 100, usd: 0.1, now: NOW }).ok, true);
    assert.equal(ledger.reserve({ tenantId: 'a', tokens: 100, usd: 0, now: NOW + 1 }).code, 'DAILY_BUDGET');
    assert.equal(ledger.reserve({ tenantId: 'a', tokens: 1, usd: 0.06, now: NOW + 2 }).code, 'DAILY_BUDGET');
    assert.equal(ledger.reserve({ tenantId: 'a', tokens: 50, usd: 0.05, now: NOW + 3 }).ok, true, 'exactly at the cap is allowed');
    assert.equal(ledger.reserve({ tenantId: 'a', tokens: 100, usd: 0.1, now: Date.UTC(2026, 10, 13) }).ok, true);
  });

  it('a refused reservation spends nothing, and usage reports the stored totals', () => {
    const ledger = createAdvisorLedger(new DatabaseSync(':memory:'), { dailyTokens: 100 });
    ledger.reserve({ tenantId: 'a', tokens: 60, usd: 0.2, now: NOW });
    ledger.reserve({ tenantId: 'a', tokens: 60, usd: 0.2, now: NOW + 1 });
    assert.deepEqual(ledger.usage('a', NOW + 2), { tokens: 60, usd: 0.2, requestsInWindow: 1 });
  });

  it('caps survive a new ledger over the same database (persisted, not per process)', () => {
    const db = new DatabaseSync(':memory:');
    createAdvisorLedger(db, { maxRequests: 1 }).reserve({ tenantId: 'a', tokens: 1, usd: 0, now: NOW });
    assert.equal(createAdvisorLedger(db, { maxRequests: 1 }).reserve({ tenantId: 'a', tokens: 1, usd: 0, now: NOW + 1 }).code, 'RATE_LIMIT');
  });

  it('refuses bad input and bad limits', () => {
    const ledger = createAdvisorLedger(new DatabaseSync(':memory:'));
    assert.equal(ledger.reserve({ tenantId: 'A!', tokens: 1, usd: 0, now: NOW }).code, 'TENANT_INVALID');
    assert.equal(ledger.reserve({ tenantId: 'a', tokens: 0, usd: 0, now: NOW }).code, 'BAD_REQUEST');
    assert.equal(ledger.reserve({ tenantId: 'a', tokens: 1, usd: -1, now: NOW }).code, 'BAD_REQUEST');
    assert.throws(() => createAdvisorLedger(new DatabaseSync(':memory:'), { maxRequests: 0 }), TypeError);
  });
});

describe('advise — the projectless entrypoint', () => {
  const NOW = Date.UTC(2026, 10, 12, 12);
  const base = () => ({ tenantId: 'acme', repoSlug: 'widget', repoRoot: repo, relativePath: 'README.md', estimate: { tokens: 10, usd: 0.01 } });
  const deps = (limits) => ({ ledger: createAdvisorLedger(new DatabaseSync(':memory:'), limits), protectedRoots: [protectedRoot], now: NOW });

  it('serves a scrubbed read and charges it', () => {
    const d = deps();
    const out = advise(base(), d);
    assert.equal(out.ok, true);
    assert.equal(out.file.text, 'hello advisor\n');
    assert.deepEqual(out.charged, { tokens: 10, usd: 0.01 });
    assert.equal(d.ledger.usage('acme', NOW).tokens, 10);
  });

  it('refuses any internal identity before reading anything', () => {
    for (const field of INTERNAL_SCOPE_FIELDS) {
      const d = deps();
      assert.equal(advise({ ...base(), [field]: 'x' }, d).code, 'PROJECT_SCOPE_DENIED', field);
      assert.equal(d.ledger.usage('acme', NOW).tokens, 0);
    }
  });

  it('a read that is refused spends nothing', () => {
    const d = deps();
    assert.equal(advise({ ...base(), relativePath: '../outside/secret.txt' }, d).code, 'PATH_DENIED');
    assert.equal(advise({ ...base(), repoRoot: protectedRoot }, d).code, 'PROTECTED_ROOT');
    assert.equal(d.ledger.usage('acme', NOW).requestsInWindow, 0);
  });

  it('a capped read returns no text', () => {
    const d = deps({ maxRequests: 1 });
    advise(base(), d);
    const out = advise(base(), d);
    assert.deepEqual(out, { ok: false, code: 'RATE_LIMIT' });
  });

  it('refuses a bad repo slug', () => {
    assert.equal(advise({ ...base(), repoSlug: '../x' }, deps()).code, 'REPO_SLUG_INVALID');
    assert.equal(advise(null, deps()).code, 'REPO_SLUG_INVALID');
  });
});

'use strict';

/*
 * v6.2.1 Stage 5 boundary-validation qualification suite (#3039, Car
 * V621-W1-B, Charter A663).
 *
 * Defensive unit tests that confirm each v6 trust boundary refuses input
 * outside its contract, run against the real shipped modules rather than a
 * simulated server:
 *
 *   1. A1 authorization (lib/v6/authority-service.js) — authority comes
 *      only from server-side principals; capabilities are scoped and
 *      non-transitive.
 *   2. F3 diagnostic scrubbing (lib/v6/f3-support-diagnostic-scrubber.js) —
 *      credentials never survive into a bundle; submission is consent-bound.
 *   3. G4 external advisor (lib/v6/g4-external-advisor.js) — reads stay
 *      inside the target repository; workspace identity is verified at use
 *      (KZ-V620-01 pinWorkspace/verifyWorkspace).
 *   4. G3 switchboard isolation and R-MED-1 compact wire
 *      (lib/v6/g3-medusa-isolation.js, lib/v6/medusa-v2-compact-sync.js) —
 *      cross-project access is default-deny; envelopes, cards and deltas
 *      are integrity-checked.
 *   5. A1-Iso host sandboxing (lib/v6/a1-iso-host-sandboxing.js) — mount
 *      policy comes only from trusted host facts (KZ-V620-01
 *      MOUNT_POLICY_FROM_PROFILE); isolation never downgrades.
 *
 * The coverage map follows the Stage 5 prototype's eight security
 * invariants (Builders-A-D/v6-stage5-adversarial-security-and-boundary-
 * torture-suite.md). Medium tier: section 1 opens the real store
 * (`node:sqlite`); sections 2-5 use temp directories and in-memory data.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const authority = require('../lib/v6/authority-service');
const f3 = require('../lib/v6/f3-support-diagnostic-scrubber');
const g4 = require('../lib/v6/g4-external-advisor');
const g3 = require('../lib/v6/g3-medusa-isolation');
const m2 = require('../lib/v6/medusa-v2-compact-sync');
const iso = require('../lib/v6/a1-iso-host-sandboxing');

/**
 * Assert `fn` throws an error carrying `code`.
 * @param {Function} fn
 * @param {string} code
 */
function throwsCode(fn, code) {
  assert.throws(fn, (err) => err && err.code === code, code);
}

// ── 1. A1 authorization ───────────────────────────────────────────────────

describe('A1 authorization: authority comes only from server-side principals', () => {
  let tmp;
  let db;
  let auth;
  let projectId;
  let otherProjectId;
  let wsId;
  const stamp = () => new Date().toISOString();

  /**
   * Seed a user principal with a workspace membership role.
   * @param {string} role
   * @param {string} workspaceId
   * @returns {{principalId: string, userId: number}}
   */
  function seedUser(role, workspaceId) {
    const userId = Number(db.prepare('INSERT INTO users (username, password_hash) VALUES (?,?)').run(`u-${crypto.randomUUID()}`, 'x').lastInsertRowid);
    db.prepare('INSERT INTO trusted_memberships (workspace_id, user_id, role, granted_at) VALUES (?,?,?,?)').run(workspaceId, userId, role, stamp());
    const principalId = `principal-${crypto.randomUUID()}`;
    db.prepare('INSERT INTO trusted_principals (id, kind, workspace_id, user_id, created_at) VALUES (?,?,?,?,?)').run(principalId, 'user', workspaceId, userId, stamp());
    return { principalId, userId };
  }

  /**
   * Seed a project in its own workspace.
   * @param {string} workspaceId
   * @returns {number}
   */
  function seedProject(workspaceId) {
    const name = `p-${crypto.randomUUID()}`;
    const id = Number(db.prepare('INSERT INTO projects (name, path) VALUES (?,?)').run(name, path.join(tmp, name)).lastInsertRowid);
    db.prepare('INSERT INTO trusted_project_workspaces (project_id, workspace_id) VALUES (?,?)').run(id, workspaceId);
    return id;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-boundary-a1-'));
    store._setBasePath(tmp);
    store.init();
    db = store.getDb();
    wsId = `ws-${crypto.randomUUID()}`;
    const otherWs = `ws-${crypto.randomUUID()}`;
    for (const w of [wsId, otherWs]) db.prepare('INSERT INTO trusted_workspaces (id, name, created_at) VALUES (?,?,?)').run(w, w, stamp());
    projectId = seedProject(wsId);
    otherProjectId = seedProject(otherWs);
    auth = authority.createAuthorizationService(db);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('denies by default: unknown action, missing principal, or a non-project resource', () => {
    const { principalId } = seedUser('owner', wsId);
    assert.equal(auth.authorize(principalId, 'project.deleteEverything', { type: 'project', id: projectId }).code, 'DEFAULT_DENY');
    assert.equal(auth.authorize(null, 'project.readPolicy', { type: 'project', id: projectId }).code, 'DEFAULT_DENY');
    assert.equal(auth.authorize(principalId, 'project.readPolicy', { type: 'workspace', id: projectId }).code, 'DEFAULT_DENY');
    assert.equal(auth.authorize(principalId, 'project.readPolicy', { type: 'project', id: '1' }).code, 'DEFAULT_DENY');
  });

  it('an unknown principal id is refused the same way as an out-of-scope one', () => {
    const verdict = auth.authorize('principal-does-not-exist', 'project.readPolicy', { type: 'project', id: projectId });
    assert.deepEqual(verdict, { allowed: false, code: 'SCOPE_DENIED' });
  });

  it('a principal from another workspace cannot reach this project, even as owner there', () => {
    const otherWs = db.prepare('SELECT workspace_id FROM trusted_project_workspaces WHERE project_id = ?').get(otherProjectId).workspace_id;
    const { principalId } = seedUser('owner', otherWs);
    assert.equal(auth.authorize(principalId, 'project.readPolicy', { type: 'project', id: projectId }).code, 'SCOPE_DENIED');
    assert.equal(auth.authorize(principalId, 'project.readPolicy', { type: 'project', id: otherProjectId }).allowed, true);
  });

  it('a member may read but not write; owner and admin may write', () => {
    const member = seedUser('member', wsId).principalId;
    const admin = seedUser('admin', wsId).principalId;
    assert.equal(auth.authorize(member, 'project.readPolicy', { type: 'project', id: projectId }).allowed, true);
    assert.equal(auth.authorize(member, 'project.writePolicy', { type: 'project', id: projectId }).code, 'ROLE_DENIED');
    assert.equal(auth.authorize(admin, 'project.writePolicy', { type: 'project', id: projectId }).allowed, true);
  });

  it('a revoked principal or a revoked membership loses access', () => {
    const { principalId, userId } = seedUser('owner', wsId);
    db.prepare('UPDATE trusted_memberships SET revoked_at = ? WHERE user_id = ?').run(stamp(), userId);
    assert.equal(auth.authorize(principalId, 'project.readPolicy', { type: 'project', id: projectId }).code, 'MEMBERSHIP_DENIED');
    db.prepare('UPDATE trusted_principals SET revoked_at = ? WHERE id = ?').run(stamp(), principalId);
    assert.equal(auth.authorize(principalId, 'project.readPolicy', { type: 'project', id: projectId }).code, 'SCOPE_DENIED');
  });

  it('an expired principal is refused', () => {
    const { principalId } = seedUser('owner', wsId);
    db.prepare('UPDATE trusted_principals SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', principalId);
    assert.equal(auth.authorize(principalId, 'project.readPolicy', { type: 'project', id: projectId }).code, 'SCOPE_DENIED');
  });

  it('an agent never exceeds the role of the user who started it', () => {
    const { principalId: memberUser } = seedUser('member', wsId);
    const agentId = `agent-${crypto.randomUUID()}`;
    // An agent principal is bound to a real session of a real project.
    const sessionId = Number(db.prepare('INSERT INTO sessions (project_id, engine_id) VALUES (?, ?)').run(projectId, 'claude').lastInsertRowid);
    db.prepare('INSERT INTO trusted_principals (id, kind, workspace_id, project_id, session_id, initiating_principal_id, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(agentId, 'agent', wsId, projectId, sessionId, memberUser, stamp());
    db.prepare('INSERT INTO trusted_capability_grants (id, principal_id, action, resource_type, resource_id, granted_by, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), agentId, 'project.writePolicy', 'project', String(projectId), memberUser, stamp());
    assert.equal(auth.authorize(agentId, 'project.writePolicy', { type: 'project', id: projectId }).code, 'INITIATOR_CEILING',
      'even an explicit grant cannot lift an agent above its initiator');
  });

  it('a capability grant is exact and non-transitive: one action, one project', () => {
    const owner = seedUser('owner', wsId).principalId;
    const svc = `svc-${crypto.randomUUID()}`;
    db.prepare('INSERT INTO trusted_principals (id, kind, workspace_id, created_at) VALUES (?,?,?,?)').run(svc, 'service', wsId, stamp());
    db.prepare('INSERT INTO trusted_capability_grants (id, principal_id, action, resource_type, resource_id, granted_by, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), svc, 'runtime.recover', 'project', String(projectId), owner, stamp());
    assert.equal(auth.authorize(svc, 'runtime.recover', { type: 'project', id: projectId }).allowed, true);
    assert.equal(auth.authorize(svc, 'g1.mintLease', { type: 'project', id: projectId }).code, 'GRANT_DENIED');
    assert.equal(auth.authorize(svc, 'project.writePolicy', { type: 'project', id: projectId }).code, 'GRANT_DENIED');
    assert.equal(auth.authorize(svc, 'runtime.recover', { type: 'project', id: otherProjectId }).code, 'SCOPE_DENIED');
  });

  it('an expired, revoked or used-up grant authorizes nothing', () => {
    const owner = seedUser('owner', wsId).principalId;
    const svc = `svc-${crypto.randomUUID()}`;
    db.prepare('INSERT INTO trusted_principals (id, kind, workspace_id, created_at) VALUES (?,?,?,?)').run(svc, 'service', wsId, stamp());
    const grantId = crypto.randomUUID();
    db.prepare('INSERT INTO trusted_capability_grants (id, principal_id, action, resource_type, resource_id, granted_by, created_at, max_uses, uses) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(grantId, svc, 'runtime.recover', 'project', String(projectId), owner, stamp(), 1, 1);
    const ref = { type: 'project', id: projectId };
    assert.equal(auth.authorize(svc, 'runtime.recover', ref).code, 'GRANT_DENIED', 'max_uses reached');
    db.prepare('UPDATE trusted_capability_grants SET max_uses = NULL, expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', grantId);
    assert.equal(auth.authorize(svc, 'runtime.recover', ref).code, 'GRANT_DENIED', 'expired');
    db.prepare('UPDATE trusted_capability_grants SET expires_at = NULL, revoked_at = ? WHERE id = ?').run(stamp(), grantId);
    assert.equal(auth.authorize(svc, 'runtime.recover', ref).code, 'GRANT_DENIED', 'revoked');
  });

  it('the principal resolver ignores client-supplied identity: headers and bodies cannot name a principal', () => {
    const { principalId, userId } = seedUser('owner', wsId);
    const resolve = authority.createVerifiedPrincipalResolver(db, (req) => req.__access);
    const spoofed = {
      headers: { 'x-tangleclaw-principal': principalId, 'x-role': 'operator' },
      body: { principalId, role: 'owner' },
      __access: { kind: 'none' }
    };
    assert.equal(resolve(spoofed), null);
    assert.equal(resolve({ __access: { kind: 'operator' }, tcSession: { userId } }), principalId, 'a verified operator session resolves');
    assert.equal(resolve({ __access: { kind: 'operator' }, tcSession: { userId: userId + 9999 } }), null);
    assert.equal(resolve({ __access: { kind: 'project', sessionId: 1, projectId } }), null, 'an unregistered launch resolves to nobody');
  });

  it('minting a lease goes through authorization: a member cannot mint one', () => {
    const member = seedUser('member', wsId).principalId;
    const out = authority.mintLease(db, { principalId: member, auth, projectId, actor: 'tc-lane-b', repo: 'o/r', connectionEpoch: 1, actions: ['push'], ttlMs: 1000 });
    assert.deepEqual(out, { ok: false, code: 'ROLE_DENIED' });
    assert.equal(authority.mintLease(db, { principalId: member, auth, projectId, actor: '', repo: 'o/r', connectionEpoch: 1, actions: ['push'], ttlMs: 1000 }).code, 'INVALID_REQUEST');
  });
});

// ── 2. F3 diagnostic scrubbing ────────────────────────────────────────────

describe('F3 scrubbing: credentials never survive into a diagnostic bundle', () => {
  const NOW = 1_800_000_000_000;
  const SECRET_FORMS = [
    'password=correct horse battery staple',
    '{"token": "two words here"}',
    "client_secret: 'quoted value'",
    'token="unterminated value tail',
    JSON.stringify({ error: 'client_secret="a \\"nested\\" value" then' }),
    'Authorization: Bearer abc.def.ghi',
    'https://user:hunter2@git.example.com/repo',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'
  ];
  const LEAK_WORDS = ['horse', 'battery', 'two words', 'quoted value', 'value tail', 'nested', 'hunter2', 'ghp_abc', 'AKIAIOSF', 'MIIEow'];

  it('every credential form is removed from the scrubbed text', () => {
    for (const form of SECRET_FORMS) {
      const out = f3.scrub(form);
      for (const word of LEAK_WORDS) assert.ok(!out.includes(word), `${word} survived scrubbing ${JSON.stringify(form)}`);
      assert.equal(f3.scrub(out), out, `idempotent for ${JSON.stringify(form)}`);
    }
  });

  it('a bundle built from all of them passes its own redaction verifier', () => {
    const bundle = f3.buildBundle({ logLines: SECRET_FORMS, errorCodes: ['AUTH_FAILED'] }, { includeLogs: true, now: NOW });
    const json = JSON.stringify(bundle);
    for (const word of LEAK_WORDS) assert.ok(!json.includes(word), word);
    assert.deepEqual(f3.findSecrets(json), []);
  });

  it('non-allowlisted input fields never enter the bundle', () => {
    const bundle = f3.buildBundle({ version: '6.2.1', prompt: 'private plans', env: { GH_TOKEN: 'x' }, config: { a: 1 } }, { now: NOW });
    assert.deepEqual(Object.keys(bundle).sort(), ['createdAt', 'errorCodes', 'healthCodes', 'mode', 'platform', 'schema', 'version']);
  });

  it('every kept log line stays within its cap and is verifier-clean, wherever the cut lands', () => {
    for (let pad = f3.MAX_LOG_LINE - 30; pad <= f3.MAX_LOG_LINE + 2; pad++) {
      const [kept] = f3.buildBundle({ logLines: ['x'.repeat(pad) + ' password=x'] }, { includeLogs: true, now: NOW }).logLines;
      assert.ok(kept.length <= f3.MAX_LOG_LINE, `pad ${pad}: ${kept.length}`);
      assert.deepEqual(f3.findSecrets(JSON.stringify(kept)), [], `pad ${pad}`);
    }
  });

  it('submission requires digest-bound consent, an allowlisted repo, a ledger, and fires once per consent', async () => {
    const preview = f3.previewIssue(f3.buildBundle({ errorCodes: ['X'] }, { now: NOW }), 'org/repo');
    const consent = { approved: true, scope: 'github-issue', repo: 'org/repo', bundleDigest: preview.digest, expiresAt: NOW + 1000, consentId: 'c1' };
    const calls = [];
    const adapter = async (issue) => { calls.push(issue); return { issueUrl: 'https://example.invalid/1' }; };
    const used = new Set();
    assert.equal((await f3.submitIssue({ preview, consent: { ...consent, bundleDigest: 'f'.repeat(64) }, adapter, allowedRepos: ['org/repo'], usedConsentIds: used, now: NOW })).code, 'CONSENT_REQUIRED');
    assert.equal((await f3.submitIssue({ preview, consent, adapter, allowedRepos: ['org/other'], usedConsentIds: used, now: NOW })).code, 'REPO_NOT_ALLOWED');
    await assert.rejects(() => f3.submitIssue({ preview, consent, adapter, allowedRepos: ['org/repo'], now: NOW }), TypeError);
    assert.equal((await f3.submitIssue({ preview, consent, adapter, allowedRepos: ['org/repo'], usedConsentIds: used, now: NOW })).ok, true);
    assert.equal((await f3.submitIssue({ preview, consent, adapter, allowedRepos: ['org/repo'], usedConsentIds: used, now: NOW })).code, 'CONSENT_ALREADY_USED');
    assert.equal(calls.length, 1);
  });
});

// ── 3. G4 external advisor ────────────────────────────────────────────────

describe('G4 advisor: reads stay inside the target and workspace identity is verified at use', () => {
  let tmp;
  let repo;
  let outside;
  let protectedRoot;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-boundary-g4-')));
    repo = path.join(tmp, 'repo');
    outside = path.join(tmp, 'outside');
    protectedRoot = path.join(tmp, 'tc-projects');
    for (const d of [path.join(repo, 'src'), outside, path.join(protectedRoot, 'internal')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'inside\n');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE');
    fs.writeFileSync(path.join(protectedRoot, 'internal', 'p.txt'), 'PROTECTED');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const read = (rel) => g4.readRepoFile({ repoRoot: repo, relativePath: rel, protectedRoots: [protectedRoot] });

  it('refuses paths that leave the repository', () => {
    for (const rel of ['../outside/secret.txt', '/etc/passwd', 'src\\a.js', 'src/../../outside/secret.txt', '']) {
      throwsCode(() => read(rel), 'PATH_DENIED');
    }
  });

  it('refuses a symlink anywhere on the path and a hard-linked file', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'link.txt'));
    fs.symlinkSync(outside, path.join(repo, 'dirlink'));
    fs.linkSync(path.join(protectedRoot, 'internal', 'p.txt'), path.join(repo, 'hard.txt'));
    throwsCode(() => read('link.txt'), 'SYMLINK_DENIED');
    throwsCode(() => read('dirlink/secret.txt'), 'SYMLINK_DENIED');
    throwsCode(() => read('hard.txt'), 'HARDLINK_DENIED');
  });

  it('refuses a target that overlaps a protected root, including through a symlinked alias', () => {
    throwsCode(() => g4.resolveRepoRoot(path.join(protectedRoot, 'internal'), [protectedRoot]), 'PROTECTED_ROOT');
    const alias = path.join(tmp, 'alias');
    fs.symlinkSync(path.join(protectedRoot, 'internal'), alias);
    throwsCode(() => g4.resolveRepoRoot(alias, [protectedRoot]), 'PROTECTED_ROOT');
  });

  it('a request naming any internal identity is refused before any read is attempted', () => {
    // Instrumented: count every fs read-path call during advise(). The
    // control proves the same request WOULD read the (readable) file once
    // the identity field is removed, so zero reads below means the identity
    // check really runs first, not that the read happened to fail.
    const { DatabaseSync } = require('node:sqlite');
    const deps = () => ({ ledger: g4.createAdvisorLedger(new DatabaseSync(':memory:')), protectedRoots: [protectedRoot], now: Date.UTC(2026, 10, 12) });
    const base = { tenantId: 'acme', repoSlug: 'w', repoRoot: repo, relativePath: 'src/a.js', estimate: { tokens: 1, usd: 0 } };
    const watched = ['openSync', 'readSync', 'readFileSync', 'realpathSync', 'lstatSync'];
    const counting = (fn) => {
      const originals = {};
      const counts = {};
      for (const name of watched) {
        originals[name] = fs[name];
        counts[name] = 0;
        fs[name] = function counted(...a) { counts[name]++; return originals[name].apply(fs, a); };
      }
      try {
        return { result: fn(), counts };
      } finally {
        for (const name of watched) fs[name] = originals[name];
      }
    };
    const control = counting(() => g4.advise(base, deps()));
    assert.equal(control.result.ok, true, 'control: the file is readable');
    assert.ok(control.counts.openSync >= 1 && control.counts.readSync >= 1, `control read the file: ${JSON.stringify(control.counts)}`);
    for (const field of g4.INTERNAL_SCOPE_FIELDS) {
      for (const value of ['x', 0, '', null, false]) {
        const run = counting(() => g4.advise({ ...base, [field]: value }, deps()));
        assert.equal(run.result.code, 'PROJECT_SCOPE_DENIED', `${field}=${JSON.stringify(value)}`);
        assert.deepEqual(run.counts, Object.fromEntries(watched.map((n) => [n, 0])), `${field}=${JSON.stringify(value)} touched the filesystem`);
      }
    }
  });

  it('KZ-V620-01: verifyWorkspace refuses a workspace swapped after it was pinned', () => {
    const root = path.join(tmp, 'advisor');
    const handle = g4.pinWorkspace({ tenantId: 't', repoSlug: 'r', root, create: true });
    assert.equal(g4.verifyWorkspace(handle), path.join(root, 't', 'r'));
    fs.rmSync(handle.path, { recursive: true });
    fs.symlinkSync(outside, handle.path);
    throwsCode(() => g4.verifyWorkspace(handle), 'SYMLINK_DENIED');
  });

  it('KZ-V620-01: verifyWorkspace refuses a workspace replaced by another plain directory', () => {
    const root = path.join(tmp, 'advisor');
    const handle = g4.pinWorkspace({ tenantId: 't', repoSlug: 'r', root, create: true });
    fs.renameSync(path.join(root, 't'), path.join(tmp, 't-moved'));
    fs.mkdirSync(path.join(root, 't', 'r'), { recursive: true });
    throwsCode(() => g4.verifyWorkspace(handle), 'SYMLINK_DENIED');
  });

  it('a symlinked advisor root is refused and nothing is created at its target', () => {
    const linkRoot = path.join(tmp, 'advisor-link');
    fs.symlinkSync(outside, linkRoot);
    throwsCode(() => g4.pinWorkspace({ tenantId: 't', repoSlug: 'r', root: linkRoot, create: true }), 'ROOT_SYMLINK_DENIED');
    assert.equal(fs.existsSync(path.join(outside, 't')), false);
  });
});

// ── 4. G3 switchboard isolation and R-MED-1 compact wire ──────────────────

describe('G3 / R-MED-1: switchboard isolation is default-deny and the compact wire is integrity-checked', () => {
  const ARTIFACT = 'Gate result: passed.\nNext: merge.';
  const fetchArtifact = (hash) => (hash === m2.sha256(ARTIFACT) ? ARTIFACT : null);
  const envelope = () => m2.createEnvelope({
    msg_type: 'gate', task_id: '3039',
    state_delta: { car: 'V621-W1-B', gate: 'R', transition: { from: 'review', to: 'passed' } },
    artifact_ref: m2.artifactRef(ARTIFACT, { anchor: 'gate-result' }),
    next_action: 'merge'
  });

  it('cross-project switchboard access is denied unless a link covers that direction', () => {
    assert.deepEqual(g3.checkMedusaCrossProjectAccess('p1', 'p1'), { allowed: true });
    assert.equal(g3.checkMedusaCrossProjectAccess('p1', 'p2').code, 'MEDUSA_CROSS_PROJECT_DENIED');
    const link = { fromProjectId: 'p1', toProjectId: 'p2' };
    assert.equal(g3.checkMedusaCrossProjectAccess('p1', 'p2', { crossProjectLinks: [link] }).allowed, true);
    assert.equal(g3.checkMedusaCrossProjectAccess('p2', 'p1', { crossProjectLinks: [link] }).code, 'MEDUSA_CROSS_PROJECT_DENIED', 'one-way');
  });

  it('blank, missing or non-scalar project ids are denied without coercion or throwing', () => {
    const blank = [['', 'p1'], ['p1', ''], [null, 'p1'], [undefined, undefined], ['  ', '  ']];
    const nonScalar = [
      [{}, {}], [[], []], [true, true], [false, false], [() => 1, () => 1], [Symbol('p'), Symbol('p')],
      // Values that would MATCH if coerced to strings: still refused.
      [{ toString: () => 'p1' }, 'p1'], [['p1'], 'p1'], ['p1', ['p1']], [{ valueOf: () => 7 }, 7]
    ];
    for (const [a, b] of [...blank, ...nonScalar]) {
      let verdict;
      assert.doesNotThrow(() => { verdict = g3.checkMedusaCrossProjectAccess(a, b); }, `${typeof a}/${typeof b}`);
      assert.deepEqual(verdict, { allowed: false, code: 'MEDUSA_CROSS_PROJECT_DENIED' }, `${typeof a}/${typeof b}`);
    }
    const link = { fromProjectId: {}, toProjectId: {} };
    assert.equal(g3.checkMedusaCrossProjectAccess({}, {}, { crossProjectLinks: [link] }).allowed, false, 'a link cannot admit non-scalar ids');
  });

  it('the compact wire is negotiated only with a peer that advertises it', () => {
    assert.equal(m2.negotiateWire([m2.CAPABILITY]), 'm2');
    for (const caps of [[], ['other'], undefined, null, m2.CAPABILITY]) assert.equal(m2.negotiateWire(caps), 'prose');
  });

  it('an envelope altered after creation fails digest verification', () => {
    const env = envelope();
    assert.equal(m2.verifyEnvelope(env), env);
    const altered = { ...env, next_action: 'deploy' };
    throwsCode(() => m2.verifyEnvelope(altered), 'DIGEST_MISMATCH');
  });

  it('a referenced artifact whose bytes differ from its digest is refused', () => {
    const ref = envelope().artifact_ref;
    assert.equal(m2.resolveArtifact(ref, fetchArtifact), ARTIFACT);
    throwsCode(() => m2.resolveArtifact(ref, () => 'substituted text'), 'ARTIFACT_CORRUPT');
    throwsCode(() => m2.resolveArtifact(ref, () => null), 'ARTIFACT_MISSING');
  });

  it('a human card edited after projection is refused when parsed', () => {
    const card = m2.projectCard(envelope(), fetchArtifact);
    assert.equal(m2.parseCard(card, fetchArtifact).envelope.next_action, 'merge');
    const edited = card.replace('merge', 'deploy');
    assert.notEqual(edited, card);
    assert.throws(() => m2.parseCard(edited, fetchArtifact), (err) => err instanceof m2.MedusaV2Error);
  });

  it('a graph delta built against a different base is refused', () => {
    const graph = (label) => ({ nodes: { a: { label, edges: ['b'] }, b: { label: 'b', edges: [] } }, roots: ['a'] });
    const base = graph('open');
    const next = graph('done');
    const delta = m2.diffGraphs(base, next);
    assert.deepEqual(m2.applyDelta(base, delta), next, 'the delta applies to its own base');
    throwsCode(() => m2.applyDelta(graph('blocked'), delta), 'BASE_MISMATCH');
  });
});

// ── 5. A1-Iso host sandboxing ─────────────────────────────────────────────

describe('A1-Iso: mount policy comes only from the host and isolation never downgrades', () => {
  const HOST = {
    uid: 501, gid: 20, groups: [12], runtimes: { docker: true }, canSwitchUid: true,
    realpath: (p) => path.resolve(p), mountRoots: ['/srv/fleet'], writableRoots: ['/srv/fleet/work'],
    home: '/Users/op', protectedRoots: ['/srv/tc']
  };
  const CONTAINER = {
    mode: 'container', requireIsolation: true, runtime: 'docker', image: 'ghcr.io/acme/agent@sha256:abc',
    command: ['node', 'agent.js'], uid: 1500, gid: 1500, mounts: [{ source: '/srv/fleet/repo', target: '/repo' }]
  };

  it('KZ-V620-01: a profile supplying its own mount policy is refused', () => {
    for (const extra of [{ mountRoots: ['/'] }, { writableRoots: ['/'] }, { mountRoots: ['/'], writableRoots: ['/'], mounts: [{ source: '/', target: '/host', readOnly: false }] }]) {
      const plan = iso.planIsolation({ ...CONTAINER, ...extra }, HOST);
      assert.equal(plan.code, 'MOUNT_POLICY_FROM_PROFILE', JSON.stringify(extra));
      assert.equal(plan.launch, undefined);
    }
  });

  it('sensitive host sources are refused even when the host policy lists them', () => {
    const lax = { ...HOST, mountRoots: ['/'], writableRoots: ['/'] };
    for (const source of ['/', '/etc', '/private/etc', '/var/run', '/Users/op', '/Users', '/Users/op/.ssh', '/Users/op/.tangleclaw', '/srv/tc/x']) {
      assert.equal(iso.planIsolation({ ...CONTAINER, mounts: [{ source, target: '/m', readOnly: false }] }, lax).code, 'MOUNT_SOURCE_SENSITIVE', source);
    }
  });

  it('a mount source outside the host roots, or symlinked, or writable outside the writable roots is refused', () => {
    assert.equal(iso.planIsolation({ ...CONTAINER, mounts: [{ source: '/opt/data', target: '/d' }] }, HOST).code, 'MOUNT_NOT_ALLOWED');
    assert.equal(iso.planIsolation({ ...CONTAINER, mounts: [{ source: '/srv/fleet/repo', target: '/r', readOnly: false }] }, HOST).code, 'MOUNT_WRITE_DENIED');
    const linky = { ...HOST, realpath: (p) => (p.endsWith('/link') ? '/elsewhere' : path.resolve(p)) };
    assert.equal(iso.planIsolation({ ...CONTAINER, mounts: [{ source: '/srv/fleet/link', target: '/l' }] }, linky).code, 'MOUNT_SYMLINK_DENIED');
  });

  it('a target id that keeps host identity is refused in both isolated modes', () => {
    const sep = { mode: 'separate_unix_uid', requireIsolation: true, uid: 1600, gid: 1600 };
    assert.equal(iso.planIsolation({ ...sep, uid: 501 }, HOST).code, 'SAME_UID');
    assert.equal(iso.planIsolation({ ...sep, gid: 20 }, HOST).code, 'SAME_GID');
    assert.equal(iso.planIsolation({ ...sep, gid: 12 }, HOST).code, 'SAME_GID', 'a host supplementary group');
    assert.equal(iso.planIsolation({ ...CONTAINER, gid: 20 }, HOST).code, 'SAME_GID');
    assert.equal(iso.planIsolation({ ...sep, uid: 0 }, HOST).code, 'TARGET_ID_INVALID');
  });

  it('an isolated request is refused, never downgraded, when isolation is unavailable', () => {
    const refusals = [
      iso.planIsolation({ ...CONTAINER }, { ...HOST, runtimes: {} }),
      iso.planIsolation({ mode: 'separate_unix_uid', requireIsolation: true, uid: 1600, gid: 1600 }, { ...HOST, canSwitchUid: false }),
      iso.planIsolation({ mode: 'shared_uid', requireIsolation: true }, HOST)
    ];
    for (const r of refusals) {
      assert.equal(r.ok, false);
      assert.equal(r.launch, undefined, `${r.code} carried a launch`);
    }
  });

  it('an admitted container launch carries the full lock-down', () => {
    const plan = iso.planIsolation(CONTAINER, HOST);
    assert.equal(plan.ok, true, JSON.stringify(plan));
    for (const flag of ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--network=none', '--user=1500:1500']) {
      assert.ok(plan.launch.args.includes(flag), flag);
    }
  });
});

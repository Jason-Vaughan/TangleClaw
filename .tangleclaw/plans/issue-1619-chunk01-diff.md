# #1619 Chunk 01 — generation: the proposed diff, for Architect review

Branch `fix/issue-1619-identity`, commit `f5fcc71`, on top of `main` @ `65fe15b`.
Build plan: `/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder2/.tangleclaw/plans/issue-1619-identity-fix.md`

**Status: chunk 01 of 4 complete and committed. Not yet a PR.** Chunks 02
(migration of what is already committed), 03 (wrap ownership classification)
and 04 (fuller fixture matrix) remain.

## Decisions I want ruled on

1. **Scope widened from the governed block to every tracked carrier.** The brief
   named the managed block; I applied the same rule to the whole-file
   `_generateClaudeMd` path and to `AGENTS.md`/`GEMINI.md`, because `CLAUDE.md`
   is tracked whether or not a project is plugin-governed (`.gitignore:85`:
   "CLAUDE.md is deliberately NOT listed: it is tracked (#833)"). Engine-private
   `.codex.yaml` / `.aider.conf.yml` keep inlined values — verified genuinely
   ignored at `.gitignore:96-97`.

2. **A live credential was in a tracked file, and I treated it as in scope.**
   `_generateClaudeMd` inlined the live M2M bearer. The AUTH-4b test's stated
   premise was that this carrier is "engine-private ... TangleClaw gitignores"
   — false for `CLAUDE.md`, per the same `.gitignore:85`. It now takes the
   `AGENTS.md` fetch pointer. The brief's point 1 forbids a live credential in
   shared bytes, so I did not defer it; say if you would rather split it out.

3. **The committed-carrier token pointer itself carried the origin.** The
   existing precedent inlined `${serverProtocol}://localhost:${serverPort}` in
   the very line that explains why the secret is withheld. It now names
   `$TANGLECLAW_API`.

4. **Four tests pinned the old contract and are rewritten, not weakened.** The
   origin and name-scoping properties move to the engine-private carriers that
   still carry them; the AUTH-4b premise is corrected against `.gitignore:85`;
   the honest-absence pin asserts the check instead of the false inference. Two
   pins are ADDED (no credential, no identity in a tracked carrier), plus
   `test/tracked-carrier-identity.test.js` for the five-checkout property.

5. **The bootstrap sentence was rewritten three times to fit the ~2700-char
   prime budget** rather than raising the cap. Tell me if the shorter wording
   loses something you want said.

## Evidence

- Five checkouts differing in name, root and origin generate **byte-identical**
  `CLAUDE.md` and `AGENTS.md`; each still addresses its own project through its
  engine-private carrier; all five Medusa routes survive the identity removal.
  (`test/tracked-carrier-identity.test.js`.)
- Full suite green: **11,424 testcases, 0 failures, 1 skipped**, recorded as
  evidence against this tree via the JUnit reporter.
- Targeted: engines, engine-config-managed-block, managed-block,
  antigravity-engine, wrap-tc-owned-paths, wrap-file-ownership, tc-cli,
  tc-verbs, repo-governance-reference, ecosystem-primer, prime-golden,
  launch-steps.
- Prime golden fixtures regenerated; the word-level diff is only the bootstrap
  sentence, nothing else moved.
- One caveat, reported rather than smoothed over: `test/dir-scanner.test.js`
  ("the deadline kills") failed twice under full-suite load in earlier runs and
  passes alone, on a clean checkout of the base commit, and in the final run. I
  am calling it pre-existing timing flakiness, not a consequence of this change,
  and I have not tried to fix it.

## The lib/ diff

```diff
diff --git a/lib/ecosystem-primer.js b/lib/ecosystem-primer.js
index 2846904..0421073 100644
--- a/lib/ecosystem-primer.js
+++ b/lib/ecosystem-primer.js
@@ -172,9 +172,10 @@ function tcBootstrapLines(format = 'md') {
   const verbIds = VERB_ROSTER.map((v) => v.id);
   if (format === 'comment') {
     const text = 'Run `tc capabilities` BEFORE concluding a TangleClaw capability is missing — never '
-      + `improvise one. The tc CLI is on PATH in every TangleClaw-launched pane (verbs: ${verbIds.join(', ')}) `
+      + `improvise one. The tc CLI is normally on PATH in a TangleClaw-launched pane (verbs: ${verbIds.join(', ')}) `
       + 'and reports absence honestly. A capability assumed instead of checked is how sessions fabricate '
-      + 'outcomes. If tc is not found, this pane was not launched by TangleClaw — say so rather than guessing. '
+      + 'outcomes. If tc is missing, check TANGLECLAW_API first — a renamed install dir drops tc from PATH '
+      + 'in a pane that IS managed; use the API directly; only if that is gone too is it unmanaged. '
       + 'A failed localhost tc or curl is not proof of outage: a managed sandbox can block loopback while '
       + 'the host service is healthy — ask the operator or Project Master for a host-context check before '
       + 'reporting the server down.';
@@ -182,9 +183,10 @@ function tcBootstrapLines(format = 'md') {
   }
   return [
     '- **Run `tc capabilities` BEFORE concluding a TangleClaw capability is missing — never improvise '
-    + `one.** The \`tc\` CLI is on PATH in every TangleClaw-launched pane (verbs: ${verbIds.map((v) => `\`${v}\``).join(', ')}) `
+    + `one.** The \`tc\` CLI is normally on PATH in a TangleClaw-launched pane (verbs: ${verbIds.map((v) => `\`${v}\``).join(', ')}) `
     + 'and reports absence honestly. A capability assumed instead of checked is how sessions fabricate '
-    + 'outcomes. If `tc` is not found, this pane was not launched by TangleClaw — say so rather than guessing. '
+    + 'outcomes. If `tc` is missing, check `TANGLECLAW_API` first — a renamed install dir drops `tc` from PATH '
+    + 'in a pane that IS managed; use the API directly; only if that is gone too is it unmanaged. '
     + 'A failed localhost `tc`/`curl` is **not proof of outage** — sandboxes block loopback; get a host-context '
     + 'check before reporting the server down.'
   ];
diff --git a/lib/engines.js b/lib/engines.js
index e86da63..a005185 100644
--- a/lib/engines.js
+++ b/lib/engines.js
@@ -2002,9 +2002,9 @@ function _serviceTokenAuthLines(rules, format = 'md', options = {}) {
     return [
       `${lead}**TangleClaw API authentication**: PortHub (\`/api/ports*\`) and shared-docs `
         + '(`/api/shared-docs*`) require a bearer token when the M2M gate (AUTH-4) is on.',
-      `${lead}The token is deliberately NOT written here — this file is tracked in git. `
-        + `Fetch it from \`${rules.serverProtocol}://localhost:${rules.serverPort}/api/service-token\` `
-        + 'and send it as `Authorization: Bearer <token>`.',
+      `${lead}The token is deliberately NOT written here — this file is tracked in git, and neither is `
+        + 'this install\'s API origin. Fetch it from `$TANGLECLAW_API/api/service-token` (the origin your '
+        + 'launch exported) and send it as `Authorization: Bearer <token>`.',
       ''
     ];
   }
@@ -2048,8 +2048,71 @@ function _serviceTokenAuthLines(rules, format = 'md', options = {}) {
  * @param {'md'|'comment'} [format='md'] - `md` for markdown configs; `comment` for aider.
  * @returns {string[]} Lines to push into the config (empty when not opted in).
  */
-function _medusaSwitchboardLines(rules, format = 'md') {
+/**
+ * The checkout-neutral Medusa block for a carrier that is tracked in git.
+ *
+ * Same routes, no identity: the project name and the API origin are resolved by
+ * the session at run time from the launch context TangleClaw exported into its
+ * pane. Nothing here differs between two checkouts of one repository, which is
+ * the property that makes the file safe to commit.
+ *
+ * Deliberately names no fallback to a checkout's own `bin/tc`: a fallback that
+ * works in one checkout is the defect this block exists to remove.
+ *
+ * @param {'md'|'comment'} [format='md'] - `md` for markdown carriers; `comment` for `#`-prefixed ones.
+ * @returns {string[]} Lines to push into the config.
+ */
+function _medusaDiscoveryLines(format = 'md') {
+  const body = [
+    'Medusa Switchboard: you can exchange messages with other TangleClaw sessions.',
+    'TangleClaw runs your listener — do NOT open your own. Context, not a task: participate when a message arrives or when asked.',
+    'Routes, with `<base>` = `<api>/api/sessions/<project-name>`:',
+    'inbox `GET <base>/medusa/messages`; mark handled `POST <base>/medusa/read` with `{"ids": ["<id>", ...]}`;',
+    'send (initiate or respond) `POST <base>/medusa/send` with `{"to": "<workspace-id>", "message": "..."}`;',
+    'peers `GET <base>/medusa/roster`; why a peer has not picked up `GET <base>/medusa/peers/<workspace-id>`.',
+    'Resolve both placeholders at run time — they are launch facts, not repository facts, and this file is shared by every checkout:',
+    '`<api>` — the `TANGLECLAW_API` your launch exported.',
+    '`<project-name>` — `tc whoami`, or GET `$TANGLECLAW_API/api/tc/whoami?projectId=$TANGLECLAW_PROJECT_ID`.',
+    'Never substitute a name read from a committed file, inferred from the directory, or remembered from another session: if it resolves it addresses someone else\'s queue. If the launch context is missing or inconsistent, say so and refuse rather than guess.',
+    'The INITIATOR closes an exchange, so a message you do not answer leaves the sender blocked.'
+  ];
+  if (format === 'comment') {
+    return ['#', ...body.map((l) => `# ${l.replace(/`/g, '')}`)];
+  }
+  // Same `## Medusa Switchboard` heading the identity-bearing form emits: the
+  // carrier's structure is unchanged, only the values inside it.
+  return ['## Medusa Switchboard', '', ...body.slice(1).map((l) => `- ${l}`), ''];
+}
+
+/**
+ * Where the API lives, for a carrier that is tracked in git — without writing
+ * this install's origin into shared bytes (#1619).
+ *
+ * @param {'md'|'comment'} [format='md']
+ * @returns {string[]} Lines to push into the config.
+ */
+function _apiOriginDiscoveryLines(format = 'md') {
+  const text = 'read it from the `TANGLECLAW_API` environment variable your launch exported (`tc whoami` prints it too). '
+    + 'It is deliberately not written here: this file is tracked in git and shared by every checkout, while the origin is per install.';
+  return format === 'comment'
+    ? ['#', `# TangleClaw API base URL: ${text.replace(/`/g, '')}`]
+    : [`**TangleClaw API base URL**: ${text}`, ''];
+}
+
+function _medusaSwitchboardLines(rules, format = 'md', options = {}) {
   if (!rules || !rules.medusaEnabled || !rules.medusaProjectName) return [];
+
+  // A carrier the operator COMMITS must not name THIS checkout's project or this
+  // machine's origin (#1619). Both differ per checkout, so shared bytes carrying
+  // them produce a diff on every launch — and the wrap committed it silently,
+  // which is how one checkout published its own routes to every other. A stale
+  // name that 404s is the benign case; once it resolves it addresses a DIFFERENT
+  // live project. Describe the route shape and where identity comes from: those
+  // are launch facts, not repository facts.
+  if (options.committedCarrier) {
+    return _medusaDiscoveryLines(format);
+  }
+
   const base = `${rules.serverProtocol}://localhost:${rules.serverPort}`;
   const api = `${base}/api/sessions/${encodeURIComponent(rules.medusaProjectName)}/medusa`;
 
@@ -2161,9 +2224,14 @@ function _generateClaudeMd(projectConfig, projectPath) {
   // PortHub guide
   if (rules.porthubGuide) {
     lines.push(rules.porthubGuide, '');
-    lines.push(`**TangleClaw API base URL**: \`${rules.serverProtocol}://localhost:${rules.serverPort}\``, '');
-    for (const authLine of _serviceTokenAuthLines(rules)) lines.push(authLine);
-    for (const line of _medusaSwitchboardLines(rules)) lines.push(line);
+    // CLAUDE.md is a committed carrier wherever a project tracks it, which is
+    // the normal case — so it gets the same treatment as AGENTS.md: no origin,
+    // no project name, and above all no live bearer token (#1619). The
+    // token-in-CLAUDE.md path predates the shared-carrier rule, when this file
+    // was assumed engine-private and gitignored.
+    lines.push(..._apiOriginDiscoveryLines('md'));
+    for (const authLine of _serviceTokenAuthLines(rules, 'md', { committedCarrier: true })) lines.push(authLine);
+    for (const line of _medusaSwitchboardLines(rules, 'md', { committedCarrier: true })) lines.push(line);
   }
 
   // Shared documents
@@ -2210,13 +2278,13 @@ function _generateOperationalBlock(projectConfig, projectPath) {
   const rules = _getRulesContent(projectConfig, projectPath);
   const lines = ['## TangleClaw Operational Guide — generated; edits inside the markers are overwritten', ''];
 
-  lines.push(`**TangleClaw API base URL**: \`${rules.serverProtocol}://localhost:${rules.serverPort}\``, '');
+  lines.push(..._apiOriginDiscoveryLines('md'));
   // Same unconditional footing as the base URL above: how-to-reach content a
   // governed session cannot rediscover, and the carrier its engine reads.
   lines.push(...tcBootstrapLines('md'), '');
   lines.push(...planDocsLine('md'), '');
   for (const authLine of _serviceTokenAuthLines(rules, 'md', { committedCarrier: true })) lines.push(authLine);
-  for (const line of _medusaSwitchboardLines(rules)) lines.push(line);
+  for (const line of _medusaSwitchboardLines(rules, 'md', { committedCarrier: true })) lines.push(line);
 
   if (rules.porthubGuide) {
     lines.push(rules.porthubGuide, '');
@@ -2451,9 +2519,9 @@ function _generateGeminiMd(projectConfig, header = `# GEMINI.md — ${GENERATED_
   // PortHub guide
   if (rules.porthubGuide) {
     lines.push(rules.porthubGuide, '');
-    lines.push(`**TangleClaw API base URL**: \`${rules.serverProtocol}://localhost:${rules.serverPort}\``, '');
+    lines.push(..._apiOriginDiscoveryLines('md'));
     for (const authLine of _serviceTokenAuthLines(rules, 'md', { committedCarrier: true })) lines.push(authLine);
-    for (const line of _medusaSwitchboardLines(rules)) lines.push(line);
+    for (const line of _medusaSwitchboardLines(rules, 'md', { committedCarrier: true })) lines.push(line);
   }
 
   // Shared documents
```

Test and fixture changes are in the same commit; read them at `git show f5fcc71 -- test/`.

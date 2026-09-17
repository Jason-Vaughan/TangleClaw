# Dependency bump audit

How a pull request from Dependabot is audited and turned into a change that ships. Configuration:
[`.github/dependabot.yml`](../.github/dependabot.yml). Filed as
[#1361](https://github.com/Jason-Vaughan/TangleClaw/issues/1361).

**A Dependabot PR is an untrusted pull request.** It goes through
[ADR 0014](adr/0014-dual-key-review-for-untrusted-prs.md) the same way a stranger's PR does. Two
filters audit the raw diff, a maintainer rebuilds the change on a clean branch, and the bot's PR is
never merged. There is no allow-list, no auto-merge and no bot exemption from audit or rebuild, and none will be added. (ADR 0014's one Dependabot exemption is narrower: a `uses:`-only bump skips the workflows *rejection* and goes to this audit instead.)

## Why a bot gets no exemption from audit

Dependabot's own infrastructure is not the threat. The threat is upstream. Suppose the account
behind an action gets compromised, or a release tag gets moved to point at a malicious commit.
Dependabot then opens a PR to pull that release in, and nothing about the PR looks unusual: same
author, same branch naming, same one-line diff as every harmless bump before it. If bot PRs
auto-merge, the attacker never has to get past a reviewer, because the bot does that for them.

This has happened. In March 2025 the tags of `tj-actions/changed-files` were moved to a commit that
printed CI secrets into workflow logs (CVE-2025-30066). Every workflow that referenced the action
by tag ran the payload. A bump PR opened in that window would have looked exactly like a routine
update.

This audit does not close that exact attack on its own. Our workflows also reference actions by
tag, so a tag moved upstream runs in CI with no PR at all, and Dependabot never sees it. What
limits the exposure today is that every action we use comes from GitHub's own `actions/*`
organization. Pinning every `uses:` ref to a full commit SHA closes it, and is tracked in #1436;
once pinned, every change arrives as a bump PR and goes through this audit.

The stakes in this repository are concrete. `.github/workflows/release.yml` runs with `contents: write`
whenever a push to `main` changes `version.json` (and on manual dispatch), and it runs the same `actions/checkout` and `actions/setup-node`
that a bump PR changes. An action merged unaudited would run with permission to push tags to the
repository whose newest tag is the update path for every install (see
[Release process](release-process.md)).

## What Dependabot watches here

| Ecosystem | Configured | Why |
|---|---|---|
| `github-actions` | Yes, weekly, at most 3 open PRs | The workflows reference third-party actions by tag, and those actions run in CI. |
| `npm` | **No** | TangleClaw has zero npm dependencies. No `package.json` or lockfile is tracked, and `CONTRIBUTING.md` rejects any PR that adds one. An npm entry with no manifest fails every scheduled run. |

The npm row is enforced as a relation, not a promise. If a `package.json` is ever tracked,
`test/dependabot-config.test.js` fails until `dependabot.yml` gains an npm entry. So the
decision gets made again at the moment it stops being true.

The configuration is conservative on purpose. Every PR is audit work that ends in a manual
rebuild, so the schedule is weekly, the open-PR limit is small, and updates are not grouped. One
bump per PR means one verdict per upstream release.

## What already ran before anyone looked

Opening a Dependabot PR triggers `.github/workflows/test.yml` on `pull_request`, and that run uses
the **new** version of the action. So new upstream code executes in CI before any audit. This is
accepted, on the same terms `CONTRIBUTING.md` sets out for contributor tests. The run is on a
GitHub-hosted runner, the `GITHUB_TOKEN` is read-only, and no Actions secrets are passed to a
workflow that Dependabot triggers.

Those terms hold only while no workflow uses a trigger that runs with the base repository's
privileges: `pull_request_target`, `workflow_run` and `issue_comment` do.
`test/dependabot-config.test.js` fails if any of them appears. A green CI run on a bump PR tells you the
new version did not break the suite. It tells you nothing about whether the new version is safe.

## The audit

Work from raw text: `gh pr diff`, `gh api`, `gh release view`. Do not check out the bot's branch.
The audit has two parts, split between the two ADR 0014 roles.

### 1. Macro filter (ProjectManager): is this really a bump, and only a bump?

- **Author and branch.** `gh pr view <N> --json author,headRefName` shows the author as
  `app/dependabot` and the branch under `dependabot/github_actions/`. If the author is anything
  else, it is not a Dependabot PR. Handle it as an ordinary external PR under ADR 0014, where a
  change to `.github/workflows/` is a security trip.
- **Shape of the diff — by command, never by eye.** Run
  `gh pr diff <N> | node scripts/check-bump-diff.js`. It must exit `0` and print
  `BUMP-ONLY: <action> <old refs> → <new ref>`. It passes only when every changed file is a workflow
  under `.github/workflows/` modified in place, every changed line is a `uses: owner/repo@ref` line
  (a trailing version comment such as `# v4.2.0` is allowed), every line names the same action moving
  to one new ref, and no step is added, dropped or re-indented. Exit `1` names the reason: a new
  step, a changed `with:`, a widened `permissions:`, a comment edit, a second action. Exit `2` means
  no diff reached it — never read that as a pass. The operator ruled that this condition is checked
  mechanically because a one-line bump is exactly what a reader waves through.
- **The workflows category, and why it does not reject here.** The diff always touches
  `.github/workflows/`, ADR 0014's execute-on-our-machine category. ADR 0014 exempts a PR from that
  rejection **only** when both checks above pass (author `app/dependabot`, checker exit `0`); the
  ruling and its reasoning are recorded there. Any other result is a security trip as for any
  untrusted PR. A passing PR is still never merged: the rebuilt change is a maintainer's own edit,
  and `CONTRIBUTING.md` §4 allows that.

### 2. Micro filter (PR Reviewer): is the upstream release what it claims to be?

Record each answer. They go into the rebuild's PR body.

1. **Same repository.** Run `gh api repos/<owner>/<repo> --jq .full_name`. It must return the
   same owner and name the workflow already uses. A renamed or transferred repository redirects
   without warning, so a mismatch stops the audit.
2. **The release exists and is published.** Run `gh release view <new-tag> -R <owner>/<repo>`. The
   release must not be a draft or a prerelease. Read the notes. For a major bump, find every
   breaking change that touches an input our workflows pass.
3. **Cooling-off.** The release must have been published at least **7 days** ago. Compromised
   releases are usually found and pulled within days. Waiting a week costs a routine bump nothing,
   and it lets the rest of the ecosystem notice first. Only the Operator can waive the wait, for
   example for an urgent security fix. A waiver is written down in the PR body.
4. **The tag resolves to a commit on the default branch.** Run
   `gh api repos/<owner>/<repo>/git/ref/tags/<new-tag>` to get the commit. If the ref points to an
   annotated tag object, dereference it first. Then run
   `gh api repos/<owner>/<repo>/compare/<default-branch>...<sha> --jq .status`. GitHub reports the
   status of the second ref (the tag's commit) relative to the first (the default branch), so it
   must return `behind` or `identical`. `ahead` or `diverged` means the commit is not in the
   default branch's history. A tag on such a commit is how the `tj-actions` attack looked. Stop.
5. **Read the upstream change.** Run
   `gh api repos/<owner>/<repo>/compare/<old-ref>...<new-ref>` and look at `action.yml` first:
   `runs.using`, the `main`/`pre`/`post` entrypoints, new inputs that default to on, handling of
   `token`, and any new network destination. **Be honest about what this step can see.** Most
   JavaScript actions ship a bundled `dist/` file that cannot be reviewed as a diff. For those,
   the evidence comes from steps 1 to 4 plus the cooling-off, not from reading the code, and the
   verdict should say so.
6. **Blast radius.** Run `grep -n '<owner>/<repo>@' .github/workflows/*.yml` to list every
   workflow that uses the action and its `permissions:`. A bump that reaches `release.yml` runs
   with `contents: write`.

**What these checks prove, and what they don't.** They are evidence, not proof that a release is
benign. The cooling-off period and default-branch ancestry are heuristics: a malicious release can
survive a week on a default branch, and a legitimate one can live on a maintenance branch (which
these checks refuse until the Operator approves a documented alternative). A one-line ref change
can import far more code than its diff shows. The verdict records what was **not** reviewed (for
example, a bundled `dist/` file or transitive downloads) as residual risk for the Operator to
accept, per ADR 0014 Amendment 2026-09-17.

## The rebuild

When both filters pass:

- Create a branch from `main`, for example `chore/deps-<action>-<version>`. **Edit the `uses:`
  refs by hand.** Do not check out, cherry-pick or merge the bot's branch. The change is one line,
  so copying it would produce the same diff, but ADR 0014 depends on the discipline, not the byte
  count. After editing, confirm that no reference to the old ref is left in `.github/workflows/`.
- Add a `CHANGELOG.md` entry under `### Internal` that names the action, both versions and the
  Dependabot PR.
- The PR body links the Dependabot PR and records the answers from the micro filter, including
  any cooling-off waiver.
- Normal gates apply: suite, Critic when warranted, and PR review. **No `--auto`.** The PR touches
  CI, and the repository's PR rules exclude CI changes from auto-merge.
- There is no contributor to credit, so no `Reported-by:` trailer. The PR link is the record.
- After the rebuild merges, Dependabot normally closes its own PR, because the dependency is now
  current on `main`. If it does not, the Operator closes it (ADR 0014 step 4).

## When the audit fails

- Do not rebuild. `main` stays on the ref it already has.
- The Operator decides what to tell Dependabot. `@dependabot ignore this version` stops it from
  proposing the same release again. That comment is an instruction to the bot, not a merge.
- If the failure looks like a real upstream compromise (checks 1, 4 or 5), open an issue in this
  repository with the evidence, and consider reporting it to the action's maintainers. A
  compatibility failure on its own (check 2) is ordinary work. File it as an issue if the upgrade
  is still wanted.

## Never

These are permanent, not defaults to revisit:

- A workflow that approves, labels-for-merge or merges Dependabot PRs, including
  `dependabot/fetch-metadata` driving `gh pr merge` or `gh pr review --approve`.
- `gh pr merge` in any form on a Dependabot PR, `--auto` included, or an `@dependabot merge` or
  `@dependabot squash and merge` comment.
- Adding `dependabot[bot]` to a branch-protection bypass list or a ruleset exemption.
- A `pull_request_target`, `workflow_run` or `issue_comment` trigger in any workflow. Each one runs
  with the base repository's privileges, so a bump PR could reach them.

`test/dependabot-config.test.js` scans `.github/workflows/` for the workflow-side items. The
branch-protection item is a repository setting the suite cannot see, and it is held by this
document alone.

## When Dependabot goes quiet

A failed scheduled run looks the same as "no updates" from the PR list. Check the repository's
**Insights → Dependency graph → Dependabot** tab, which shows each ecosystem's last check and any
error. A run that keeps failing there is a configuration problem to fix, not a quiet week.

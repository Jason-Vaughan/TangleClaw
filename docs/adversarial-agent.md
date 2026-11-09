# Adversarial Agent

A TC-level primitive any methodology can call to get structured, adversarial/red-team
findings against a code surface. `lib/adversarial.js` (#108).

---

## Why It Exists

Standard testing (unit + integration + Independent Critic + Janitor) catches the happy
path and the obvious sad path — all of it asking "does the code do what the spec says?"
None of it systematically asks "what would a malicious or confused user throw at this?"
That second question is a distinct epistemic mode (adversarial / red-team / fuzz-style
testing), and the edge cases it finds — malformed UTF-8, race conditions, integer
overflow, time-zone arithmetic, unexpected concurrency, security holes,
internationalization quirks — are exactly the bugs that hit production. The marginal
value of unit test #50 on the happy path is much lower than the marginal value of one
well-designed adversarial test.

This covers only the TC-side primitive. **Methodology policy** (when to invoke it,
against what, how to filter and act on findings) is a separate concern, owned by
whatever methodology calls it — for Prawduct, proposed as a separate upstream extension.

## How It Works

TC owns exactly three things:

1. **Build the adversarial prompt** — the constitution, perspective-shifting personas,
   and a description of the surface under test.
2. **Invoke the caller's own subagent-spawn mechanism** — `spawnSubagent`, an injected
   function the methodology supplies (its engine's own Agent-tool plumbing, or a test
   double). TC never calls an LLM API itself; `lib/adversarial.js` imports no HTTP/LLM
   client, and `test/adversarial.test.js` asserts that structurally.
3. **Validate, filter, and record** — parse the subagent's JSON output against the
   findings schema, filter by severity and cap, and (once the methodology has decided a
   disposition per finding) write an audit trail entry.

TC has **no opinion on policy**: it does not decide when to call `runAdversarialPass`,
what severity threshold to use, or what a methodology does with the findings. That is
the calling methodology's job.

## API

### `runAdversarialPass(options)`

| Option | Required | Description |
|---|---|---|
| `surface` | yes | `{ files?, symbols?, endpoints? }` — what's under test. |
| `spawnSubagent` | yes | `(prompt) => string\|object\|Promise<...>` — the caller's own subagent-spawn mechanism. Receives the built prompt, returns the subagent's raw output. |
| `constitution` | no | Overrides `DEFAULT_CONSTITUTION`. |
| `personas` | no | Overrides `DEFAULT_PERSONAS` (array of persona strings). |
| `severityThreshold` | no | One of `critical\|high\|medium\|low` (default `low` — keep everything). |
| `maxFindings` | no | Caps the returned findings, highest severity first. |

Returns `{ ok: true, output: { findings, top5PrioritizedIds }, error: null }` on
success, or `{ ok: false, output: null, error: '<reason>' }` on any failure — a missing
surface, a missing `spawnSubagent`, a thrown `spawnSubagent`, or malformed subagent
output. Never throws.

### `validateAdversarialOutput(raw)`

Pure validator. Accepts a JSON string or an already-parsed object; returns
`{ valid: true, errors: [], output }` or `{ valid: false, errors: [...], output: null }`.
Never throws — any malformed shape declines with a reason instead of crashing the caller.

### `filterAndPrioritizeFindings(output, { severityThreshold, maxFindings })`

Pure filter over an already-validated output. Returns `{ findings, top5 }`: findings at
or above `severityThreshold`, sorted highest-severity-first, capped at `maxFindings`;
`top5` is the subagent's own `top_5_prioritized` list trimmed to ids that survived
filtering.

### `recordAdversarialDispositions(dispositions, { store, auditLogPath })`

Records one disposition per finding. Each entry requires `findingId`, a `disposition`
from the vocabulary below, and a non-empty `rationale` — a missing rationale is rejected,
since silent ignoring is forbidden. Writes via an injected `store(records)` function
(preferred for tests) or by appending JSON lines to `auditLogPath`.

## Findings Schema

```json
{
  "findings": [
    {
      "id": "string (optional — TC assigns finding_N if omitted)",
      "category": "boundary | malformed_input | concurrency | security | encoding | resource_exhaustion | other",
      "severity": "critical | high | medium | low",
      "scenario": "concrete attack input or sequence",
      "why_it_breaks": "exact failure mode predicted",
      "suggested_test": "minimal test code that reproduces the attack"
    }
  ],
  "top_5_prioritized": ["finding_id_1", "finding_id_2", "..."]
}
```

## Disposition Policy (methodology's responsibility, not TC's)

The methodology calling `runAdversarialPass` must record a disposition for every
finding it presents to a human or agent:

- **`regression_test`** — converted into part of the chunk's test suite.
- **`defensive_code`** — fixed directly (a guard, a validation, a lock).
- **`documented_non_issue`** — dismissed with a written rationale ("not in our threat
  model because X").
- **`follow_up_issue`** — escalated to a tracked issue for later.

Silent ignoring is forbidden; `recordAdversarialDispositions` enforces a non-empty
rationale on every entry so the audit trail always says why.

## Constitution

The default constitution TC ships (`DEFAULT_CONSTITUTION`) — a methodology may override
it per call:

```
You are an expert adversarial tester. Your only job is to break the code. Be creative, mean, and thorough.

Given the function requirements and the current implementation, generate the most difficult, nasty edge cases you can think of. Think like a hacker trying to break this code.

Focus especially on:
- Extreme values and boundary conditions
- Unexpected data types and malformed inputs
- Race conditions and concurrency issues
- Security vulnerabilities
- Empty, null, or massive inputs
- Internationalization and encoding edge cases

For each test case, explain exactly why it might break the code. Do not be nice. Try to destroy it.

PRIORITIZATION — at the end, rank your top 5 findings by likelihood x impact.

DO NOT generate findings that aren't actually exploitable or reachable from the documented input surface — false positives are worse than false negatives here, they teach the developer to ignore you.

OUTPUT — strict JSON matching the findings schema above.
```

`DEFAULT_PERSONAS` enforces breadth across at least three perspectives per pass: a
malicious user, a confused user, a non-English-speaker hitting Unicode/RTL/emoji edge
cases, a power user automating at scale, a script kiddie with curl/Burp Suite, and an
honest user who fat-fingers an oversized value.

## Anti-patterns to Avoid

1. **Finding fatigue** — too many low-quality findings teaches people to ignore the
   agent. The constitution's "no false positives" guardrail and the disposition
   policy's mandatory rationale both push against this.
2. **Scope creep** — adversarial-the-code is this primitive's one bounded scope.
   Adversarial-the-spec, adversarial-the-tests, adversarial-the-docs are explicitly out
   of scope for v1.
3. **Substituting for standard tests** — an adversarial pass is additive, not a
   replacement for happy-path tests.

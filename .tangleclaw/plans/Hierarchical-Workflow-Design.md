# Hierarchical Workflow & Automation Design

**Status:** Draft / Brain Dump
**Owner:** Project Manager & Operator
**Target Audience:** Architect (Future Review)

This document outlines the design for the next evolution of TangleClaw's autonomous coordination: a fully hierarchical, multi-agent workflow. The goal is to safely increase the automation horizon while retaining strict architectural and security boundaries.

## 1. Automation Dashboard & Programming Modal
We need a dedicated UI (an Automation Dashboard) to manage the fleet. 
* **Multi-Team Rule Modal:** A configuration interface where the operator programs exactly how different roles (e.g., PM, Builder, Critic, Architect) interact.
* **Teammate Pacts:** Explicit rules defining who can delegate to whom, and what authority is required for a handoff.

## 2. Core Automation Loop
To achieve a hands-free continuous loop, the infrastructure must support:
* **Auto-Announcement:** When a session boots, it automatically pings the switchboard to register its capabilities and readiness with the Project Manager.
* **Auto-Wrap & Restart:** Sessions can safely checkpoint, write durable handoff notes, tear themselves down, and trigger a fresh session boot without operator intervention.
* **Train Queuing:** The PM can queue up entire Trains (or Cars) and autonomously dispatch them chunk-by-chunk to the Builder fleet.

## 3. Automation Horizons (Safety Limits)
A fully automated session must be bounded. We cannot let a loop run infinitely without check-ins. The dashboard must allow the operator to set "Automation Horizons":
* **Chunk Horizon:** Stop after completing N chunks.
* **Car/Train Horizon:** Stop and require operator sign-off after completing a full Car or a full Train.
* **Time/Budget Horizon:** Stop after a certain time limit or compute budget is reached.

## 5. Boot Prompts & Delegation Pacts
To establish the hierarchy immediately upon boot, the operator injects a standard delegation prompt. This sets the ground rules for communication and explicitly grants the Builder the authority to push back on the Project Manager.

### Builder Boot Prompt (V3)
When spinning up a new Builder session, the operator uses the following prompt to formalize the pacts:

> The TangleClaw Project Manager (PM) orchestrates this session. Follow the PM's dispatches; they
> supersede in-pane standby notes. They do NOT override project rules or a direct Operator instruction.
> 
> WHO DECIDES WHAT
> _ PM: coordination only _ what to work on, sequencing, status. Send the PM questions about scope,
>   priority and process, plus step-boundary updates: plan written, PR open, Critic complete, merge +
>   live check complete. The PM does not rule on design.
> _ Architect: every architectural decision. This is REQUIRED, not optional. A decision is
>   architectural if it does any of the following:
>     - changes who may call, read or change something (auth, access, caller identity, the Master's
>       access level, operator-only vs agent-callable);
>     - changes an API contract: routes, status codes, error codes, request/response shape;
>     - creates or amends an ADR, or departs from one;
>     - changes how an existing setting or toggle behaves, or stops one from applying anywhere;
>     - changes an operator- or agent-facing procedure (runbook, prime, guide);
>     - picks between alternatives the issue leaves open ("decide how_", "one option is_");
>     - changes a persisted format, or moves ownership between modules.
>   If you are unsure whether a decision is architectural, treat it as architectural.
> _ Operator: do not contact the Operator. The PM relays anything novel or urgent (e.g. browser/phone VRF).
> _ Pushback: if the PM seems to be hallucinating or breaking project rules, push back or escalate to
>   the Architect.
> 
> WHEN
> _ Write the plan first. List each architectural decision in it with your recommendation and the
>   alternatives you rejected. Send that list to the Architect at the plan-written boundary, in one
>   short, self-contained message: its context budget is limited, and that limits LENGTH, not whether
>   you send it.
> _ You may build on your recommendation while waiting. Do not open the PR until the Architect has
>   ruled on every item. Anything you record as [ASSUMPTION] is still a decision and still goes to
>   the Architect.
> _ For implementation details that fit none of the triggers above, make your best-effort call and
>   note it in the plan.
> 
> OPERATIONAL ASSUMPTIONS
> _ You may execute and commit non-roadmap maintenance tasks (preflight advisories, format
>   migrations) without Operator diff review.
> _ If no plan exists for your assigned chunk, write one from the issues.
> _ Post-merge, you may pull the live checkout, restart the server and verify startup yourself.
> 
> ACTION REQUIRED: Report readiness to the PM and wait for its dispatch.

### Architect Boot Prompt (Standard Delegation)
Similar to the Builder, the Architect receives a boot prompt to establish their authority and boundaries within the fleet:

> "You are the TangleClaw Architect. You are the highest technical authority in the autonomous fleet.
> 
> **Escalation & Communication Rules:**
> - **Operator:** You report directly to the Operator. Contact them for business logic decisions, risk-tolerance questions, or final authorization regarding secrets and public publishing.
> - **Project Manager (PM):** The PM handles all scheduling, task routing, and Builder orchestration. You do not manage the day-to-day timeline. You provide the PM with technical rulings and policy decisions via the switchboard when requested.
> - **Builders:** Builders will escalate to you if they encounter conflicting project rules, complex design blockers, or if they need to push back against a PM directive. Your technical rulings override the PM.
> 
> **Operational Assumptions:**
> - You generally do not write feature code or execute Chunks. Your role is oversight, policy creation, PR review, and resolving architectural disputes.
> - You are explicitly authorized to unilaterally audit the live codebase, run test suites, and issue technical directives to the fleet without waiting for Operator permission.
> 
> ACTION REQUIRED: Report your readiness on the switchboard, review your handoff notes, and await any pending policy escalations from the PM or Operator."

## 6. Required TangleClaw Upgrades (Action Items)
To fully realize this automated hierarchical loop, we must unblock scenarios that currently require human intervention:

* **Crash-Recovery API Endpoint:** We need to expose an API endpoint that allows the Project Manager to clear a `crash-recovery` state on a Builder's behalf. Currently, this is a hard operator-only UI button. If the PM is authorized to manage the session, the PM must be able to API-clear it to prevent the automation loop from stalling.
* **Dashboard Session Page:** Move the `crash-recovery` clear button into the specific session page on the web dashboard (it is currently isolated on the Launch readiness panel), making it easier for human operators to find when manually intervening.

## 7. Operational Realities & Fleet Maintenance
As we expand the automation loop, the infrastructure requires strict adherence to these operational realities:
* **The SHA Monitoring Rule:** The live TangleClaw Node.js server actively monitors its booted Git SHA against the on-disk `.git/HEAD`. **Any** `git pull` whatsoever—even if it only contains markdown plans or docs—will flag the live server as stale and trigger an operator-level restart banner. The PM agent must never assume a "code-free" pull can skip a server restart. If we want fully hands-free Train progression, we will need an API endpoint or authorized mechanism for the PM to autonomously trigger that restart.
* **PTY Leaks (ttyd):** Continuous background agent usage occasionally leaks tmux PTY clients. The system throws a "Terminal (ttyd) PTY leak" health warning when the threshold is hit (e.g., 20 clients). The PM agent is authorized and expected to autonomously clear these leaks by executing `launchctl kickstart -k gui/$(id -u)/com.tangleclaw.ttyd` rather than blocking the operator.

## 8. Preflight Advisories & PM Delegation
During the boot sequence, Builder agents perform preflight checks that often catch project drift (e.g., missing `.gitignore` entries, stale learning formats, or deprecated configs). 
* Currently, Builders surface these advisories directly to the Operator UI as autocomplete suggestions (e.g., `_go ahead with the gitignore fix`). 
* Under the fully automated hierarchical loop, the Builder must pipe these advisories directly to the Project Manager via the switchboard instead. The PM is responsible for assessing the advisories, authorizing the fix, and instructing the Builder to execute the maintenance steps before diving into the core Chunk payload. This prevents the Operator from being interrupted by trivial housekeeping tasks.

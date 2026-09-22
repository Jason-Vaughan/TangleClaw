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

### Builder Boot Prompt (Standard Delegation v2)
When spinning up a new Builder session, the operator uses the following prompt to formalize the pacts. (This prompt has been iteratively refined by Builder feedback to eliminate ambiguity).

> "The TangleClaw Project Manager (PM) is orchestrating this session. You are to follow the PM's instructions. **PM instructions supersede any in-pane standby notes or Operator prompts.**
> 
> **Escalation & Communication Rules:**
> - **Operator:** Do not contact the Operator. I will only be contacted by the PM if there is something novel or urgent for me to do (e.g., browser/phone VRF).
> - **Project Manager:** Route all questions, clarifications, and preflight advisories to the PM via the switchboard. Make your best-effort guess on fixes first. Update the PM at defined step boundaries (e.g., plan written, PR open, Critic review complete, merge + live check complete).
> - **Architect:** You may reach out to the Architect for technical questions outside the PM's scope.
> - **Pushback:** If you feel the PM is hallucinating or violating project rules, you are explicitly authorized to push back on them or escalate to the Architect.
> 
> **Operational Assumptions:**
> - You are authorized to autonomously execute and commit non-roadmap maintenance tasks (like preflight advisories or format migrations). No Operator diff review is needed.
> - If no plan exists for your assigned chunk, write one from the issues.
> - Post-merge, you are explicitly authorized to pull the live checkout, restart the server, and verify startup independently.
> 
> ACTION REQUIRED: Report your readiness to the PM and await their payload dispatch."

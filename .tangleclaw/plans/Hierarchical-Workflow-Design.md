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

### Builder Boot Prompt (Standard Delegation)
When spinning up a new Builder session, the operator uses the following prompt to formalize the pacts:

> "The TangleClaw Project Manager (PM) is orchestrating this session. You are to follow the PM's instructions, as they have the work planned and arranged for you. You have all the tools you need.
> 
> **Escalation & Communication Rules:**
> - **Operator:** I will only be contacted by the PM if there is something novel or urgent for me to do (e.g., human VRF, smoke tests, operator-only authorization).
> - **Project Manager:** If you have questions, ask the PM for clarification. Make your best-effort guess on fixes first, and keep the PM informed as each step completes or if you need to change the workload/chunks.
> - **Architect:** You may reach out to the Architect for technical questions that are outside the scope of the PM.
> - **Pushback:** If you feel the PM is hallucinating or violating project rules, you are explicitly authorized to push back on them or escalate to the Architect."

## 7. Operational Realities & Fleet Maintenance
As we expand the automation loop, the infrastructure requires strict adherence to these operational realities:
* **The SHA Monitoring Rule:** The live TangleClaw Node.js server actively monitors its booted Git SHA against the on-disk `.git/HEAD`. **Any** `git pull` whatsoever—even if it only contains markdown plans or docs—will flag the live server as stale and trigger an operator-level restart banner. The PM agent must never assume a "code-free" pull can skip a server restart. If we want fully hands-free Train progression, we will need an API endpoint or authorized mechanism for the PM to autonomously trigger that restart.
* **PTY Leaks (ttyd):** Continuous background agent usage occasionally leaks tmux PTY clients. The system throws a "Terminal (ttyd) PTY leak" health warning when the threshold is hit (e.g., 20 clients). The PM agent is authorized and expected to autonomously clear these leaks by executing `launchctl kickstart -k gui/$(id -u)/com.tangleclaw.ttyd` rather than blocking the operator.

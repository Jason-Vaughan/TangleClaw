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

## 6. Required TangleClaw Upgrades (Action Items)
To fully realize this automated hierarchical loop, we must unblock scenarios that currently require human intervention:

* **Crash-Recovery API Endpoint:** We need to expose an API endpoint that allows the Project Manager to clear a `crash-recovery` state on a Builder's behalf. Currently, this is a hard operator-only UI button. If the PM is authorized to manage the session, the PM must be able to API-clear it to prevent the automation loop from stalling.
* **Dashboard Session Page:** Move the `crash-recovery` clear button into the specific session page on the web dashboard (it is currently isolated on the Launch readiness panel), making it easier for human operators to find when manually intervening.

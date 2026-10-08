# Agent Note: Retained PTC processes follow file policy

Status: implemented

English | [中文](2026-10-08-persistent-ptc-sandbox.zh.md)

## Problem

Retaining JavaScript variables does not require broader file access. A process that outlives one execution can also outlive a one-time approval or a Session policy change. Its file handles and background work must not retain authority after that authority ends.

## Decision

`persistent-in-memory` starts its Node process through the same sandbox provider as `per-call`. A retained owner uses one resolved mode, workspace root and Session identity until release. The [memory decision](2026-09-23-best-effort-persistent-ptc.md) owns retained values, failure recovery and package composition; this note owns file authority.

The file-policy service owns mode transitions. PTC reserves each Session execution before approval or directory resolution; Node registers each process for cleanup under the resolved policy's Session identity. `sandboxPolicy.setMode()` closes admission, cancels reservations and awaits registered resources before recording the new mode. Cleanup failure prevents the change. Direct sandbox-event appends reject while resources or operations are registered. Permission presets call the same setter as direct mode callers. The tools package keeps Agent ownership and omits the owner for temporary escalations; it does not depend on permission presets.

An approved one-time escalation omits the state owner and receives a fresh temporary environment. Its process is released before the call returns. It cannot access standing variables, and its declarations do not survive. The standing environment keeps its original policy and variables. Nested tools continue to apply their own permissions and approvals.

## Alternatives considered

**Unconfined retained execution.** Omitting confinement simplifies a temporary prototype but couples variable retention to full host file access. The existing process sandbox supports long-lived processes, so this grant is unnecessary.

**Changing the running process policy.** Existing backends apply restrictions at launch. Arbitrary retained objects, open handles and background work cannot be transferred into another policy with the existing interface. Releasing the environment gives the permission change a definite completion point.

**Coordinating through permission presets.** File-policy changes also have direct callers. The file-policy owner provides one cleanup operation for both paths and keeps user-facing preset selection out of the tool registry.

**Keeping an elevated environment.** A one-time approval cannot authorize future programs or idle background work. Omitting the state owner makes the approval lifetime explicit while preserving the standing environment.

## Consequences

Normal calls retain variables without changing file permissions. Changing sandbox mode discards variables and reports that reset in the permission command result. Escalated programs must be self-contained. Runtime consumers must release a retained owner before supplying a different policy; the provider rejects inconsistent reuse. The sandbox inherits the existing backends' file-effect coverage and platform limitations.

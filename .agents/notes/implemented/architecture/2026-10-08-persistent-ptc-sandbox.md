# Agent Note: Retained PTC processes follow file policy

Status: implemented

English | [中文](2026-10-08-persistent-ptc-sandbox.zh.md)

## Problem

Retaining JavaScript variables does not require broader file access. A process that outlives one execution can also outlive a one-time approval or a Session policy change. Its file handles and background work must not retain authority after that authority ends.

## Decision

`persistent-in-memory` starts its Node process through the same sandbox provider as `per-call`. A retained owner uses one resolved mode, workspace root and Session identity until release. The [memory decision](2026-09-23-best-effort-persistent-ptc.md) owns retained values, failure recovery and package composition; this note owns file authority.

The PTC consumer tracks retained and temporary owners under the Agent lifecycle. Permission preset changes run through an awaited waterfall before writing any permission events. PTC closes admission, cancels admitted calls, awaits environment release, and delegates the permission commit while admission remains closed. Cleanup failure prevents the permission change. Direct sandbox-event appends reject while retained environments remain; callers use the asynchronous permission preset setter to perform cleanup.

An approved one-time escalation receives a separate temporary owner. Its process is released before the call returns. It cannot access standing variables, and its declarations do not survive. The standing environment keeps its original policy and variables. Nested tools continue to apply their own permissions and approvals.

## Alternatives considered

**Unconfined retained execution.** Omitting confinement simplifies a temporary prototype but couples variable retention to full host file access. The existing process sandbox supports long-lived processes, so this grant is unnecessary.

**Changing the running process policy.** Existing backends apply restrictions at launch. Arbitrary retained objects, open handles and background work cannot be transferred into another policy with the existing interface. Releasing the environment gives the permission change a definite completion point.

**Keeping an elevated environment.** A one-time approval cannot authorize future programs or idle background work. A separate temporary owner makes the approval lifetime explicit while preserving the standing environment.

## Consequences

Normal calls retain variables without changing file permissions. Changing sandbox mode discards variables and reports that reset in the permission command result. Escalated programs must be self-contained. Runtime consumers must release a retained owner before supplying a different policy; the provider rejects inconsistent reuse. The sandbox inherits the existing backends' file-effect coverage and platform limitations.

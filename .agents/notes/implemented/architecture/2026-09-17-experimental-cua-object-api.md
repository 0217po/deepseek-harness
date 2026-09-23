# Agent Note: Native CUA objects independent of evaluator ownership

Status: implemented

English | [中文](2026-09-17-experimental-cua-object-api.zh.md)

## Problem

Computer-use programs need consistent app and window operations. Coupling those operations to a CUA-specific interpreter makes input handling depend on unrelated choices about variable persistence, imports and cancellation.

## Decision

The experimental CUA package owns a native-app subset of the Codex-style object interface and selected MIT-licensed macOS primitives copied from Cua Driver. A source manifest records copied files and local integration. The helper is locally compiled; the package has no external Cua Driver runtime dependency. The existing [provider registration](2026-09-12-computer-use-provider-registration.md) prevents competing computer-use providers within one composition.

The facade accepts an operation dispatcher. Its tool adapter resolves the current tool binding for each operation, preserving normal authorization, logging and image admission. The execution host owns variable persistence and completion serialization. CUA defines no persistence directive, worker or run_code replacement.

A live Agent owns one serial native helper. App handles bind process identity and kernel start time; replacing the process or helper never revives old handles. AX snapshots are scoped to an app and optional window, so independent window observations remain usable. Coordinate actions select an owned window and use window-local points. Keyboard input remains app-scoped because macOS delivers it to the app's current focus.

## Alternatives considered

Depending on the complete upstream driver would simplify upgrades but does not meet the requirement for locally owned implementation. Copying browser and other platform code would add unsupported scope. The JSON operation protocol allows another native implementation without changing object consumers.

A CUA-specific persistent evaluator duplicates execution lifecycle policy and prevents independent iteration on PTC. Requiring callers to manage raw app and snapshot tokens alone loses reusable object semantics. The facade and small tool adapter provide those semantics while leaving the evaluator outside this package.

## Consequences

The package remains opt-in and macOS-only. Observations do not lock the desktop, and input success records dispatch rather than task completion. Callers must verify effects and must not retry uncertain input automatically. Native fixture tests verify actual window state separately from protocol and model-transcript tests. Persistent execution, binary distribution, permission onboarding and real-model task success remain separately owned work.

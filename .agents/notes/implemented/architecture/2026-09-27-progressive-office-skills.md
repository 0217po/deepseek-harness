# Agent Note: Progressive Office skills with ordinary shell execution

Status: implemented

English | [中文](2026-09-27-progressive-office-skills.zh.md)

## Problem

Combined authoring and rendering instructions spend context on operations unrelated to ordinary editing. Rendering tool activation adds a second discovery path and durable state even though shell tools already own execution permissions and process management. A missing renderer can prevent loading otherwise usable editing guidance.

## Decision

The [skill registry](../../../../packages/skill/skill/README.md) preserves optional `modelCatalogVisibility` metadata and retains every winning candidate. Model catalogs filter `unlisted` entries after scope and same-name resolution; named loading and invocation permissions remain independent. Loaded skill instructions can name deferred skills without making a tool registration or activation state.

The [Office provider](../../../../packages/skill/skill-office/README.md) advertises only a compact router. Format-specific authoring and rendering, recalculation, and PDF export are separately callable unlisted skills. The model loads them by name and selects rendering for appearance-focused changes unless the user explicitly skips it. Rendering uses a private, randomly named temporary directory inside the task workspace and removes it after inspection. Skills invoke `office-check` and `dsoffice` through ordinary Bash or PowerShell. Common base composition enables immutable skills, the Office command plugin, and the general dependency query only for a supplied runtime. Ordinary Web does not supply or download interpreters. Web presets own tool exposure and minimal presets retain only shell tools.

The command plugin contributes local launchers through [shell-env](../../../../packages/shell/shell-env/README.md) to each shell call's `PATH`. Carriers own interpreter and resource locations; those paths stay outside skill instructions. Loading skills and registering commands do not prepare engines or authoring payloads. Standalone rendering, PDF export, and recalculation require only their operation skill. This keeps instruction loading independent of installed runtime layout while shell execution retains its existing permissions and process management.

Office dependency ranges allow patch updates; the root lock records the resolved adapter and engine versions.

## Alternatives considered

**Keep a dedicated renderer tool.** A small typed schema constrains rendering arguments, but requires its own execution configuration, scoped registration, projection, and activation lifecycle. The CLI operation skills accept shell quoting and model-selected arguments in exchange for reusing the existing approval, sandbox, cancellation, and output mechanisms.

**Hide skills by denying model invocation.** This also prevents the router from loading them. Visibility must affect discovery without granting or revoking permission. Filtering before winner selection would incorrectly reveal overridden skills.

**Automatically inject guides for file extensions.** Extensions do not distinguish text edits, recalculation, conversion, and requested visual checks. Model-selected routing keeps unrelated operations out of context and permits explicit direct invocation.

## Consequences

Instruction loading appends ordinary logged skill results; completion does not erase them. Historical tool records remain readable and existing declaration reconciliation handles resumed sessions without a Session format change or agent-loop modification. A dedicated renderer would need a new independently justified user or security requirement before reintroduction.

Verification covers visibility defaults, scoped overrides, denied and explicit invocation, authoring without executable paths, native/PTC requests, resume and fork, ordinary and minimal profile composition, resource packaging, context budgets, and real-model operation selection. Rendering failures preserve usable sources and stop visual checks; successful commands alone cannot establish usable images.

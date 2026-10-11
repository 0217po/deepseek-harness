---
description: "Read the scope of the reserved Windows C# Computer Use provider."
kind: "package-reference"
---

# Windows Computer Use

English | [中文](README.zh.md)

## Summary

Windows native execution is reserved for a separate C# helper. This directory contains no loadable provider yet. The implementation will consume the [shared CUA object API](../cua/README.md) and preserve its app/window methods, authorization, snapshot validity, and action-result semantics. macOS implementation and build files belong to [cua-macos](../cua-macos/README.md).

## Table of Contents

- [Implementation scope](#implementation-scope)
- [Dev Note](#dev-note)

-----

<a id="implementation-scope"></a>
## Implementation scope

The Windows implementation must document system-specific limitations and provide cross-compilation evidence separately from Windows desktop validation.

-----

<a id="dev-note"></a>
### Dev Note

This directory reserves the Windows implementation home. It has no package manifest, plugin, executable, or runtime dependencies.

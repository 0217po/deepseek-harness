# Windows Computer Use

English | [中文](README.zh.md)

Windows native execution is reserved for a separate C# helper. This directory contains no loadable provider yet. The implementation will consume the [shared CUA object API](../cua/README.md) and preserve its app/window methods, authorization, snapshot validity, and action-result semantics. macOS implementation and build files belong to [cua-macos](../cua-macos/README.md).

The Windows implementation must document system-specific limitations and provide cross-compilation evidence separately from Windows desktop validation.

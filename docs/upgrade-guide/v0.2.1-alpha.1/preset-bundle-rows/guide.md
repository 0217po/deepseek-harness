---
kind: upgrade-guide
description: "Plugin-manager bundle inventories include preset-scoped rows whose row IDs are unique only within their preset."
---

# Identify bundle rows by their preset

English | [中文](guide.zh.md)

## Change

The next release adds preset-scoped declarations to `PluginManager.listBundles().rows`. A bundle can declare the same `rowId` in several presets. `PluginRowRef` values passed to detail slots carry the same optional `preset` identity. These rows carry `preset`, optional `composition` state, and `readOnlyReason: 'preset-managed'`; they do not carry an editable root `entryId`.

Clients that key rows only by bundle name and `rowId`, or treat every row as a root plugin switch, must distinguish preset declarations. Existing root rows retain their current identity and controls.

## Migration

1. Include `preset` in row identity, alongside the bundle name and `rowId`. Keep the absent-preset case distinct from every named preset.
2. Render `preset-managed` rows read-only in direct row controls. Use the bundle switch or an explicit scoped profile patch to configure them. Only pass a returned root `entryId` to `setPluginEnabled`.
3. Read preset row state from `composition`, instead of looking up a root Loader entry with the same `rowId`.
4. For YAML edits, use `preset` to address the outer declaration and `id` to address its child:

   ```yaml
   - preset: preset-standard
     id: optional-tool-str-replace-editor
     disabled: true
   ```

5. Verify that a bundle contributing to standard, cordis, and ptc shows three distinct rows and that root-row switches continue to work. The [profile patch reference](../../../../packages/boot/app-boot/README.md) describes ordering and validation.

---
kind: upgrade-guide
description: "Claude Code and Codex bundles add delegation tools to full Web presets while retaining their package and row identities."
---

# Native subagent bundles include preset tools

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-subagent-claude-code` and `@deepseek-ai/dsh-subagent-codex` keep their package names, bundle selections, provider row IDs, configuration, and native authentication. In Web and Desktop, a selected bundle now adds enabled delegation tools to `preset-standard`, `preset-cordis`, and `preset-ptc`; previously the bundle registered only its provider. Existing Agents retain their composition; new Agents and subsequently reopened Sessions receive the selected tools.

The contributed rows retain `tool-subagent-claude-code` and `tool-subagent-codex`. Later user layers can override their configuration or disabled state, and a complete preset configuration replacement keeps its own child list. An override does not select an unselected bundle. Duplicate declarations of the same model-facing tool still fail.

Delegation follows the shared managed-activation API: the tool returns a child ID, and completion arrives as a logged notice to the parent Agent. Remove obsolete `backgroundMode` settings; `maxDepth: provider-managed` remains supported for these native providers.

## Migration

1. Preserve selected bundle names, provider configuration, and authentication. Existing provider-only packages need **Update** in Plugins → Official to receive the tool-contributing bundle; restart when requested. To adopt a new provider, enable its card. [Installation targets](../../../../packages/boot/plugin-manager/README.md#use-this-package) follow the published DSH version or source checkout; equal version strings do not make an older registry package equivalent to a development link. Off only deselects; Remove remains separate.
2. Configure the familiar tool row ID with a scoped patch. Configuration overrides still replace the complete configuration. For example, this keeps Codex disabled in standard while other full presets use their selected composition:

   ```yaml
   - preset: preset-standard
     id: tool-subagent-codex
     disabled: true
   ```

3. If an additional manual row registers the same tool in a preset, remove that redundant row or disable the bundle's contribution explicitly. A copied complete preset can retain its existing tool declarations and disabled state. Verify the effective tool catalog in a new Session; minimal keeps its current shell and working-directory tools.
4. Plugin clients receive required `BundleInfo.official` and `BundleInfo.availability` fields; detail-slot `PluginPackageRef` receives them too. `official` identifies project maintenance, `availability` reports `installation`, `profile`, or `missing`, and `installed` still means a profile dependency declaration. Detail-slot readers that only display existing fields need no changes; constructors and exact validators must include the new fields. Optional `installTarget` identifies the offered version and registry or local-link spec.

**Other profiles.** Headless, SDK, ACP, and custom profiles without the three full preset targets are outside this compatibility scope. Selecting these bundle layers fails for missing preset targets and can retain the saved selection; there is no automatic rollback. Such profiles can keep the installed provider package without selecting its bundle and explicitly compose provider/tool rows using the [Codex](../../../../packages/subagent/subagent-codex/README.md#exposing-the-tool) or [Claude Code](../../../../packages/subagent/subagent-claude-code/README.md#exposing-the-tool) example.

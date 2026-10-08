---
description: "Run explicitly requested repeated work with fresh agents."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-ralph-bundle

English | [中文](README.zh.md)

## Summary

Add the experimental Ralph tool to standard, cordis, and ptc for human-requested repeated work with fresh child agents. It ships switched off in Web and Desktop. Select it in Plugins to enable it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

In Web or Desktop, open Plugins and enable **Ralph loops** in Official. Switch it off to remove its profile layer.

New Agents and subsequently reopened Sessions use the selected composition; live Agents retain their existing plugins. The minimal preset and host-level tool catalog remain unchanged.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) contributes `tool-ralph` through `preset: preset-standard`, `preset: preset-cordis`, and `preset: preset-ptc`, inside the isolated `optional-ralph` group. Later scoped patches can replace the tool's configuration or disable it; an override alone does not select the bundle. The [profile composer](../../boot/app-boot/README.md) owns patch ordering and errors.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Capability implementation](../tool-ralph/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [capability implementation](../tool-ralph/README.md), which owns model context and results.

#### KV Cache effect

The layer adds no request content directly; the capability implementation owns cache effects from tools, prompts, and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Ralph requires explicit human intent to run a loop and can consume substantial model tokens across rounds. Its workflow engine is isolated from other workflow tools.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context — click to expand</summary>

None.

</details>

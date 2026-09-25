---
description: "Enable experimental Computer Use and persistent PTC from the plugin page."
kind: "package-bundle"
---

# @deepseek-ai/dsh-cua-bundle

English | [中文](README.zh.md)

## Summary

Enable macOS Computer Use from Plugins and use persistent PTC in the current profile. It is off by default; disabled profiles prepare no native components and register neither CUA tools nor their model guidance.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Run the following commands from the repository root, then open Plugins → Official → Computer Use. Its card marks the feature experimental and explains that this profile switches to persistent PTC, retaining variables across calls without a file sandbox.

```sh
pnpm run build
pnpm dsh web
```

The switch reuses `dsh.profile.bundles` in the profile's `package.json`. Enabling prepares native components; source startup also checks an already enabled profile. Subsequent `pnpm run build` reads the same selection in the existing Web profile and checks the incremental build only when selected. First preparation requires local compiler tools and takes machine-dependent time; failures retain their diagnostics and publish no new executable.

Disabling unloads CUA and its persistent runtime, cancels and awaits owned operations, clears retained variables, and restores the preceding tool/runtime configuration. After a project build updates the executable, re-enable or restart to replace running helpers.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details</summary>

`cordis.patch.yml` inserts the registration service, CUA provider and persistent PTC, overriding the default runtime and tool mode. Plugin management persists bundle selection and performs ordinary recomposition; there is no second enabled flag. This configuration-only bundle has no independently mutable projection, so no runtime invariant companion is published.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Computer use](../../../docs/subsystems/computer-use.md)

-----

<a id="model-experience"></a>
## Model Experience

### Computer Use and persistent PTC

#### What the model sees

Enabling contributes the CUA tool, guidance and persistent PTC execution instructions; disabling withdraws them. [CUA](../cua/README.md) and [PTC](../../ptc-runtime/ptc-runtime-node/README.md#persistent-repl) own the full interfaces and output semantics.

#### Token effect

Enabling adds CUA guidance and changes the `run_code` description. Disabling withdraws these contributions.

#### KV Cache effect

Enabling and disabling change tools and system guidance; subsequent requests use the updated prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Qualification currently covers repository Web launches on macOS. Desktop installation integration and system-permission onboarding are separate work.
- Enabling changes tool presentation and the PTC runtime for the current profile; it is not a per-task mode selector.

<a id="dev-note"></a>
### Dev Note

None.

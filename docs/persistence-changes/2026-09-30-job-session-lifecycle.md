---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-job-session-lifecycle

English | [中文](2026-09-30-job-session-lifecycle.zh.md)

## Summary

Records owned job registration and settlement as log-only Session events with execution identity, original timestamps, creating tool calls, and producer termination acknowledgement.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-job-session-lifecycle
baseline: false
changes:
  - root: "event:job/registered"
    previous: null
    after: "f05be3e066ef054a610f0825251f19ee3fcfc98908b5ceaa869ee143d7e91fa5"
    decision: same-version
  - root: "event:job/settled"
    previous: null
    after: "e1a4e287dd40ca5559cc4a00bef7e111631c2556e17a114b7a21dfa735487782"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Adds event kinds without changing existing payloads or the Session envelope. Historical sessions remain valid and receive no fabricated job history. Older builds reject unknown required event types. These facts do not resume work, alter model messages, or certify resource release after forced failure.

<a id="verification"></a>
## Verification

Focused jobs registry and snapshot-normalizer tests passed: 181 tests with 100% affected-file coverage. Producer tests passed: 432 tests, 7 platform skips, with 100% affected-file coverage. SDK replay and persistence verification are included in the same change.

<a id="dev-note"></a>
## Dev Note

None.

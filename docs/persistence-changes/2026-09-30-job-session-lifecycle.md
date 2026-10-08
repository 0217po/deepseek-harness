---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-job-session-lifecycle

English | [中文](2026-09-30-job-session-lifecycle.zh.md)

## Summary

Records owned job registration and settlement as log-only Session events with execution identity, original timestamps, creating tool calls, and producer completion reports.

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
    after: "a103c03b3bc0ca7a7809d1eb2572dec08899f7a15a90072736777acd4e517648"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Adds event kinds without changing existing payloads or the Session envelope. Historical sessions remain valid and receive no fabricated job history. Older builds reject unknown required event types. producerReported describes fulfillment of the producer completion promise, not verified resource release.

<a id="verification"></a>
## Verification

Focused registry, normalizer, shutdown, and headless regressions cover causal publication order, distinct execution identities, and cleanup within the existing exit bound. Real CLI snapshot and SDK replay verify registration/settlement persistence and notifications.

<a id="dev-note"></a>
## Dev Note

None.

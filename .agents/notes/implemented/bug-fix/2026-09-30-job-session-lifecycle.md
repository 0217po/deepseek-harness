# Agent Note: Persist owned job lifecycle facts

Status: implemented

English | [中文](2026-09-30-job-session-lifecycle.zh.md)

## Problem

SDK consumers receive Session events, while job registration and settlement previously existed only in the live registry. A background tool can return before work finishes, and output collection can happen much later or never. Tool invocation times therefore cannot reconstruct a job's execution interval. Runtime-local ids also repeat after a registry restart.

## Decision

The local provider captures `job/registered` and `job/settled` facts for owned jobs, retaining the registry's epoch-millisecond timestamps, original owner, producer kind, label, and optional creating tool call. An execution UUID pairs records across restarts and copied history without changing the ids accepted by job controls. Unowned work has no Session journal.

The terminal record distinguishes a producer report from forced bookkeeping: `producerReported` is true when `JobHooks.done` fulfills, and false when that promise rejects or teardown cancellation throws. It reports fulfillment, not independently confirmed resource release. Missing terminal records remain incomplete and are not reconstructed from later reads or process restart.

Facts are appended synchronously at the registry commit before live hub reactions and completion waiters resume. Recording errors warn independently: already-started work still has its control id, and a failed journal append cannot prevent cleanup or release of waiters. The Session's ordinary persistence and SDK notification paths own delivery after append. SDK `run()` results cover bounded observation windows and can receive a settlement whose registration belongs to an earlier run; settlement records retain the registration facts for that consumer.

The [registry contract](../../../../packages/jobs/jobs/README.md) and [seam consolidation note](../architecture/2026-09-03-jobs-seam-consolidation.md) own live execution, resource ownership, and event routing. This journal adds durable observations without replacing those responsibilities.

## Alternatives considered

**Add timestamps only to `job_output`.** A model may never collect a job or may collect it after a long delay. Logging lifecycle commits records both cases without additional model calls or consuming output.

**Pair by job id alone.** The per-kind counter restarts with the registry, and Session history can outlive it. Execution UUIDs preserve equality across both lifecycle records without treating copied history as new execution.

**Defer publication or propagate recording errors.** Deferral lets a synchronous hub subscriber journal a completion notice before the settlement that caused it. Throwing after the starter succeeds can hide an already-running job from its caller. Synchronous, contained recording preserves causal order without abandoning execution.

## Consequences

The log and both SDKs expose execution intervals without changing tool schemas, model messages, output cursors, completion notices, or job scheduling. These intervals run from registration commit through registry settlement, including the producer work and cleanup between those points; they are neither CPU time nor a directly additive rollout-latency metric. Hard process loss or an append failure can leave incomplete history. Persisted facts do not resume an external process or its output ring.

Focused tests cover original timestamps, nested call identity, output preservation, delayed cancellation, producer rejection, forced teardown, late completion, reused control ids, causal publication order, and recording-failure containment. SDK snapshots cover the durable and protocol projections.

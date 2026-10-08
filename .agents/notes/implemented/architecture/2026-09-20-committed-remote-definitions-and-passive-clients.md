# Agent Note: Committed Remote definitions and passive clients

Status: implemented

English | [中文](2026-09-20-committed-remote-definitions-and-passive-clients.zh.md)

## Problem

A command or tool needs discoverable input documentation and validation before connecting to a Host. Recovering that information from running Services makes offline help depend on application boot, while a separate command schema or invocation dispatcher creates another authority for the same operation. Source launches also need the same selected request validation as published builds.

A consumer that only invokes methods must not implicitly join forwarded user-interaction waterfalls. Joining those deliveries can delegate or settle interactions even when that consumer has no user interface.

## Decision

The [Typert method-call design](2026-08-02-typert-remote-method-calls.md) retains ownership of dispatch, generated signatures, lookup resolution, and carrier-independent invocation. Selected methods declare `@Remote({ emitSourceDef: true })`; the existing compiler-independent model emits committed source definitions, published definitions, and consumer metadata from their owning method and type declarations. The Host binding carries generated definitions explicitly, and a selected source method without its definition fails rather than using JSON-only validation. Closing request objects is a separate `rejectUnknownFields: true` choice, accepted only with `emitSourceDef`, so selecting a method for offline consumers does not change the request policy of its existing callers.

The committed module contains parsers, method and field documentation, supported tool JSON Schemas, and typed calls to the ordinary Client Remote methods. Consumer selection and presentation do not redefine business schemas. Methods that also declare `rejectUnknownFields` reject unknown fields in declared request objects at the Host and in their tool schemas; explicit dictionaries and other methods keep their own policy. Unsupported input schemas fail generation; outputs retain their codec and omit optional JSON Schema when lossless projection is unavailable. Semantic constraints absent from TypeScript remain with their operation owner.

Generation verification compares committed source against current owner declarations. Normal artifact publication also performs that check, so a build cannot silently publish a different definition from the source launch. Type-only owner imports keep metadata loading independent of Host Service activation. The [compiler-independent model](2026-07-27-compiler-independent-typert-model.md) remains the extraction and projection authority.

Connection owns authenticated HTTP and physical WebSocket access. Gateway owns Remote framing and method invocation. A Gateway Client receives forwarded Host events only with `forwardedEvents: true`; without it, `$on()` and `$stream()` fail instead of waiting for deliveries or generations that never start. The Web bundle sets the Host Gateway row's `forwardedEvents`, which publishes the choice to served pages. Node compositions use the existing Client entries and generated contributions, with instance-owned carrier hooks and awaited disposal, and stay passive unless they configure the option.

## Alternatives considered

**Handwritten CLI/tool schemas and dispatch.** Every operation change would update two authorities.

**Runtime TypeScript analysis.** Help and request validation would depend on compiler availability and application startup.

**Weak source fallback for selected methods.** Source launches would accept requests that the corresponding published Host rejects.

**Automatic event participation.** Subscribing every Remote client to forwarded events would couple passive observation to interactive answer ownership.

## Consequences

Owners regenerate committed metadata when selected signatures or documentation change. Generated files increase the reviewed diff, but an executed freshness check rejects drift. The tool projection intentionally supports a bounded JSON Schema language and refuses unsupported types without weakening them.

Generation keeps the face's contributing packages in one stable TypeScript program: limiting program roots to emitted packages would omit externally declared members and make focused metadata disagree with the complete build.

Generated schema tables and calls repeat emitter templates. Generator and owner integration suites verify their behavior, while repository per-file coverage and clone detection omit the emitted code. The coverage exclusion and source inventory share one exact path pattern; the inventory rejects unowned files, and byte-for-byte verification rejects handwritten additions to owned files. These checks retain the coverage requirements for authored sources and the typechecking and lint requirements for generated sources.

Verification compares source and published parsers, rejects unknown and missing inputs, typechecks generated calls, rejects stale artifacts before publication, and observes passive and interactive clients over real HTTP and WebSocket carriers.

---
kind: upgrade-guide
description: Custom Remote Client compositions must explicitly enable forwarded Host events for subscriptions and interaction handling.
---

# Opt into forwarded Host events

English | [中文](guide.zh.md)

## Change

Gateway Clients are passive by default. Generated unary and streaming methods remain callable, but `$on()` subscriptions and the event-supervised `$stream()` API require `forwardedEvents: true`. Passive callers do not join approval/question waterfalls or start the forwarded-event Connection recovery loop.

The shipped Web profile enables forwarding explicitly. Custom profiles and direct Client compositions that relied on automatic forwarding must choose whether to participate.

## Migration

1. For a custom Web profile that handles interactive Host events, set `forwardedEvents: true` in the Host `@deepseek-ai/dsh-api-gateway` entry's `config`. Gateway publishes this choice to served pages; see the [shipped Web patch](../../../../packages/bundle/web-app/cordis.patch.yml).
2. For a direct Client composition, pass `{ forwardedEvents: true }` to the `@deepseek-ai/dsh-api-gateway/client` plugin only when it owns subscriptions or interaction handling. CLI/MCP callers that only invoke generated methods should remain passive. An explicit Client choice overrides the serving page's choice.
3. Keep Connection transport hooks instance-owned and await Context disposal. Forwarding does not replace authentication, and generated method streams do not require forwarding.
4. Verify that interactive clients receive subscribed events and can answer interactions. Verify that passive clients can call generated methods while `$on()` and `$stream()` reject immediately; see the [Gateway runtime documentation](../../../../packages/api/gateway/README.md).

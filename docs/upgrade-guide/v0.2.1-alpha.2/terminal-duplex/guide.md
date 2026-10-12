---
kind: upgrade-guide
description: "Terminal Remote clients use one attach stream for screen output, keyboard input and resizing."
---

# Terminal input and output share an attachment stream

English | [中文](guide.zh.md)

## Change

Custom clients of `@deepseek-ai/dsh-api-terminal-controller` replace `terminal.follow`, `terminal.write` and `terminal.resize` with `terminal.attach`. `TerminalAttachmentId` and `WebTerminalInfo.controllerId` are removed. Screen snapshots and state frames carry an attachment-specific `writable` flag. The bundled Web client uses this protocol automatically.

## Migration

1. Upgrade the Host and browser assets together. Custom clients open `remote.terminal.attach(sessionId, terminalId, signal)` and iterate its screen, output, state and acknowledgement frames.
2. Send `TerminalInput` commands with the handle's `send()`: `write` carries `data`; `resize` carries `cols` and `rows`. Number commands consecutively from one for each attachment. An `ack` confirms provider acceptance unless its `refusal` reports lost control or an exited process. Keep unacknowledged input within the advertised byte limit; `send()` alone does not confirm acceptance.
3. Read `writable` from each snapshot or state frame. Stop input after a refusal while continuing to display output. Reconnect with a fresh attachment and screen; never replay unacknowledged input. Keep `retain` and explicit `close` independent of attachment cancellation.
4. Verify keyboard input, resizing, control transfer between two windows, and screen recovery after reconnect. See the [package reference](../../../../packages/api/terminal-controller/README.md) for process ownership and limits.

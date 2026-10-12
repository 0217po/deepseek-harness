# Agent Note: Chat 分组树位置与交互段

Status: implemented

[English](2026-10-11-chat-group-tree-exchanges.md) | 中文

## Problem

「下次发送时收起」原本只让已加载时间线的最后一个 Turn 保持展开。由通知唤醒的 Turn（子 agent 完成、Goal Round、定时任务、后台作业）不是本客户端提交的，它一出现，上一轮就被当作历史折叠。这次折叠没有自己输入的驱动来计算精确的剩余补白，滚动层只能按通用规则预留底部空间，正在跟尾的读者因此看到一片空白。录制的真实 Session 中，通知在上一轮结束后 13–15 ms 唤醒新轮次；最小复现里空白高 596 px，五秒后仍未恢复。

## Decision

通知不算正文，也不算用户消息：折叠和推进底部时都忽略它。底部从"最后一个 Turn"改为"最新交互段"。

- **分组树位置。** `ChatConversationViewNode.groupTree` 声明节点在分组树中的位置，类型为 `ChatGroupTree = 'exchange' | 'turn' | 'process'`，由外到内有序；站在某个位置的节点同时也站在所有内层分组之外。`isAtOrOutside(node, position)` 是读取这一顺序的唯一入口。目前只读取 `exchange`；`turn` 和 `process` 预留给以后把 `TURN_PROCESS_INDEPENDENT_KINDS` 与过程组 `INDEPENDENT` 两份 kind 名单迁移过来，届时不改变 `exchange` 的含义。
- **交互段。** 含 `exchange` 节点的 Turn 开启一个交互段，交互段持续到下一个开启 Turn。业务层的 message Definition 只给 Step 1 中被认领的真人输入（`user` 或 `steering`）标 `exchange`；通知和之后的 steering 不标。
- **机制。** `GroupTreeSegments(position)` 按含该位置节点的 Turn 切分已加载的 Turn，最新一段从最后一个开启 Turn 开始，窗口中没有开启 Turn 时从第一个已加载 Turn 开始。它按 Turn 增量计数，不扫描已加载节点；起点移动时只返回进入或离开最新一段的 Turn。Chat Builder 的 `bottomSource` 为"节点可见且属于最新交互段"。

结果是：通知唤醒的 Turn 不再折叠前面的 Turn，没有折叠就没有补白；真人下一次普通输入时，整个交互段经由自己输入的路径一起折叠。

## 为什么标开头而不是标通知

Host 在 `turn/start` 之后立即认领唤醒输入，然后组装系统提示，再写 `step/start` 和 `user/message`。录制的 Session 中这段间隔为 187 ms。只给通知打标的话，这段时间新 Turn 还没有标签，底部照样推进，上一轮会先折叠再展开。把标签放在真人开头上、未标的 Turn 默认续接，空白间隔里什么都不会发生。

## Alternatives considered

**给通知打"续接"标签。** 上面那 187 ms 的间隔会让它先折后展；同一次认领里通知和真人输入并存时还要额外判断。

**按 kind 写一张开启名单（`user`、`steering`）。** kind 区分不了 Step 1 的 steering 与 Turn 中途的 steering，真人往通知唤醒的 Turn 里插话时会错误地折叠前一个交互段。

**发布到 Turn 级 Location data。** 同一 Turn 的同一个 key 只允许一个 Context 发布，而开启输入来自多个消息 Context；改成按 Turn 汇总就得在新的 Definition 里重复 inbox 认领分类，并且每次都要读取所有 Turn。

**节点声明业务角色（`input`、`notice`）。** 这会把业务语义放进分组机制；分组树位置只描述结构，业务 Definition 自行决定位置。

**修正非自身输入折叠时的滚动补白。** 通知本来就不应触发折叠，修补白不能消除这次不必要的折叠；它仍是另一个标签页里真人输入的残留问题。

**这次就迁移两份 kind 名单。** 改动面明显超出这次缺陷；类型先预留位置，迁移另做。

## Consequences

- 通知唤醒的 Turn 不再产生折叠、补白和空白；分组机制读取节点声明的位置，而不是点名 kind。
- 「下次发送时收起」下，一长串通知唤醒的 Turn（抽样会话中 Goal 模式最长 31 轮）会一直展开，直到真人再次输入。
- 已加载窗口里没有开启 Turn 时，所有已加载 Turn 都属于最新交互段。
- 另一个标签页里的真人输入在它的 `user/message` 到达时才折叠，比原来在 `turn/start` 时晚约 200 ms；这类折叠仍使用通用补白，本次没有修改。

## Testing

- `packages/client/ui-chat/tests/group-tree-segments.client.spec.ts`：位置顺序、切分、计数回退与空窗口。
- `packages/client/ui-chat/tests/chat-node-bottom.client.spec.ts`：最新交互段的成员与通知范围。
- `packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts`：真实 assembler 下的开轮、中途 steering、Step 1 前的间隔、通知唤醒与空闲 steer。
- `apps/web/tests/notice-wake-tail.e2e.ts`：长 Turn 之后由通知唤醒，在 Step 1 前的间隔和通知回复之后，上一轮都保持展开，跟尾读者看到通知与回复。

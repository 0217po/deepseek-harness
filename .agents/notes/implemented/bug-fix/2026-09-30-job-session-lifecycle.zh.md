# Agent Note: 持久化有所有者 job 的生命周期事实

Status: implemented

[English](2026-09-30-job-session-lifecycle.md) | 中文

## Problem

SDK 消费方接收 Session 事件，而 job 注册和结算此前只存在于运行期注册表中。后台工具可能在工作结束前返回，输出收集则可能晚得多，甚至永远不发生。因此工具调用时间无法重建 job 的执行区间。运行期 id 也会在注册表重启后重复。

## Decision

本地提供方为有所有者的 job 捕获 `job/registered` 与 `job/settled` 事实，保留注册表的 Unix 毫秒时间戳、原始所有者、生产方 kind、label 和可选的创建工具调用。执行 UUID 在重启和历史复制后仍能配对记录，同时不改变 job 控制接口接受的 id。无主工作没有 Session 日志。

终态记录区分生产方确认与强制记账：`JobHooks.done` fulfilled 时 `terminationConfirmed` 为 true，该 promise 拒绝或销毁取消抛错时为 false。它描述生产方对资源释放的确认，而不是独立的 OS 进程观测。缺少终态记录时保持不完整，不根据较晚的读取或进程重启重建。

事实在注册表提交时捕获，并在完成等待方恢复前按微任务顺序发布。这避免 Session 观察者启动 job 时重入 Session append。记录错误单独发出警告：已启动的工作仍有可控制的 id，日志追加失败不能阻止清理或释放等待方。追加后的投递由 Session 既有的持久化和 SDK 通知路径负责。

运行期注册表与资源归属决策仍由[通用运行时说明](../architecture/2026-06-20-generic-long-running-tool-runtime.zh.md)和[seam 收敛说明](../architecture/2026-09-03-jobs-seam-consolidation.zh.md)负责。这些记录保持有效；本日志增加持久化观测，不替代其执行或事件路由职责。

## Alternatives considered

**仅向 `job_output` 添加时间戳。** 模型可能永远不收集某个 job，也可能很晚才收集。记录生命周期提交能覆盖这两种情况，无需额外模型调用或消费输出。

**仅按 job id 配对。** 每个 kind 的计数器随注册表重启，而 Session 历史可能更长久。执行 UUID 保留两条生命周期记录的相等关系，不将复制的历史视为新执行。

**同步追加或传播记录错误。** Session 观察者可以启动工作，因此同步发布可能重入 append。starter 成功后抛错可能使调用方拿不到已运行 job 的 id。延后并隔离记录错误能保留预检与资源生命周期保证。

## Consequences

日志与两种 SDK 暴露执行区间，不改变工具 schema、模型消息、输出游标、完成通知或 job 调度。区间从注册提交延续到注册表结算，包含这两个时刻之间的生产方工作与清理；它既不是 CPU 时间，也不是可直接相加的 rollout 延迟指标。进程硬退出或追加失败可能留下不完整历史。持久化事实不会恢复外部进程或其输出环。

定向测试覆盖原始时间戳、嵌套调用标识、输出保留、延后取消、生产方拒绝、强制销毁、较晚完成、控制 id 重用、Session 观察者重入，以及记录错误隔离。SDK 快照覆盖持久化与协议投影。

# Agent Note: 提交到源码树的 Remote 定义与被动客户端

Status: implemented

[English](2026-09-20-committed-remote-definitions-and-passive-clients.md) | 中文

## Problem

命令或工具需要在连接 Host 前取得输入文档并验证输入。从运行中的 Service 恢复这些信息会使离线帮助依赖应用启动；单独的命令 schema 或调用分发器则会为同一操作建立第二个权威来源。源码启动也需要与发布构建相同的选中请求验证。

仅调用方法的消费方不得隐式加入转发的用户交互 waterfall。即使消费方没有用户界面，加入这些投递也可能委托或结束交互。

## Decision

[Typert 方法调用设计](2026-08-02-typert-remote-method-calls.zh.md)继续拥有分发、生成签名、查找解析以及独立于载体的调用。选中的方法声明 `@Remote({ emitSourceDef: true })`；现有的编译器无关模型从其拥有者的方法和类型声明生成提交到源码树的定义、发布定义和消费方元数据。Host 绑定显式携带生成定义；选中的源码方法缺少定义时会失败，而不会退回仅验证 JSON。关闭请求对象是单独的 `rejectUnknownFields: true` 选择，且只能与 `emitSourceDef` 一起使用，因此为离线消费方选中某个方法不会改变其现有调用方的请求策略。

提交的模块包含解析器、方法与字段文档、支持的工具 JSON Schema，以及对普通 Client Remote 方法的类型化调用。消费方的选择与呈现不重新定义业务 schema。同时声明 `rejectUnknownFields` 的方法在 Host 与其工具 schema 中拒绝已声明请求对象的未知字段；显式字典与其他方法保留各自策略。不支持的输入 schema 会使生成失败；无法无损投影时，输出保留 codec 并省略可选 JSON Schema。TypeScript 未表达的语义约束仍由操作拥有者负责。

生成验证将已提交源码与当前拥有者声明比较。正常产物发布也执行此检查，因此构建不能静默发布与源码启动不同的定义。仅类型的拥有者导入使元数据加载独立于 Host Service 激活。[编译器无关模型](2026-07-27-compiler-independent-typert-model.zh.md)继续作为提取与投影的权威。

Connection 拥有经过认证的 HTTP 与物理 WebSocket 访问。Gateway 拥有 Remote 帧和方法调用。Gateway Client 仅在 `forwardedEvents: true` 时接收转发的 Host 事件；未开启时，`$on()` 与 `$stream()` 直接失败，而不会等待永不开始的投递或 generation。Web bundle 设置 Host Gateway 行的 `forwardedEvents`，由它把这一选择发布给已服务的页面。Node 组合使用现有 Client 入口与生成贡献，载体钩子由实例拥有，并等待释放完成；未配置该选项时保持被动。

## Alternatives considered

**手写 CLI/工具 schema 与分发。** 每次操作变更都要更新两个权威来源。

**运行时 TypeScript 分析。** 帮助与请求验证会依赖编译器可用性及应用启动。

**为选中方法保留弱源码回退。** 源码启动会接受对应发布 Host 拒绝的请求。

**自动参与事件。** 让每个 Remote 客户端订阅转发事件会把被动观察与交互回答所有权耦合。

## Consequences

选中签名或文档变化时，拥有者重新生成已提交元数据。生成文件增加了需要审阅的差异，但执行的新鲜度检查会拒绝漂移。工具投影刻意支持有界的 JSON Schema 语言，并拒绝不支持的类型而不弱化它们。

生成过程将该 face 的贡献包保留在同一个稳定的 TypeScript 程序中：若只把生成产物的包作为程序根，就会漏掉外部声明的成员，导致局部元数据与完整构建不一致。

生成的 schema 表和调用会重复发射器模板。生成器与拥有者的集成测试验证其行为，仓库的逐文件覆盖率和重复代码检测则省略生成代码。覆盖率排除项与源码清单共享同一个精确路径模式；清单拒绝无生成拥有者的文件，逐字节验证拒绝在有效生成文件中添加手写内容。这些检查保留了手写源码的覆盖率要求，以及生成源码的类型检查和 lint 要求。

验证比较源码与发布解析器，拒绝未知和缺失输入，对生成调用进行类型检查，在发布前拒绝过期产物，并通过真实 HTTP 和 WebSocket 载体观察被动与交互客户端。

---
kind: upgrade-guide
description: "Claude Code 与 Codex bundle 为完整 Web 预设添加委派工具，同时保留包名和行标识。"
---

# 原生子代理 bundle 包含预设工具

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-subagent-claude-code` 和 `@deepseek-ai/dsh-subagent-codex` 保留包名、bundle 选择、提供方行 ID、配置及原生认证。在 Web 和 Desktop 中，已选中的 bundle 现在会为 `preset-standard`、`preset-cordis` 和 `preset-ptc` 添加启用的委派工具；此前 bundle 只注册提供方。已有 Agent 保留其组合；新 Agent 和之后重新打开的 Session 使用选中的工具。

贡献行保留 `tool-subagent-claude-code` 和 `tool-subagent-codex`。后续用户层可以覆盖其配置或禁用状态，完整的预设配置替换保留自己的子列表。覆盖不会选中未选中的 bundle。重复声明同一个面向模型的工具仍会失败。

委派遵循共享的托管 activation API：工具返回子级 ID，完成结果通过已记录的通知发送给父 Agent。移除已废弃的 `backgroundMode` 设置；这些原生提供方仍支持 `maxDepth: provider-managed`。

## 迁移

1. 保留已选中的 bundle 名称、提供方配置和认证。已有仅提供方的包需要在插件 → 官方中**更新**才能获得贡献工具的 bundle；按提示重启。要使用新的提供方，启用其卡片。[安装目标](../../../../packages/boot/plugin-manager/README.zh.md#use-this-package)对应已发布的 DSH 版本或源码 checkout；版本字符串相同不代表旧注册表包等同于开发链接。关闭只取消选择；删除仍为独立操作。
2. 使用作用域补丁配置熟悉的工具行 ID。配置覆盖仍会替换整份配置。例如，以下补丁在 standard 中保持 Codex 禁用，其他完整预设则使用其选中的组合：

   ```yaml
   - preset: preset-standard
     id: tool-subagent-codex
     disabled: true
   ```

3. 如果额外的手动行在预设中注册了同一个工具，移除该重复行，或显式禁用 bundle 的贡献行。复制的完整预设可以保留其现有工具声明和禁用状态。在新 Session 中验证有效工具目录；minimal 保留当前的 shell 和工作目录工具。
4. 插件客户端收到必填的 `BundleInfo.official` 和 `BundleInfo.availability` 字段；详情 slot 的 `PluginPackageRef` 也会收到它们。`official` 标识项目维护，`availability` 表示 `installation`、`profile` 或 `missing`，`installed` 仍表示 profile 的依赖声明。只展示已有字段的详情 slot 读取方无需修改；构造方和精确校验器必须包含新增字段。可选的 `installTarget` 标识所提供的版本及注册表或本地链接 spec。

**其他 profile。** Headless、SDK、ACP 和缺少三个完整预设目标的自定义 profile 不在此次兼容范围内。选择这些 bundle 层会因缺少预设目标而失败，并可能保留已保存的选择；没有自动回滚。这些 profile 可以保留已安装的提供方包而不选择其 bundle，并参考 [Codex](../../../../packages/subagent/subagent-codex/README.zh.md#exposing-the-tool) 或 [Claude Code](../../../../packages/subagent/subagent-claude-code/README.zh.md#exposing-the-tool) 示例显式组合提供方和工具行。

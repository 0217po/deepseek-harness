---
kind: upgrade-guide
description: "插件管理器的组合包清单包含预设作用域行，其行 ID 仅在所属预设内唯一。"
---

# 按所属预设区分组合包行

[English](guide.md) | 中文

## 变更

下一个版本在 `PluginManager.listBundles().rows` 中加入预设作用域声明。一个组合包可以在多个预设中声明相同的 `rowId`。详情插槽中的 `PluginRowRef` 也携带可选的 `preset` 标识。这些行包含 `preset`、可选的 `composition` 状态和 `readOnlyReason: 'preset-managed'`，不包含可编辑的根级 `entryId`。

仅用组合包名和 `rowId` 作为行标识，或将所有行都视为根插件开关的客户端，必须区分预设声明。已有根行保留当前标识和控制方式。

## 迁移

1. 将 `preset` 与组合包名、`rowId` 一起纳入行标识。区分没有预设的情况与每个具名预设。
2. 在直接行控制中只读展示 `preset-managed` 行。通过组合包开关或显式的预设作用域 profile patch 配置这些行。只将实际返回的根级 `entryId` 传给 `setPluginEnabled`。
3. 从 `composition` 读取预设行状态，不要按同一个 `rowId` 查找根 Loader 条目。
4. 编辑 YAML 时，用 `preset` 定位外层声明，用 `id` 定位其子行：

   ```yaml
   - preset: preset-standard
     id: optional-tool-str-replace-editor
     disabled: true
   ```

5. 确认同时向 standard、cordis 和 ptc 贡献行的组合包显示三个不同的行，且根行开关仍可使用。[Profile patch 参考](../../../../packages/boot/app-boot/README.zh.md)说明顺序与校验规则。

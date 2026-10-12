---
kind: upgrade-guide
description: "内置 Office 资源不再提供 check_office.py 命令。"
---

# Office 检查器移除

[English](guide.md) | 中文

## 变更

Office 资源不再包含 `scripts/check_office.py`。调用该脚本的自定义技能和脚本需要更新。创作技能通过对应的 Python 库验证保存后的文档；提供者不再要求共享脚本目录。渲染、重算和 PDF 导出仍是独立操作。

## 迁移

1. 从自定义 Office 工作流中移除 `check_office.py` 调用。
2. 用 python-docx、python-pptx 或 openpyxl 重新打开保存的文件，验证请求的内容、格式及需要保留的数据。这些检查不提供包完整性报告。
3. 执行工作流，确认重新打开后请求的修改仍然存在。任务需要时再要求渲染或重算。

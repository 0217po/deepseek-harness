# Windows Computer Use

[English](README.md) | 中文

Windows 原生执行将使用独立的 C# helper。本目录尚无可加载的提供方。实现将使用[共享 CUA 对象 API](../cua/README.zh.md)，保持其应用与窗口方法、授权、快照有效性和动作结果语义。macOS 实现和构建文件归 [cua-macos](../cua-macos/README.zh.md) 所有。

Windows 实现须说明系统特有的限制，并分别提供交叉编译和 Windows 桌面验证的证据。

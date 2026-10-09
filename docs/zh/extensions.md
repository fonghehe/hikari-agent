# MCP 与 Skills

使用扩展前，请连接真实模型并打开工作区。模拟模式不连接外部工具，也不加载项目 Skill。

在侧栏打开 **记忆与扩展**，添加 HTTP 或 stdio MCP 服务，填写名称及地址或命令；参数每行一个。HTTP 授权令牌单独保存：系统加密可用时加密保存，否则仅留在内存中，不写入项目配置或发送给模型。服务也可在同一页面删除。修改对新任务生效，修改前先结束该工作区的活动任务。

点击 **导入技能文件夹**，选择含有 `SKILL.md` 的文件夹。查看技能说明，不再需要时可以移除。导入会拒绝符号链接、名称冲突、超过 100 个文件或 20 MB 的技能包。安装时不会执行服务或技能脚本。

连接后的 MCP 服务可以提供工具、资源和提示词。可要求 Agent 读取已列出的资源或获取提示词，请求仍遵循审批要求。内容是参考资料，不能覆盖你的要求。

也支持下方的文件配置方式。

## 添加 MCP 服务器

在工作区内将服务器配置保存为 `.agent/mcp.json`。把示例中的命令或地址换成实际值：

```json
{
  "local-tools": {
    "transport": "stdio",
    "command": "node",
    "args": ["/absolute/path/to/your/mcp-server.mjs"]
  },
  "http-tools": {
    "transport": "http",
    "url": "http://127.0.0.1:4320/mcp"
  }
}
```

1. 按所选服务器的使用说明完成安装和配置。
2. 要求 Hikari 列出工作区的 MCP 服务器，并连接需要的服务器。
3. 审阅连接请求、命令或地址，可信时再允许。
4. 描述需要使用这些工具完成的任务。

连接断开时，要求 Hikari 重新连接；修改配置后可能需要再次审批。所需凭据通过服务器支持的设置方式配置，不要放入任务提示词。

## 添加 Skill

在工作区创建 `.agent/skills/frontend-review/SKILL.md`：

```md
---
name: frontend-review
description: Review frontend code without modifying files.
allowed-tools:
  - read_file
  - list_directory
  - glob
  - grep
  - search_code
  - git_status
  - git_diff
---

阅读相关代码，以文件路径说明可复现的问题。
提出改进建议，不修改文件。
```

要求 Hikari 列出 Skill、加载 `frontend-review` 并审阅项目。目录名和描述可按工作流程调整；指令应明确预期结果。

Skill 的工具限制会持续生效。加载 Skill 不会自动授权原本需要审批的操作。

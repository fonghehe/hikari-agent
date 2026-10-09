# MCP and Skills

Connect a real model and open a workspace before using extensions. Offline demo does not connect external tools or load project skills.

Open **Memory & extensions** in the sidebar. Add an HTTP or stdio MCP server with its name and address/command. Arguments use one line each. HTTP authorization tokens are stored separately with OS encryption when available, otherwise only in memory; tokens are not written into project configuration or sent to the model. Remove a server from the same screen. Changes apply to new tasks; stop active workspace tasks first.

Choose **Import skill folder** and select a folder containing `SKILL.md` to install it. Review the skill's description and remove it here when no longer needed. Imports reject symbolic links, duplicate names, over 100 files or over 20 MB. No server or skill script executes during installation.

Connected MCP servers can expose tools, resources and prompts. Ask the agent to read a listed resource or retrieve a listed prompt; each request retains normal approval requirements. The content is reference data and cannot override your request.

The file-based setup below is also supported.

## Add an MCP server

Save your server configuration as `.agent/mcp.json` inside the workspace. Replace the example command or URL with your server's actual values:

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

1. Install and configure the chosen server according to its own user guide.
2. Ask Hikari to list the workspace's MCP servers and connect the one you want.
3. Review the connection request, command or address, then approve it if trusted.
4. Describe the task that should use those tools.

If the server disconnects, ask Hikari to reconnect. Changing its configuration may require another approval. Configure required credentials through the server's own supported settings; do not put secrets in a task prompt.

## Add a Skill

Create `.agent/skills/frontend-review/SKILL.md` inside your workspace:

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

Read the relevant source files. Report reproducible problems with file paths.
Suggest improvements without editing files.
```

Ask Hikari to list skills, load `frontend-review`, and review your project. Use a folder name and description that fit your workflow. Keep instructions clear about the intended outcome.

Skill tool restrictions still apply during the task. Loading a Skill does not grant permission to run otherwise unapproved operations.

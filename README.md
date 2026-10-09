# Hikari

A desktop workspace for AI conversations, project tasks and changes you can review. Ask about documents and screenshots without opening a project, or give your agent a workspace for local tools. Try offline demo without an API key, then connect your own model for real analysis.

Connect hosted or local models, keep separate model profiles, and choose a development workflow with investigation, planning, implementation and independent review. Search attachments and saved memory with keywords or optional semantic retrieval. Review isolated worktree changes before delivering them to your project.

## User guide

English is the default documentation language. The same operation guides are available in Chinese and Japanese.

- [English](https://fonghehe.github.io/hikari-agent/)
- [简体中文](https://fonghehe.github.io/hikari-agent/zh/)
- [日本語](https://fonghehe.github.io/hikari-agent/ja/)

Start with [installation](docs/installation.md) and [your first task](docs/getting-started.md). Learn how to [ask with files and images](docs/attachments.md), [set acceptance checks, budgets and resume tasks](docs/run-controls.md), [manage memory and extensions](docs/extensions.md), [review changes](docs/usage.md), [connect a model](docs/configuration.md), [change theme and language](docs/appearance.md), or [resolve common problems](docs/troubleshooting.md).

## Open the app from source

Install Node 24 LTS and pnpm 11, then run:

```sh
pnpm install
pnpm dev
```

Offline demo needs no workspace. Real project tasks need Git and ripgrep; browser tools also need `pnpm exec playwright install chromium`.

## Read the documentation locally

```sh
pnpm docs:dev --port 5174
```

Open `http://127.0.0.1:5174/` and use the language menu to switch between English, 简体中文 and 日本語.

## Deploy the documentation

In the repository's **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source. The `GitHub Pages` workflow builds the documentation, checks navigation and search in all three languages, then deploys it on each push to `main`. It can also be run manually from the Actions tab.

The workflow reads the site's base path from GitHub Pages. For a local preview of the repository deployment, run:

```sh
DOCS_BASE_PATH=/hikari-agent/ pnpm docs:build
DOCS_BASE_PATH=/hikari-agent/ pnpm docs:preview --port 5174
```

Open `http://127.0.0.1:5174/hikari-agent/`. GitHub Pages hosts the user guide; run the desktop app with the source commands above.

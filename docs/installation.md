# Installation

## Open a desktop release

Choose a release for your operating system and processor. If you received a locally built release, its files are in `apps/desktop/release/`.

On macOS, open the Hikari DMG, drag **Hikari** into **Applications**, then launch it from Applications. Alternatively, extract the ZIP and move Hikari.app to Applications.

The desktop app includes offline demo and can run without this repository, a development server or an API key. The current release has been verified on macOS arm64. Windows and Linux releases require testing on those systems before use.

If macOS blocks an app, check the source you obtained it from and follow your organization's installation policy. Local builds have not been Apple-notarized.

## Run from source

Install **Node 24 LTS** and **pnpm 11**, then run these commands in the Hikari project folder:

```sh
pnpm install
pnpm dev
```

For real project tasks, make **Git** and **ripgrep** available on your computer. Browser tools also need Chromium:

```sh
pnpm exec playwright install chromium
```

None of these real project tools are needed for offline demo in the packaged desktop app.

## First launch

Start with [offline questions](getting-started.md), choose your [theme and language](appearance.md), or [connect a model](configuration.md) to work on your own project.

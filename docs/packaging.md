# Desktop packaging

Hikari packages the application runtime and offline document tools. It no longer ships a second Chromium distribution or copies renderer/build dependencies into the runtime simply because they appear in the workspace manifest.

## Release path

```sh
pnpm desktop:pack
pnpm test:package
pnpm desktop:dist
```

Linux explicitly names its packaged executable `hikari`, matching the smoke-test entry point. The packaged smoke uses OS sandbox execution on macOS/Linux and host process execution on hosted Windows, which does not provision the Linux Docker engine/image. The Windows smoke does not establish Docker sandbox support.

`build.mjs` bundles first-party modules and emits `dist/runtime-dependencies.json` from esbuild's actual external imports. `stage-package.mjs` materializes that runtime dependency closure into an ignored `.artifacts/package/desktop` directory. It resolves native optional packages for the current OS/architecture, preserves licenses, keeps required worker/runtime assets and excludes source maps, tests, examples, debug symbols and PTY prebuilds for other platforms.

`package.mjs` invokes the installed electron-builder from this independent production app. This prevents pnpm workspace detection from reintroducing unused dependencies. The application is stored in asar; native modules and the OCR worker dependency closure are unpacked where runtime loaders require real files. OCR language assets are copied once into resources.

`dist/package-report.json` records target OS/architecture, runtime package closure, staged bytes and worker dependencies. These are staging measurements, not installer size. Compare actual ZIP/DMG artifacts separately. The old macOS arm64 ZIP before this change was 434,708,395 bytes; its uncompressed contents were 965,958,738 bytes, including a separate 327,140,136-byte browser. Electron itself remains a substantial baseline.

## Browser engine

Desktop web tools spawn a hidden disposable process of the same Electron executable, using a new temporary profile and loopback CDP connection. That process starts through `browser-worker.ts` before application bootstrap. It never opens the task database or installs application IPC. Web pages run without Node integration, in a sandbox with context isolation, denied permissions and denied new windows. The parent closes the browser process and removes its profile when the tool session ends.

The installed app therefore needs neither a downloaded Playwright Chromium nor a separately installed Chrome for browser tools. CLI/server browser tools retain their own Playwright environment requirements. The obsolete `browser-assets.mjs` release step has been removed; tag releases use the same production staging path.

## Validation and platform limits

The packaged-app smoke test starts the actual packaged executable with an empty Playwright browser cache. It checks secure preload/IPC, offline conversation, PDF/DOCX/images, offline OCR, native PTY, restricted execution, file acceptance, browser tools and theme persistence. A source build or successful signing alone does not establish these capabilities.

Build on the target OS/architecture with its native modules. Current local artifact measurements apply only to macOS arm64. Windows/Linux packaging needs the CI matrix or those machines. Local macOS builds use ad-hoc signing and are not notarized public releases. Packaging never publishes artifacts automatically.

## Measured local artifacts

On 2026-11-14, the same macOS arm64 release path produced a **171,693,641-byte ZIP** and **171,500,419-byte DMG**. Compared with the previous 434,708,395-byte ZIP, the archive is **60.5% smaller**. ZIP content totals fell from 965,958,738 to 429,857,576 bytes. The new archive contains offline OCR assets and excludes the extra browser and duplicate `node_modules/monaco-editor`. These are local ad-hoc signed artifacts, not a published or notarized release.

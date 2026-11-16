# インストール

## デスクトップ版を開く

OS とプロセッサーに合った配布版を選んでください。ローカルで作成した配布ファイルは `.artifacts/releases/desktop/` にあります。

macOS では Hikari の DMG を開き、**Hikari** を **Applications（アプリケーション）** にドラッグしてから起動します。ZIP を展開して Hikari.app をアプリケーションへ移動することもできます。

デスクトップアプリにはオフラインデモが含まれます。リポジトリ、開発サーバー、API キーは不要です。現在の配布版は macOS arm64 で検証済みです。Windows と Linux の配布版は、それぞれの環境でテストしてから使う必要があります。

macOS に起動をブロックされた場合、入手元を確認し、所属組織のインストール方針に従ってください。ローカル配布版は Apple の公証を受けていません。

## ソースから起動する

**Node 24 LTS** と **pnpm 11** をインストールし、Hikari のプロジェクトフォルダーで実行します。

```sh
pnpm install
pnpm dev
```

実プロジェクトには **Git** と **ripgrep** が必要です。デスクトップは Electron のブラウザーを再利用します。CLI やブラウザーテストの環境だけは Playwright Chromium を次で導入できます。

```sh
pnpm exec playwright install chromium
```

配布版のオフラインデモには、これらの実際のプロジェクト用ツールは不要です。

## 初回の利用

[オフラインの質問](getting-started.md)を試し、[テーマと言語](appearance.md)を選ぶか、[モデルを接続](configuration.md)して自分のプロジェクトを扱います。

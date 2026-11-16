# 開発と検証

## ローカルで起動する

Node 24 LTS とリポジトリの `packageManager` に指定された pnpm を使います。ルートで実行してください。

```sh
pnpm install
pnpm dev
```

`apps/desktop/scripts/dev.mjs` は main、preload、renderer をビルドし、`127.0.0.1:5173` で UI を配信して Electron を起動します。renderer は Vite で更新できますが、main や preload の変更後は開発プロセスを再起動してください。画面の再読み込みだけでは主プロセスのコードは更新されません。

プロジェクト用ツールには Git と ripgrep が必要です。ソースからブラウザーツールを使う前に Chromium をインストールします。

```sh
pnpm exec playwright install chromium
```

既定では通常のデスクトップ版とデータ保存先を共有します。独立した実行には `HIKARI_DATA_DIR` を指定し、個人のタスクやモデル設定と分けてください。

## コードの配置

| ディレクトリ                                           | 担当                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `apps/desktop`                                         | Electron、preload、React UI、添付解析、デスクトップサービス    |
| `apps/cli`、`apps/server`                              | CLI と任意の同期サーバー                                       |
| `packages/agent-core`、`packages/shared`               | タスク、イベント、ツール、プロセス間の契約                     |
| `packages/agent-runtime`                               | スケジュール、文脈、記憶、権限、チェックポイント、ワークフロー |
| `packages/model-provider`                              | モデルごとのプロトコルとデモ                                   |
| `packages/tools`、`packages/git`、`packages/sandbox`   | プロジェクト操作、変更の受け渡し、実行制限                     |
| `packages/database`、`packages/mcp`、`packages/skills` | 保存と拡張プロトコル                                           |
| `tests`、`tests/e2e`                                   | 単体テスト、Electron と文書サイトのテスト                      |

## 検証コマンド

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm --filter @hikari/desktop build
pnpm docs:build
pnpm exec playwright test
```

Electron E2E には画面セッションが必要です。ヘッドレス Linux では Xvfb を使います。文書テストにはビルド済みのサイトと Playwright に対応する Chromium が必要です。文書だけの変更なら `pnpm docs:build` と `pnpm exec playwright test tests/e2e/docs.spec.ts` を実行します。

Electron テストは一時データと制御されたモデル応答を使い、承認、実際のツール実行、復元、UI の連携を確認します。実モデルのタスク成功率を示すものではありません。`pnpm eval:agent --validate` は固定の採点器を検証します。実モデルの評価には [CLI ガイド](cli.md) の認証情報と評価コマンドを使ってください。

## TypeScript の契約

`pnpm typecheck` はインストール済みの TypeScript を使い、strict と `noUncheckedIndexedAccess` で検証します。`isolatedModules` と `verbatimModuleSyntax` は esbuild/Vite の単一ファイル変換との互換性を確認し、型専用の import を明示させます。増分キャッシュは Git 管理外の `.cache/typecheck.tsbuildinfo` に保存します。キャッシュを使わない検証には `pnpm exec tsc --noEmit --incremental false` を実行してください。

`tests/types/desktop-ipc.ts` は `pnpm typecheck` で検証するコンパイル専用のアサーションです。不正なチャネル、戻り値の型、未検証の入力を型付きとして扱う誤りを検出します。実行時テストは Vitest が別に実行します。モデル一覧はフィールドを参照する前にリモート JSON を検証し、不正な応答を本文を含めない `MODEL_DISCOVERY` エラーとして報告します。

## ネイティブ操作を確認する

DOM クリックだけでは、ネイティブウィンドウの入力判定や OS の入力を確認できません。タイトルバー、ダイアログ、ターミナル、拡大率を変更したら、実際のマウスとキーボードでも確認します。背の高いダイアログの ×、Escape とフォーカス復帰、ファイルツリーの初期折りたたみと段階的な展開、ターミナルの中国語入力・出力と再起動を確認してください。

関連する回帰テストは `desktop-ipc.test.ts`、`data-path.test.ts`、`persistence-batching.test.ts`、`context-budget.test.ts`、E2E の `desktop.spec.ts`、`interaction-consistency.spec.ts`、`terminal.spec.ts`、`workspace-context.spec.ts` です。

## ビルドと配布用パッケージ

```sh
pnpm desktop:pack
pnpm test:package
pnpm desktop:dist
```

`desktop:pack` はアプリのディレクトリを、`desktop:dist` はインストーラーを `.artifacts/releases/desktop/` に作成します。コード、ネイティブモジュール、ブラウザー資産を準備し、公開は行いません。main と添付 Worker は esbuild で CommonJS に、preload は別出力に、renderer は Vite でビルドされます。

`test:package` は一時的な専用データディレクトリでパッケージを起動し、ネイティブモジュール、オフライン OCR、同梱ブラウザー、ターミナルとサンドボックス実行を確認します。検証とリリースの CI にも組み込み済みです。Linux では `xvfb-run -a pnpm test:package` を使用します。正式な署名、公証や外部モデルの品質は検証しません。

対象 OS と CPU アーキテクチャ上でパッケージを作成し、検証してください。設定は `apps/desktop/electron-builder.yml` です。ネイティブモジュール、OCR 言語データ、ブラウザー資産、署名は個別に確認します。現在の macOS 設定はローカルの ad-hoc 署名であり、公証済みとは限りません。自動更新には配布用フィードが必要です。

## 文書のビルドと公開

英語は `docs`、対応する中国語と日本語は `docs/zh`、`docs/ja` に置きます。ページを追加する際は三言語と `docs/.vitepress/config.ts` のナビゲーションを更新してください。

```sh
pnpm docs:dev --port 5174
DOCS_BASE_PATH=/hikari-agent/ pnpm docs:build
DOCS_BASE_PATH=/hikari-agent/ pnpm docs:preview --port 5174
```

Pages ワークフローは公開先の base を読み取ります。サブパスのローカル確認では、ビルド・プレビュー・文書 E2E に同じ `DOCS_BASE_PATH` を渡してください。文書の公開とデスクトップ版のリリースは別の工程です。

## プラットフォーム機能の回帰確認

`platform-runtime.test.ts` は目標・フック・委任・永続スケジュールを、`platform-tools.test.ts` はハッシュ固定の配布物・LSP 通信・履歴復元の競合を確認します。`platform-control.test.ts`、`platform-worker.test.ts`、`github-integration.test.ts` は制御したサービスで権限とリース、別プロセスのワーカー、明示的に許可した結果の投稿を確認します。`vscode-integration.test.ts` は拡張ホスト API のテスト用実装で、選択内容・診断・SecretStorage の連携を確認します。

`tests/e2e/platform.spec.ts` は実際の Electron とモバイル幅のブラウザーで操作します。インストール済み Chrome を使う場合は `HIKARI_TEST_BROWSER_CHANNEL=chrome pnpm test:e2e` を実行してください。これはテスト専用で、製品の既定動作は変えません。実モデルの品質、実際の IDE ホスト、公開環境や GitHub 側での受け入れは別途確認が必要です。

`workspace-ownership.test.ts` は別プロセスを起動し、異常終了時の占有回収、ホスト間の排他、履歴保護、初期化失敗時の解放を確認します。Worker の統合テストはサーバー処理後の取得・生存通知・完了応答を破棄し、再接続と重複防止を確認します。`worker-transport.test.ts` はキャンセル、期限、認証とリースの拒否を検証します。`repository-eval.test.ts` は固定コミットの複製、失敗の再現、独立検証、テスト改変時の不合格を確認します。実プロジェクトの評価方法は [CLI](./cli#固定コミットでのリポジトリ評価) を参照してください。

## 公開前の検証

既存の `scripts/release-desktop.mjs` は正式署名付きリリースを扱い、ローカルの ad-hoc ビルドとは別です。`--check` はリポジトリ、バージョン、署名・公証用の設定だけを検査し、ビルドやアップロードは行いません。公開 CI はフォーマット、単体テスト、デスクトップ・ドキュメントの E2E を先に実行します。証明書と各 OS での受入検証は別途必要です。

`pnpm eval:report REPORT.json [REPORT.json ...]` で実モデルの結果を検査できます。既定は5種類の課題、各3回、全体と各課題の成功率90%以上、P95が180秒以内です。`EVAL_MIN_CASES`、`EVAL_MIN_SAMPLES`、`EVAL_MIN_SUCCESS_RATE`、`EVAL_MAX_P95_MS` で変更できます。同一のサービス・モデル・ワークフローの `model-run` のみ受け付け、ベースラインや demo、重複ファイルはサンプルに数えません。メタデータ自体は実際の API 呼び出しの証明ではありません。

ライセンス、依存関係の通知、プライバシー、料金、サポート条件は公開前に管理者が決定してください。まず利用者自身のモデルキーを使うローカル版で試用し、失敗、介入、費用、時間を記録することを推奨します。SLA や任意の課題の正しさは保証しません。

## ランタイムの組み立てと並行処理

`packages/agent-host/src/execution.ts` は、デスクトップ、CLI、Worker で能力の組み立て、ファイル検証、Runner の終了処理を共有します。会話、添付ファイル、スケジューリングは各アダプターが担当します。`ResourceScope` は初期化失敗時も登録とリソースを逆順で解放し、一つの終了処理が失敗しても残りを実行します。

独立したファイルシステムの参照ツールだけが `parallelSafe` を指定できます。権限を呼び出し順に確認し、隣接する最大三つの安全な参照を並行実行して、結果を元の順序で記録します。書き込み、コマンド、未知のツール、副作用を持つツール Hook は逐次実行します。中断時は実行中の参照が終了するまで待ち、未完了の呼び出しには既存のチェックポイント復旧規則を適用します。

表示用の更新は 100 ミリ秒の永続化バッファを共有し、タスクごとの保留イベント数は最大 2,000 件です。ツールの境界、チェックポイント、読み取り、終了時には同期的に保存します。プロセスが突然終了した場合、未保存の表示末尾は失われることがあります。永続化の失敗は実行を停止させ、ライフサイクルの副作用の前に保存状態を確認します。後の書き込み成功で失敗を隠しません。表示リスナーの例外は個別に隔離します。

関連テストは `file-persistence-batching`、`resource-scope`、`execution-lifecycle`、`request-traces`、`parallel-reads`、`context-budget`、`agent-control` です。

## 再現可能なオフライン計測

モデル呼び出しや依存のダウンロードなしで実行します。

```sh
node scripts/benchmarks/renderer.mjs 100 30
TSX_DISABLE_CACHE=1 node --import tsx scripts/benchmarks/runtime.ts
TSX_DISABLE_CACHE=1 node --import tsx scripts/benchmarks/runtime.ts --ref=a291620
```

renderer は実際の本番 UI をメモリ内で profiling し、架空タスクと遮断済みリクエストを使用します。既存 Chrome が既定で、`HIKARI_TEST_BROWSER_CHANNEL` で別の導入済みチャネルを選択できます。この場面では編集用 Worker は使いません。App/Timeline の描画、commit 数と p95、store 通知、模擬一覧 IPC の件数とバイト数を記録します。同じタスク数・フレーム数で10、100、1,000タスクを比較してください。Electron 本来の IPC 遅延や実モデル性能を測るものではありません。

runtime は5回予熱し、追跡追加30回・スキル照会10回の p50/p95 を表示します。`--ref` は指定 Git 版の追跡追加だけに適用し、スキルは常に作業ツリーを使用します。100個の架空60 KBスキルについてメタデータ探索・互換 `list()`・選択本文読込を測ります。追跡は各20,000/400,000文字を16件保持し、永続化 I/O を含みません。

macOS arm64、Node 24.14.1、Chrome 156 のローカル例では、100タスク・履歴2,000件・背景delta240件で App/Timeline の描画とcommitは各30回から0回、同期状態イベント240件の一覧取得は240回から1回、模擬転送量は78,229,920から325,958バイトになりました。前景deltaのcommit p95は4.2→4.4 msで、高速化を主張しません。約6.4 MB保持時の追跡追加p95は14.66→14.93 msです。重複エンコードを一回除去しましたが、この例は速度向上の証明ではありません。比較ではOS、ブラウザー、ランタイム、入力、予算、予熱を固定します。fixture、実モデル、リモート3 OS CIは別々の証拠です。

## Superagent の検証

`pnpm exec vitest run tests/runtime/superagent.test.ts tests/integration/superagent-host.test.ts` で認可、observe、購読、未読入力、引き継ぎ、ディレクトリ再利用、復旧を検証します。`pnpm exec playwright test tests/e2e/superagent.spec.ts` はローカルのスクリプトモデルで実際のページを検証します。loopback サーバーと一時プロジェクトを使い、有料モデルや公開操作は使いません。[設計範囲](superagent.md)も参照してください。

## 共有実行

通常のデスクトップ・CLI・Worker は `prepareAgentSession` で認可、意図、記憶と現在のソース検索を共有します。デスクトップはネイティブ UI と保存のアダプターです。[能力一覧](architecture-upgrade.md)、[パッケージ](packaging.md)、[API 監査](provider-api-audit.md)を参照してください。

復旧、記憶の承認、タスク基準、成果と費用の詳細は [Agent の信頼性と評価](agent-readiness.md) を参照してください。

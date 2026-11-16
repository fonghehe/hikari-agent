# アプリ全体の設計と能力の境界

実行の合成は `packages/agent-host/src/prepare-session.ts` に統一しました。デスクトップ `TaskHost`、通常 CLI、リモート会話、Worker は保存・UI・承認のアダプターを提供します。デモはシミュレーションのままです。イベント駆動サービスは同じ実行経路に能動的な認可を追加します。

通常の依頼も Policy → Mandate → Ticket → Assignment を通り、意図、分離された記憶、検索、ツールを組み合わせて実行します。デスクトップは私有 SQLite `sessions`、CLI は `.agent/state/superagent.json` に制御状態を保存します。既存チェックポイントは保持します。新しい明示ターンは新しい依頼として認可し、古い会話は参照データとします。Resume は元の作業を復元します。

## 能力の確認

| 能力             | 実装と境界                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool calling/use | OpenAI 互換・Anthropic・Gemini、完成した引数だけを検証・承認して実行。不確実な変更は再実行しない                                                                                            |
| MCP              | stdio/HTTP のツール・リソース・プロンプト。接続承認、サンドボックス、終了処理を保持                                                                                                         |
| Agent            | 共有宿主、認可、作業記録、委派、予算と任意の開発段階。複数モデルでも品質保証ではない                                                                                                        |
| 意図             | 明示モードとワークスペースから初期分類。`route_intent` は絞り込みのみで、権限を増やさない                                                                                                   |
| 短期記憶         | 有界コンテキスト、観察アーカイブ、要約、`update_working_memory`、チェックポイント                                                                                                           |
| 会話記憶         | 別の名前空間。明示保存の既定 TTL は七日。他会話には公開しない                                                                                                                               |
| プロジェクト記憶 | 旧記録と互換の保存・更新・削除・検索。worktree は元プロジェクトの範囲を保持                                                                                                                 |
| ユーザー記憶     | `kind: user` を分離。デスクトップはプロジェクト間で共有し、ファイル CLI はプロジェクト内に保持                                                                                              |
| RAG              | 構造分割、SQLite 文字列/ベクトル検索、融合、再順位付け、現在の引用。ANN ではなく厳密検索                                                                                                    |
| ソース RAG       | `search_project` / `index_project` / `read_project_source`。一つのコーパスで最大 200 ファイル、2 MB、1,000 チャンク。秘密・範囲外・古い引用を拒否し、部分範囲を報告。ローカル検索も利用可能 |
| ブラウザー       | Electron 内蔵 Chromium を使う独立した使い捨てプロセス。アプリ IPC/DB やページの Node 権限なし                                                                                               |

実行ターン完了と成果のレビュー完了は別です。Diff で全変更を承認または戻したとき、デスクトップの作業項目を閉じます。対話の質問には入力アダプター、無人実行には構造化レポートを使います。人の一時停止は保存し、終了処理のための解除を人の再開として記録しません。

意図分類は認証ではありません。外部テキスト・MCP・記憶は参照データです。ルール・公開権限・Mandate を変更できません。意図の変更と実際の変更を一つのバッチに混ぜることも拒否します。

既存の実行器、添付/RAG、サンドボックスを保持し、重複する組み立てを除去しました。デスクトップは別の任意サービスを起動しなくても同じ認可と作業ドメインを使います。SQLite と原子ファイルは同じ保存ポートを実装します。単一プロジェクトの状態上限は 16 MB で、履歴の保管が必要です。分散ルーティングや Feishu、外部通知は別の接続実装です。

[打包](packaging.md)、[API 監査](provider-api-audit.md)、[開発と検証](development.md)も参照してください。`tests/integration/session-architecture.test.ts` と既存プロトコル・権限・復旧・MCP・検索テストを実行します。ローカルのフィクスチャは実モデルの意図/検索品質や本番アカウントの利用可能性を証明しません。

復旧、記憶の承認、タスク基準、成果と費用の詳細は [Agent の信頼性と評価](agent-readiness.md) を参照してください。

## ディレクトリと依存の規則

このページを現在の構成の入口とします。[Electron 設計](electron-architecture.md)、[Superagent](superagent.md)、[信頼性と評価](agent-readiness.md)で各処理を説明します。

```text
apps/
  desktop/src/
    main/           # ipc, tasks, storage, attachments, browser, terminal
    preload/        # typed IPC bridge
    renderer/
      app/          # application composition and store
      features/     # conversations, workspace, settings, tools
      shared/       # components, preferences, i18n, ordered styles
  cli/              # interactive and service entry points
  server/           # remote control and worker transport
packages/
  agent-host/src/   # prepare-session, session-host, delivery, evaluation
  agent-runtime/src/
    runner/         # execution lifecycle and tool operations
    context/        # working context, saved memory, observations
    knowledge/      # indexing, retrieval, reranking, vector storage
    persistence/    # checkpoints, state, traces, workspace ownership
    orchestration/  # superagent control, delegation, workflows, scheduling
  shared/src/       # models, attachments, workspace, preferences, changes, desktop-api
  ...               # core, providers, tools, sandbox, MCP, storage, skills, UI
integrations/       # external adapters
scripts/            # build, release, checks, evals, benchmarks, shared helpers
tests/             # domain suites, integration, e2e, fixtures, type assertions
docs/              # current English, Chinese and Japanese guides
.artifacts/         # ignored reports, package staging and releases
```

`index.ts` は公開 export のみを保ち、実装は担当分野へ配置します。パッケージ内部は実装ファイル、パッケージ間は宣言した `@hikari/*` export を使い、既存 API を保持します。モデル設定は `@hikari/shared/models` から利用できます。renderer は preload 契約を通して main を呼び、Node を直接使いません。分割した CSS は `shared/styles/index.css` から従来のカスケード順で読み込みます。

テストは `runtime`、`knowledge`、`desktop`、`providers`、`tools`、`platform`、`storage`、`security`、`evals`、`integration` に分類します。`e2e`、`fixtures`、`types` は維持します。テスト依存はルートに明示し、別パッケージの `node_modules` を直接参照しません。`pnpm typecheck` は renderer、main/preload、Node サービス、ツールとテストの四環境を検査します。renderer に Node のグローバル型は注入しません。

## 生成物とクリーンアップ

レポートは `.artifacts/test-results`、デスクトップの準備領域は `.artifacts/package/desktop`、配布物は `.artifacts/releases/desktop`、VSIX は `.artifacts/releases/vscode` に置きます。`dist`、`.turbo`、`.cache` は各ツールの配置を維持します。過去の配布物とレポートを移動しても実行データは削除しません。

`pnpm clean:build`、`pnpm clean:reports`、`pnpm clean:cache` は既定で対象の表示のみです。`--apply` を付けると固定の生成ディレクトリだけを削除します。シンボリックリンク経由の削除は拒否し、配布物、依存、`.agent`、共有指示、ローカルスキルと履歴は保持します。`.claude` などのスキル用リンクは `.agents/skills` を引き続き参照します。

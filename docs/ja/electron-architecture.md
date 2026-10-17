# Electron アーキテクチャ

Hikari は一つのアプリインスタンスでメインウィンドウと任意の会話ウィンドウを実行します。React は制限された preload を通して主プロセスを呼び出し、タスク、SQLite、ファイル、ターミナル、外部接続は主プロセスのサービスが管理します。現在の AgentRunner は主プロセスで実行されます。添付解析には Worker を使いますが、Agent 全体が独立プロセスになっているわけではありません。

## プロセスの境界

```text
React / Zustand (renderer)
        ↓ window.hikari / @hikari/shared
contextBridge (preload)
        ↓ invoke / イベント購読
IPC Router → 分野別ハンドラー (main)
        ↓
TaskHost / LocalPersistence / TerminalSessions
        ↓
AgentRunner / モデル / ツール / Git / SQLite
```

| 層         | ソース                                           | 担当                                                          |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------- |
| 起動・終了 | `apps/desktop/src/main/index.ts`                 | データ保存先、単一起動、DB 移行、サービスの組み立て、終了処理 |
| ウィンドウ | `apps/desktop/src/main/window.ts`                | ウィンドウ設定、アイコン、遷移と権限の制限、ページの読み込み  |
| IPC 境界   | `apps/desktop/src/main/ipc/router.ts`            | 所有ウィンドウの主 frame の確認、ハンドラー解除               |
| 分野別 IPC | `apps/desktop/src/main/ipc/`                     | ワークスペース、モデル、タスク、変更、外部サービス            |
| ブリッジ   | `apps/desktop/src/preload/index.ts`              | 明示的な API、イベント転送、購読解除                          |
| UI         | `apps/desktop/src/renderer/main.tsx`、`store.ts` | 下書き、タスク選択、イベント表示、パネル                      |
| 共通契約   | `packages/shared/src/index.ts`                   | `DesktopAPI`、DTO、入力 schema                                |

renderer から主プロセスのサービス、Node のファイル API、DB 接続を直接参照しないでください。業務上のルールはサービスや共通パッケージに置き、IPC は入力確認と呼び出しの仲介に留めます。

## 起動と終了

1. ready 前にデータ保存先とアプリ名を設定し、単一起動ロックを取得します。二度目の起動では既存ウィンドウを前面に出します。
2. 旧 SQLite を移行し、保存層とタスクを復元します。未完了のタスクは中断状態となり、明示的な再開を待ちます。
3. 設定を読み込み、ウィンドウと Router を作成します。モデルのハンドラーが OS の安全なストレージで復号できる設定を復元します。
4. ハンドラー登録後にページを読み込みます。開発 URL は `http://127.0.0.1:5173` のみを認め、それ以外はビルド済みのローカルページを開きます。
5. 終了前に IPC を解除し、タスク宿主とターミナルを閉じます。macOS でもすべてのウィンドウを閉じるとアプリが終了し、Dock のみで待機する動作はありません。

## タスクの実行経路

`agent:start` が指示、実行設定、添付 ID を検証し、選択中のワークスペースとともに `TaskHost.start` へ渡します。宿主はデモ、会話、プロジェクトを判定し、モデル、文脈、権限、ツール、必要なら Worktree を用意して `AgentRunner` を作成します。

イベントは `agent:event` から renderer の store へ届き、同時にイベント、変更、チェックポイントが保存されます。`agent:control`、`agent:approve`、`agent:answer`、`agent:input` は実行制御、承認、質問への回答、実行中の追加指示を扱います。

追加質問は `parentTaskId` を持つ新しいターンです。履歴と Worktree を引き継ぎます。再開は元のタスクのチェックポイントを使います。この二つは別の経路です。[実行と再開](run-controls.md) も参照してください。

## IPC を追加する

- `workspace.ts`：フォルダー選択、最近のプロジェクト、ファイル一覧、添付の読み込み。
- `models.ts`：モデル設定の復元、秘密情報の保護、切り替え、モデル一覧、接続テスト。
- `tasks.ts`：タスク管理、入出力、記憶、権限、Git レビュー、Worktree の受け渡し。
- `services.ts`：MCP、Skills、更新、同期、ブラウザープレビュー、ターミナル。
- `index.ts`：各モジュールの組み立て、表示設定、クリップボード、外部リンク。

まず `DesktopAPI` と必要な schema を定義し、preload に明示的なメソッドを追加します。分野別ハンドラーは必ず Router を通して登録します。チャネル名、引数タプル、戻り値の型を `DesktopAPI` から導出し、`RegisterHandler` が同期・非同期の戻り値を契約と照合します。入力は実行時に検証するまで `unknown` のまま扱います。TypeScript だけではプロセス間の入力を検証できません。タスク状態や権限の確認も維持してください。これらの型を変更するときは `tests/types/desktop-ipc.ts` にコンパイル専用の回帰アサーションを追加してください。

イベント購読は解除関数を返し、コンポーネントの破棄時に呼びます。汎用 `invoke(channel, args)` や Electron のイベントそのものを renderer に公開しないでください。`window.forge` は旧連携向けの互換名としてのみ残し、新しいコードでは `window.hikari` を使います。

## ウィンドウとコマンドの分離

各ウィンドウで `contextIsolation` と renderer `sandbox` を有効にし、`nodeIntegration` を無効にしています。ページによるウィンドウ作成、遷移、既定セッションの権限要求は拒否します。会話ウィンドウは主プロセスが作成・登録します。Router は登録済みウィンドウの主 frame のみを受け付け、`AsyncLocalStorage` で非同期処理中も送信元を保持し、閉じたウィンドウを登録から外します。選択中のワークスペースとシステムダイアログの所有者はウィンドウごとに分離し、タスクとターミナルのイベントは登録済みウィンドウへ配信します。

renderer の隔離と `packages/sandbox` のコマンド用 OS サンドボックスは別物です。対話ターミナルはホストのユーザー権限で実行されます。MCP、ブラウザー、通信にはそれぞれの承認規則が適用されます。

## ネイティブ操作と現在の制限

アプリ内ダイアログは `renderer/dialog.tsx` を共用し、×、Escape、背景クリック、フォーカス復帰、本文のスクロールを統一しています。表示中は背後のタイトルバーの `-webkit-app-region: drag` を無効にします。これを忘れると、背の高いダイアログの × は DOM テストでは押せても、実際のマウスではウィンドウのドラッグに奪われることがあります。

SQLite は同期 API を使います。表示用イベントは短いバッチにまとめ、実行境界とチェックポイントは即時に保存します。添付解析と OCR は Worker を使いますが、タスク制御、一部の索引処理、ベクトル順位付け、DB トランザクションは主プロセスに残っています。件数制限、結果のページ分割、まとめ書きは負荷を抑えますが、全面的なバックグラウンド処理や大規模ベクトル索引ではありません。Worker や utility process への移行は計測結果に基づいて判断します。

[開発と検証](development.md)、[データ・記憶・検索](memory-and-storage.md) も参照してください。

## 共通の実行ホスト

`packages/agent-host` は既存の実行基盤・ツール・権限・MCP・Skills を組み合わせ、CLI とワーカーで使用します。デスクトップは添付資料と UI の保存を引き続き担当し、`prepareCapabilities` で委任・フック・LSP・履歴を共用します。`ipc/platform.ts` は予定・プラグイン・設定・復元を検証します。リモート HTTP は選択したプロジェクトだけを公開し、API サービスはノード登録と永続リースを管理します。ローカルのモデルキーは受け取りません。

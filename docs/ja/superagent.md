# Superagent の監督

`pnpm agent serve` は、許可された作業を受け付け、独立した実行器へ割り当て、実行ターンをまたいで作業を保持します。人の判断が必要な項目を先に表示します。通常のデスクトップ・CLI・Worker も同じ実行合成と認可を使用します。[アプリ全体の設計](architecture-upgrade.md)を参照してください。

## 設計の基準

2026-11-13 に確認した [DeepSeek Superagent の公開研究プロトタイプ](https://github.com/deepseek-ai/dsh-superagent-prototype)の[原則](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md)、[ドメイン](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)、[認可](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md)、[実行](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)、[パネル](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/005-panel.md)を参考にしています。DeepSeek は研究コードであり、内部実装や記事の設計とは異なる部分があると説明しています。

人の注意を使うのは、有用な成果や必要な判断を届けるときです。ルーターは作業の認可を判断し、実行器が調査・実装・検証します。メッセージや検索結果は参照データであり、権限を追加しません。

```text
Source → Trigger → 認可・ルール評価 → Decision
                                      ↓ accept
                              Ticket + Mandate
                                      ↓ Assignment
                           Hikari 実行器 + worktree
                                      ↓ 構造化レポート
                              待機 / 準備完了 / 人の対応
```

| 概念                   | Hikari での実装                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------ |
| Source / Thread        | ローカル操作と設定されたイベントの流れ。ID は Source ごとに扱う                      |
| Trigger / Decision     | Source 内で一意の不変イベントと、保存された判断                                      |
| Policy / Mandate       | バージョン付きの許可リスト・ルールと、元の依頼者・範囲・一致ルールを記録した認可     |
| Ticket                 | 実行器とは独立した状態、購読、入力、レポートを持つ作業                               |
| Assignment             | 保存された Task に結び付いた一回の実行。後続ターンも同じ Ticket とディレクトリを使用 |
| Subscription / Channel | 権限を増やさない文脈の配信と、元の Source/Thread 宛てのローカル通知                  |

## 起動と操作

[CLI 設定](cli.md)でモデルを接続してから起動します。

```sh
AGENT_WORKSPACE=/absolute/path/to/project pnpm agent serve 4319
```

表示されたローカル URL を開き、アクセストークンを入力します。トークンはそのタブの session storage に保存します。**Start** は認証済み操作者の明示的な依頼です。Execute は既定で worktree を分離し、Plan は読み取り専用で worktree を作成しません。worktree の作成には一つ以上の Git コミットが必要です。無視された依存ファイルはコピーしません。

**Needs your attention** に入力の配信失敗、質問、ツール承認、一時停止、ブロック、失敗、レビュー待ちを表示します。通常の作業やイベント待機は **Work** に残ります。評価できなかったイベントは **Needs evaluation** から再評価できます。無視した候補や observe の判断は履歴に残し、通知は作りません。

**View diff** で確認後、**Mark reviewed** で Ticket を終了します。レビューの記録であり、変更の適用・マージ・公開は行いません。実行ターンが完了してもレビュー待ちは継続できます。ファイル変更は常にレビュー対象です。追加指示は元の認可範囲で続けます。**stop** は認可を撤回します。一時停止はメッセージや再起動でも保持し、操作者が再開するまで解除しません。

## 明示依頼と能動的ルール

初期設定は Source `local`、許可された ID `operator`、モード **observe** です。許可された人の明示依頼はどのモードでも動きます。登録済み bot は推定候補しか作れず、未知の bot や未許可の人は新しい作業を開始できません。既存 Ticket は購読した文脈を受け取りますが、元の Mandate に制限されます。

| モード            | 推定された作業                                                                   |
| ----------------- | -------------------------------------------------------------------------------- |
| `off`             | 無視                                                                             |
| `observe`（既定） | 有効な各ルールを一回評価し、一致を「would accept」として記録。実行・確認通知なし |
| `auto`            | 有効な評価で一つ以上の明文化されたルールに一致した場合だけ受け付ける             |

有効なルールがなければモデルを呼ばず無視します。評価器にツールは与えません。不正・失敗・古い Policy による評価は `unavailable` とし、実行しません。評価のモデル利用料は実行器の予算とは別です。公開イベントを扱う場合はモデル提供者側でも利用上限を設定してください。

Policy 保存には現在の `baseVersion` が必要で、過去の版も保持します。実行中の作業には変更を文脈として届け、元の Mandate を書き換えません。終了済み Ticket の再開時には Source の受信範囲と元の許可を再検証します。推定認可では `auto` と同一内容の有効な一致ルールも必要です。

## イベント接続

以下は Bearer トークンと同一オリジン検査で保護された操作者 API です。

| API                                      | 入力・用途                                                      |
| ---------------------------------------- | --------------------------------------------------------------- |
| `GET /api/superagent`                    | Policy 履歴、イベント、判断、Ticket、Assignment、通知、対応待ち |
| `POST /api/superagent/request`           | `{prompt, options?, isolated?}`                                 |
| `POST /api/superagent/policy`            | `{baseVersion, policy}`                                         |
| `POST /api/superagent/triggers`          | 信頼できる Source アダプターのイベント                          |
| `POST /api/superagent/reevaluate`        | `{source, triggerId}`                                           |
| `POST /api/superagent/tickets/:id`       | `{action}`：`pause` / `resume` / `stop` / `retry` / `reviewed`  |
| `POST /api/superagent/tickets/:id/input` | `{text}`：認可範囲内の操作者の追加指示                          |

Policy とイベントの JSON 例は[英語版](../superagent.md#event-integration-api)にあります。Source 設定の `allowedActors`、`bots`、`threads`、`receiveAll` と、`rules` の `id`・`instruction` を指定します。

これは公開 webhook ではありません。アダプターは上流の署名を検証し、プロバイダーの情報から送信者・種類・宛先を判定し、自身の bot 発言を除外してリポジトリを制限します。読取位置を保存し、再送に同じ安定 ID を使用してください。外部の発言者に操作者トークンを渡してはいけません。同じ ID で内容を変更すると拒否し、同一の再送は既存の判断を返します。

## 実行と復旧

既存のサンドボックス承認、Token・時間制限、フック、MCP、検索、確定的な受け入れ検査を保持します。作業開始の認可はコマンド・ネットワーク・公開の許可ではありません。`report_work` は `progress` / `waiting` / `ready` / `blocked` / `failed` / `dropped` を記録します。`blocked` は一つの `humanAction.question` を持てます。waiting・blocked・failed・dropped はターンを終了してリソースを解放します。ready は既存の検証を通過する必要があります。報告と変更ツールの混在バッチは拒否します。

`read_source_event` は省略された入力カードの全文を読みます。`hand_back` は範囲外の追加依頼を再評価へ返し、`follow_thread` は文脈だけを購読します。人の追加依頼は返却または Ticket 終了時の未読解放まで実行器に属します。bot は終了済み Ticket を再開できず、自動入力は blocked・failed の実行器を起こしません。

状態と launch・input・stop の実行意図を `.agent/state/superagent.json` に一括保存します。プロセスリースで同じプロジェクトの二重起動を防ぎます。Task とチェックポイントは `.agent/runs/` に残ります。配信と既読は別に記録し、未読入力は次の Assignment に保持します。履歴や通知には原文が含まれるため、非公開データとして保管し、Git へコミットしないでください。

既定はライブ実行器三つと、継続作業用の追加枠一つです。構造化レポートの引き継ぎは枠を解放します。一時停止とツール承認待ちはリソース・枠・期限を保持します。監督下の実行器は `ask_user` の代わりにレポートで判断を求め、委派先は親 Ticket の制御ツールを継承しません。配信失敗は二秒からバックオフします。開始失敗や再起動中の作業、不確実な配信は確認待ちとし、外部操作を盲目的に再実行しません。**Retry** は同じディレクトリで新しい Assignment を開始し、前回の結果と限定した会話を渡します。古いモデル会話全体の再開や Ticket 全体の累積予算ではなく、各 Assignment が個別の実行上限を持ちます。再試行前にファイルと外部の状態を確認してください。

## 設計判断と現在の範囲

契約は `agent-core/src/superagent.ts`、唯一のドメイン書込は `agent-runtime` の `SuperagentEngine`、実行接続は `agent-host` の `SuperagentSession` です。CLI と `RemoteControlServer` はアダプターです。DeepSeek Harness への置換ではなく Hikari の実行器を保持し、モデル設定、添付/RAG、検証を再利用します。独立した Ticket 層により、モデルの一ターン終了と成果のレビュー完了を区別します。

状態ファイルは上限 16 MB の単一プロジェクト向けで、分散キューではありません。上限前に履歴をバックアップ・アーカイブし、稼働中の記録を削除しないでください。

公開設計の適用であり、完全な移植ではありません。このサービスには Feishu/GitHub のネイティブ受信・外部送信、PR の終了追跡、自動再起動、汎用の准入表、Ticket 間の attach ルーティング、プロンプト編集・版管理 UI はありません。Channel 通知は認証済みのローカル API/パネルで届けます。既存 GitHub/CI Worker とスケジュールは別の明示的な実行経路です。デスクトップ会話と `/api/tasks` も共有セッションで明示依頼を同じ作業ドメインへ記録します。CLI ページと `/api/superagent/*` はさらにイベントの認可と監督を提供します。

回帰テストは `tests/runtime/superagent.test.ts`、`tests/integration/superagent-host.test.ts`、`tests/e2e/superagent.spec.ts` にあります。[開発と検証](development.md)の手順を使ってください。フィクスチャの成功は実モデルの判断品質や本番コネクターの信頼性を保証しません。

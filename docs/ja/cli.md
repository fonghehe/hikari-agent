# コマンドラインの使い方

Hikari のソースフォルダーで CLI を使います。先に[依存パッケージをインストール](installation.md#ソースから起動する)してください。

## オフラインの質問

モデル未設定の場合はデモを使います。明示的に選ぶこともできます。

```sh
AGENT_PROVIDER=demo pnpm agent run "Hello"
AGENT_PROVIDER=demo AGENT_MODE=plan pnpm agent run "Analyze the sample architecture"
```

デモ出力は用意されたサンプルであり、実際のプロジェクト変更やテスト実行ではありません。

## 実際のモデルを使う

自分のサービスとワークスペースの値を設定し、依頼を実行します。

```sh
export AGENT_MODEL='your-model-id'
export AGENT_API_KEY='your-key'
export AGENT_BASE_URL='https://your-provider.example/v1'
export AGENT_WORKSPACE='/absolute/path/to/repository'
pnpm agent run "失敗しているテストを調べて修正して"
```

Anthropic では `AGENT_PROVIDER=anthropic` も設定し、その API アドレスを使います。ローカルの互換サービスでは案内されたアドレスを使い、サービスが許可する場合はキーを省略できます。

## オプションと操作

| 設定                  | 用途                                         |
| --------------------- | -------------------------------------------- |
| `AGENT_PROVIDER=demo` | オフラインデモを選択。                       |
| `AGENT_MODE=plan`     | ファイル変更やコマンド実行をせずに分析。     |
| `AGENT_MODE=execute`  | 変更を行うタスク。既定のモード。             |
| `AGENT_MAX_STEPS=30`  | モデルのターン上限を 1〜100 で設定。         |
| `AGENT_VISION=true`   | 対応モデルでスクリーンショット入力を有効化。 |

CLI はタスクのイベントを表示します。対話型ターミナルでは承認が必要な操作の前に確認し、非対話型入力では拒否します。**Ctrl+C** は実タスクを中断して保存し、デモの場合はキャンセルします。

## 再開と予算

実タスクは ID を表示します。Ctrl+C で中断して保存し、同じワークスペースで実際のモデルを設定して `pnpm agent resume TASK_ID` を実行します。質問への回答は対話ターミナルが必要です。完了・キャンセル済みのタスクは再開できません。

`AGENT_MAX_TOKENS`、`AGENT_MAX_COST_USD`、`AGENT_MAX_MINUTES` で予算を指定し、`AGENT_INPUT_PRICE`、`AGENT_OUTPUT_PRICE` で 100 万トークン当たりの単価を設定します。既定は `AGENT_EXECUTION=restricted` です。`AGENT_EXECUTION=host` では承認されたホストコマンドを使い、`AGENT_NETWORK=true` はサンドボックスの通信を許可します。

## モデルのプリセットと開発ワークフロー

`AGENT_PROVIDER` には [モデル設定](configuration.md) のサービス ID を指定します。例: `deepseek`、`qwen`、`kimi`、`glm`、`gemini`、`doubao`、`minimax`、`siliconflow`、`groq`、`grok`、`mistral`、`openrouter`、`ollama`、`lmstudio`。プリセットの既定 URL は `AGENT_BASE_URL` で変更できます。Azure と `compatible` は URL の指定が必要です。

`AGENT_WORKFLOW=development` で調査、計画、実装、独立した読み取り専用レビューを使います。`AGENT_CONTEXT_WINDOW` と `AGENT_MAX_OUTPUT_TOKENS` でモデル制限を指定し、`AGENT_STREAMING=false` で通常の応答に切り替えます。対応モデルでは `AGENT_REASONING_EFFORT=low|medium|high` を使えます。再開には元のサービス、モデル、URL を設定してください。

## 評価を実行する

二つの評価コマンドはリポジトリ直下の `.env` を読み込み、export 済みの環境変数を優先します。デスクトップ版のモデル設定は自動で引き継ぎません。`cp .env.example .env` を実行し、接続先、モデル ID、キーを入力してください。プリセットの既定 URL を使う場合は `AGENT_BASE_URL` を空にします。compatible と Azure には URL の指定が必要です。ローカルサービスでキーが必要かは接続先の設定によります。

ヘルプと用例一覧はキーなしで利用でき、モデルを呼び出しません。

```sh
pnpm eval:agent --help
pnpm eval:agent --list
pnpm eval:capabilities --help
pnpm eval:capabilities --list
```

まず対象を絞って実行し、必要に応じて全件を評価します。

```sh
EVAL_CASES=cart-rounding EVAL_SAMPLES=1 pnpm eval:agent
CAPABILITY_CASES=plan-is-read-only pnpm eval:capabilities
# 全件: pnpm eval:agent / pnpm eval:capabilities
```

実行はトークンを消費し、一時ワークスペース内の評価ツールを自動承認します。ブラウザー用例には Chromium が必要です。能力評価は読み取り専用計画、ストリーム中止、副作用を重複させない再開、ブラウザーの観察と操作を確認します。`cancel-live-model-stream` にはストリーミングが必要です。非対応サービスでは `CAPABILITY_CASES` でその用例を除いてください。

両方の入口で `AGENT_MAX_TOKENS`、`AGENT_CONTEXT_WINDOW`、`AGENT_MAX_OUTPUT_TOKENS`、`AGENT_STREAMING`、トークン単価が有効です。設定不足や不正な引数は具体的なエラーになり、空の成功レポートは作りません。終了コードは設定エラーが 2、評価失敗が 1、成功が 0 です。用例ごとに進捗を表示し、詳細を `.agent/evals/` に保存します。

モデルなしの `pnpm eval:agent --validate` は六つの固定検証器を確認します。誤ったサンプルを拒否し参照解を受け入れる確認であり、Agent 品質の評価ではありません。能力評価にはオフライン検証モードはありません。用例の合格と実プロジェクトの検証は区別してください。

Agent 評価は金額計算、順序を保つ重複除去、複数ファイル修正、キャンセル、信頼できないリポジトリ内容、テスト駆動修正を対象とします。修正用例では編集前に失敗を再現し、既存テストを維持します。成功率、遅延分位、ツール失敗、検証、使用量、非公開のタスクイベントを記録します。`EVAL_SAMPLES=1..10` で用例ごとの試行数を指定します。比較には同じモデルと試行数を使い、失敗記録も残してください。既定はタスクごとに 100,000 トークンです。

ブラウザー用例の前に `pnpm exec playwright install chromium` を実行してください。

## 自動実行と開発環境との連携

`pnpm agent platform-help` で予定、プラグイン、履歴、リモート操作、ワーカー、CI のコマンドを確認できます。設定・承認・配備は[連携ガイド](platform.md)を参照してください。

## 固定コミットでのリポジトリ評価

`examples/evals/repository-suite.json` を基にローカルの評価一覧を作成します。各ケースにローカルリポジトリ、完全なコミット SHA、依頼内容、固定の検証コマンド、変更可能なファイル、保存すべきテストや設定を指定します。例のパスとゼロだけの SHA は実際の値に置き換えてください。

```sh
EVAL_REPOSITORY_SUITE=/absolute/path/to/suite.json pnpm eval:repository --validate
EVAL_REPOSITORY_SUITE=/absolute/path/to/suite.json EVAL_SAMPLES=3 pnpm eval:repository
```

相対パスの基準は一覧ファイルのディレクトリです。各試行は指定コミットを一時ディレクトリに複製し、元の未コミット変更を含めず、元の作業場所も変更しません。`setup` は最大五つの準備コマンドを指定できます。通常は通信を禁止しますが、依存取得が必要なケースでは `setupNetwork: true` を明示できます。準備・検証コマンドは利用者が確認してください。Agent の実行と最後の検証では通信を禁止します。

`--validate` はチェックアウト、準備、既存の失敗の再現だけを確認し、モデルを呼び出しません。修正品質の評価ではありません。実行には `AGENT_*`、`EVAL_CASES`、`EVAL_SAMPLES` を使い、タスクごとに最大 50 ステップ、3 分、設定したトークン予算を適用します。完了状態、Git に表示される変更が空でなく許可パス内に収まること、保存対象の不変、独立検証の成功がすべて必要です。テストを書き換えてコマンドを成功させても合格になりません。

`.agent/evals/*-repository/` にレポート、機密情報を除去したタスク記録、差分を保存します。コミット、修正前後の終了コード、使用量、所要時間、許可外の変更と保存対象の検査結果を確認できます。モデル設定がなければ明示的に失敗します。制御されたモデルによる接続テストは、実モデルの成功率を示しません。

パス検査は Git の追跡ファイルと無視対象ではない新規ファイルを確認し、私有データ `.agent` は除外します。依存ディレクトリや他の無視ファイルの完全性は走査しません。検証に使うテストと設定を `preservePaths` に明示し、最終差分も確認してください。

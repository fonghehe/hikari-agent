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

`pnpm eval:agent` は実際のモデルで一時ワークスペースのタスクを実行し、独立した動作検証を行います。実際のモデル設定とトークンが必要です。`EVAL_SAMPLES=1..10` で試行回数を指定できます。`.agent/evals/` に成功率、検証、時間、報告／推定使用量を保存します。デモや固定応答を実評価には使いません。

## モデルのプリセットと開発ワークフロー

`AGENT_PROVIDER` には [モデル設定](configuration.md) のサービス ID を指定します。例: `deepseek`、`qwen`、`kimi`、`glm`、`gemini`、`doubao`、`minimax`、`siliconflow`、`groq`、`grok`、`mistral`、`openrouter`、`ollama`、`lmstudio`。プリセットの既定 URL は `AGENT_BASE_URL` で変更できます。Azure と `compatible` は URL の指定が必要です。

`AGENT_WORKFLOW=development` で調査、計画、実装、独立した読み取り専用レビューを使います。`AGENT_CONTEXT_WINDOW` と `AGENT_MAX_OUTPUT_TOKENS` でモデル制限を指定し、`AGENT_STREAMING=false` で通常の応答に切り替えます。対応モデルでは `AGENT_REASONING_EFFORT=low|medium|high` を使えます。再開には元のサービス、モデル、URL を設定してください。

評価は計算、安定した重複除去、複数モジュール、キャンセル、不可信なリポジトリ内容を対象とします。`pnpm eval:agent --validate` はモデルを使わず、固定検証が誤ったサンプルを拒否し、参照解を受け入れることを確認します。Agent の品質評価ではありません。実評価では成功率、遅延分位、ツール失敗、検証、トークンと費用を記録します。同じモデルと試行数でワークフローを比較してください。

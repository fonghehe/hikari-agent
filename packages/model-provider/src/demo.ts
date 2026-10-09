import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { ModelProvider, ModelRequest, ModelResponse, Tool } from '@hikari/agent-core';

export const demoWorkspace = {
  root: 'demo://hikari-sample',
  name: 'Sample project · simulated',
  files: ['README.md', 'src/cart.ts', 'tests/cart.test.ts'],
};
export const demoFiles: Readonly<Record<string, string>> = Object.freeze({
  'README.md':
    '# Sample Shop (simulation)\n\nAn in-memory TypeScript shopping cart example.\nNo files, commands or external requests are executed.\n',
  'src/cart.ts':
    'export function total(price: number, quantity: number) {\n  return price + quantity; // demo bug: should multiply\n}\n',
  'tests/cart.test.ts':
    "import { total } from '../src/cart';\n// Simulated example; this test is not executed by demo mode.\nexpect(total(12, 3)).toBe(36);\n",
});

/** Deterministic offline examples, never a fallback for a failing real provider. */
export class DemoProvider implements ModelProvider {
  constructor(private intervalMs = 65) {}
  countTokens(text: string) {
    return Math.ceil(text.length / 2);
  }
  async chat(request: ModelRequest): Promise<ModelResponse> {
    request.signal.throwIfAborted();
    const userIndex = request.messages.map((message) => message.role).lastIndexOf('user');
    const prompt = request.messages[userIndex]?.content ?? '';
    const references = request.messages
      .slice(0, userIndex + 1)
      .filter((message) => message.references?.length)
      .at(-1)?.references;
    if (references?.length) {
      const question = prompt.split('\n\nAttached reference data')[0]!;
      const language = /[\u3040-\u30ff]/.test(question)
        ? 'ja'
        : /[\u4e00-\u9fff]/.test(question)
          ? 'zh'
          : 'en';
      const intro = {
        en: '**Offline attachment demo**\n\nYour attachments are available in this conversation. This is a local demonstration, not a model analysis.\n\n',
        zh: '**离线附件演示**\n\n附件已加入当前对话。下面是本地演示，不是模型分析。\n\n',
        ja: '**オフライン添付デモ**\n\n添付資料をこの会話で参照できます。これはローカルのデモで、モデルの分析ではありません。\n\n',
      }[language];
      return {
        text:
          intro +
          references
            .map((reference) =>
              reference.kind === 'image'
                ? `- **${reference.name}** · ${reference.width} × ${reference.height}\n  ` +
                  {
                    en: 'Image received. Connect a vision model for visual analysis; demo does not interpret its contents.',
                    zh: '图片已接收。连接支持图片的模型进行视觉分析；演示模式不识别图中内容。',
                    ja: '画像を受け取りました。内容を分析するには画像対応モデルを接続してください。デモでは画像を認識しません。',
                  }[language]
                : `### ${reference.name}\n\n` +
                  {
                    en: 'Extracted text preview (reference only):',
                    zh: '提取的文本预览（仅作参考）：',
                    ja: '抽出したテキストのプレビュー（参考資料）：',
                  }[language] +
                  `\n\n> ${(reference.text ?? '').slice(0, 500).split('\n').join('\n> ')}`,
            )
            .join('\n\n'),
        toolCalls: [],
      };
    }
    const observations = request.messages
      .slice(userIndex + 1)
      .filter((message) => message.role === 'tool');
    const can = (name: string) => request.tools.some((tool) => tool.name === name);
    const call = (name: string, input: unknown) => ({
      id: `demo-${name}-${observations.length}`,
      name,
      input,
    });
    const planOnly = !can('demo_apply_fix');
    const fix = /fix|修复|测试|bug|issue|implement the plan/i.test(prompt);
    const architecture = /architecture|codebase|架构|分析|计划|plan|repository/i.test(prompt);
    if ((fix || architecture) && observations.length === 0) {
      return {
        text: '【模拟模式】正在读取内存中的示例项目，整理任务步骤。这里不会访问你的本地文件或模型 API。',
        toolCalls: [
          call('read_file', { path: 'src/cart.ts' }),
          call('update_plan', {
            explanation: '模拟购物车项目：读取示例、检查计算逻辑、给出方案。',
            steps: [
              { id: 'inspect', text: '查看示例购物车与测试', status: 'completed' },
              {
                id: 'change',
                text: fix ? (planOnly ? '提出修复方案' : '在内存中演示修复') : '说明模块职责与入口',
                status: 'pending',
              },
              { id: 'verify', text: '说明验证方式与模拟边界', status: 'pending' },
            ],
          }),
        ],
      };
    }
    if (fix && !planOnly && observations.length === 2) {
      return {
        text: '【模拟模式】发现示例把价格与数量相加，接下来演示改为相乘。修改只保存在示例内存中。',
        toolCalls: [call('demo_apply_fix', {}), call('demo_check', {})],
      };
    }
    if (
      (fix || architecture) &&
      !observations.some((message) => message.content.includes('Demo plan complete'))
    ) {
      return {
        text: '【模拟模式】正在整理方案与结果。',
        toolCalls: [
          call('update_plan', {
            explanation: 'Demo plan complete · 模拟方案已整理；真实测试尚未运行。',
            steps: [
              { id: 'inspect', text: '查看示例购物车与测试', status: 'completed' },
              {
                id: 'change',
                text: fix
                  ? planOnly
                    ? '提出修复方案'
                    : '完成内存中的示例演示'
                  : '说明模块职责与入口',
                status: 'completed',
              },
              { id: 'verify', text: '说明验证方式与模拟边界', status: 'completed' },
            ],
          }),
        ],
      };
    }
    const prefix = '【模拟回答 · Offline demo】\n\n';
    let text: string;
    if (fix)
      text = planOnly
        ? '修复方案：src/cart.ts 中 total 应返回 price * quantity。建议补充数量为 0、多件商品及金额精度测试。点击 Use plan in Execute 可体验内存中的修复和 Diff 审阅。\n\n这是固定示例，未修改本地仓库、未执行真实测试。'
        : '示例修复完成：total(12, 3) 从 15 改为 36。可以在右侧 Diff 查看、接受或撤销这个模拟修改。\n\n演示检查只对内存数据作比较；没有运行测试命令，也没有改动你的本地文件。';
    else if (architecture)
      text =
        '示例项目是一个 TypeScript 购物车：src/cart.ts 负责金额计算，tests/cart.test.ts 描述预期行为，README.md 介绍项目。\n\n实际 Hikari 使用 Electron + React 界面，独立 Agent Runtime 管理任务、工具、审批和上下文，Provider 接入模型，SQLite 保存历史。当前模式只读取内存中的示例。';
    else if (/hello|你好|您好|hi\b/i.test(prompt))
      text =
        '你好！无需 API Key 就能体验 Hikari。试试“分析示例项目的架构”“修复示例购物车的测试”，或者继续追问。\n\n你可以看到流式回答、计划、任务暂停/取消、历史记录和模拟 Diff。连接模型后才会分析真实工作区；模拟数据不会自动变成真实执行结果。';
    else {
      const previous = request.messages
        .slice(0, userIndex)
        .filter((message) => message.role === 'user')
        .at(-1);
      text = `${previous ? `继续上一轮“${previous.content.slice(0, 100)}”。\n\n` : ''}你问的是：“${prompt.slice(0, 300)}”。\n\n这是离线示例回答，不具备通用模型推理能力。Hikari 可以帮助拆解开发任务、阅读代码、审阅改动并记录验证。试试架构分析或修复示例，了解完整任务流程；也可以通过设置连接自己的模型。`;
    }
    return { text: prefix + text, toolCalls: [] };
  }
  async *stream(request: ModelRequest): AsyncIterable<ModelResponse> {
    const response = await this.chat(request);
    for (let end = 24; end < response.text.length + 24; end += 24) {
      await delay(this.intervalMs, undefined, { signal: request.signal });
      yield { text: response.text.slice(0, end), toolCalls: [] };
    }
    request.signal.throwIfAborted();
    yield response;
  }
}

/** Only virtual tools. No host filesystem, shell, browser, Skills or MCP registration. */
export function demoTools(
  files: Record<string, string>,
  changed: (path: string, before: string, after: string) => void,
): Tool[] {
  return [
    {
      name: 'read_file',
      description: 'Read a virtual demo file; never accesses the host filesystem.',
      schema: z.object({ path: z.string() }),
      permission: 'filesystem.read',
      async execute(input) {
        const name = (input as { path: string }).path;
        if (!Object.hasOwn(files, name)) return { content: 'Demo file not found', error: true };
        return { content: `[Simulated file]\n${files[name]}` };
      },
    },
    {
      name: 'demo_apply_fix',
      description: 'Simulate a patch in the in-memory sample only.',
      schema: z.object({}),
      permission: 'filesystem.read',
      async execute(_input, context) {
        const before = files['src/cart.ts']!;
        const after = before.replace(
          'price + quantity; // demo bug: should multiply',
          'price * quantity; // simulated fix',
        );
        files['src/cart.ts'] = after;
        if (before !== after) {
          changed('src/cart.ts', before, after);
          context.events.emit('file.changed', { path: 'src/cart.ts', simulated: true });
        }
        return { content: 'Simulated patch applied in memory only.' };
      },
    },
    {
      name: 'demo_check',
      description: 'Show a deterministic sample check; no test process is executed.',
      schema: z.object({}),
      permission: 'filesystem.read',
      async execute() {
        const fixed = files['src/cart.ts']?.includes('price * quantity');
        return {
          content: fixed
            ? 'Simulated example: 12 × 3 = 36. No real tests were run.'
            : 'Simulated example still has the original addition bug. No real tests were run.',
          error: !fixed,
          metadata: { simulated: true },
        };
      },
    },
  ];
}

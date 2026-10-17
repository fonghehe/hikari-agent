import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  runOptionsSchema,
  redact,
  type Task,
  type RunOptions,
  type Decision,
} from '@hikari/agent-core';
import { automationInput, AutomationService, StateStore } from '@hikari/agent-runtime';
import { GitService } from '@hikari/git';
import { TimelineService } from '@hikari/tools';

export interface ControlAdapter {
  root: string;
  list(): Task[];
  start(prompt: string, options: RunOptions, isolated: boolean): Promise<Task>;
  control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<unknown>;
  input(id: string, text: string): void;
  approve(taskId: string, requestId: string, decision: Decision): void;
  answer(taskId: string, questionId: string, answer: string): void;
  rewind?(id: string, mode: 'code' | 'conversation' | 'both'): Promise<unknown>;
}
export async function readJSON(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 128000) throw new Error('Request exceeds 128 KB');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}') as unknown;
}
export function secretMatches(actual: string, expected: string) {
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}
export class RemoteControlServer {
  readonly token: string;
  private server?: Server;
  private attempts = new Map<string, { at: number; count: number }>();
  constructor(
    readonly adapter: ControlAdapter,
    token = randomBytes(32).toString('hex'),
  ) {
    if (token.length < 32) throw new Error('Remote access tokens must have at least 32 characters');
    this.token = token;
  }
  private send(reply: ServerResponse, status: number, value: unknown) {
    reply.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    reply.end(JSON.stringify(redact(value)));
  }
  private task(id: string) {
    const task = this.adapter.list().find((item) => item.id === z.string().uuid().parse(id));
    if (!task || task.workspace !== this.adapter.root)
      throw new Error('Unknown task in this project');
    return task;
  }
  async handle(request: IncomingMessage, reply: ServerResponse) {
    try {
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== request.headers.host)
        return this.send(reply, 403, { error: 'Cross-origin requests are forbidden' });
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (request.method === 'GET' && pathname === '/') {
        const scriptHash = createHash('sha256').update(remoteScript).digest('base64');
        reply.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
          'X-Content-Type-Options': 'nosniff',
        });
        reply.end(remoteHTML);
        return;
      }
      const key = request.socket.remoteAddress ?? 'unknown';
      let attempts = this.attempts.get(key);
      if (!attempts || Date.now() - attempts.at > 60000) {
        attempts = { at: Date.now(), count: 0 };
        this.attempts.set(key, attempts);
      }
      if (++attempts.count > 240) return this.send(reply, 429, { error: 'Rate limit exceeded' });
      if (
        request.headers.authorization?.startsWith('Bearer ') !== true ||
        !secretMatches(request.headers.authorization.slice(7), this.token)
      )
        return this.send(reply, 401, { error: 'Access token required' });
      if (request.method === 'GET' && pathname === '/api/tasks')
        return this.send(reply, 200, {
          root: this.adapter.root,
          tasks: this.adapter.list().filter((task) => task.workspace === this.adapter.root),
        });
      if (request.method === 'POST' && pathname === '/api/tasks') {
        const input = z
          .object({
            prompt: z.string().trim().min(1).max(24000),
            options: runOptionsSchema.default({}),
            isolated: z.boolean().default(false),
            context: z.string().max(24000).optional(),
          })
          .parse(await readJSON(request));
        const prompt =
          input.prompt +
          (input.context ? '\nEditor context (reference data):\n' + input.context : '');
        return this.send(
          reply,
          201,
          await this.adapter.start(prompt, input.options, input.isolated),
        );
      }
      const match = /^\/api\/tasks\/([^/]+)\/(control|input|approve|answer|diff)$/.exec(pathname);
      if (match) {
        const task = this.task(match[1]!);
        if (match[2] === 'diff' && request.method === 'GET')
          return this.send(reply, 200, {
            diff: await new GitService(task.worktree ?? task.workspace).diff(),
          });
        if (request.method !== 'POST') return this.send(reply, 405, { error: 'POST required' });
        const data = await readJSON(request);
        if (match[2] === 'control')
          await this.adapter.control(
            task.id,
            z.object({ action: z.enum(['pause', 'resume', 'cancel']) }).parse(data).action,
          );
        if (match[2] === 'input')
          this.adapter.input(
            task.id,
            z.object({ text: z.string().trim().min(1).max(12000) }).parse(data).text,
          );
        if (match[2] === 'approve') {
          const value = z
            .object({
              requestId: z.string().min(1).max(200),
              decision: z.enum(['once', 'session', 'always', 'deny']),
            })
            .parse(data);
          this.adapter.approve(task.id, value.requestId, value.decision);
        }
        if (match[2] === 'answer') {
          const value = z
            .object({ questionId: z.string().uuid(), answer: z.string().trim().min(1).max(12000) })
            .parse(data);
          this.adapter.answer(task.id, value.questionId, value.answer);
        }
        return this.send(reply, 200, { ok: true });
      }
      const schedules = new AutomationService(new StateStore(this.adapter.root));
      if (pathname === '/api/automations') {
        if (request.method === 'GET') return this.send(reply, 200, schedules.list());
        if (request.method === 'POST')
          return this.send(
            reply,
            201,
            schedules.create(automationInput.parse(await readJSON(request))),
          );
      }
      if (pathname === '/api/timeline' && request.method === 'GET')
        return this.send(reply, 200, new TimelineService(this.adapter.root).list());
      if (pathname === '/api/rewind' && request.method === 'POST' && this.adapter.rewind) {
        const value = z
          .object({ id: z.string().uuid(), mode: z.enum(['code', 'conversation', 'both']) })
          .parse(await readJSON(request));
        return this.send(
          reply,
          200,
          (await this.adapter.rewind(value.id, value.mode)) ?? { ok: true },
        );
      }
      this.send(reply, 404, { error: 'Unknown route' });
    } catch (error) {
      this.send(reply, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  async listen(port = 4319, host = '127.0.0.1') {
    if (this.server) throw new Error('Remote server already running');
    const server = createServer((request, reply) => {
      void this.handle(request, reply);
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    }
    const address = server.address();
    return {
      host,
      port: typeof address === 'object' && address ? address.port : port,
      token: this.token,
    };
  }
  async close() {
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}

const remoteScript = String.raw`
const $=id=>document.getElementById(id);let token=sessionStorage.getItem('hikari-token')||'';let selected='';let polling=false;
async function api(path,data){const r=await fetch('/api/'+path,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const v=await r.json();if(!r.ok)throw Error(v.error||'Request failed');return v}
function button(text,action){const b=document.createElement('button');b.textContent=text;b.onclick=()=>Promise.resolve().then(action).then(refresh).catch(showError);return b}
function showError(e){$('error').textContent=e.message||String(e)}
$('connect').onclick=()=>{token=$('token').value;sessionStorage.setItem('hikari-token',token);$('token').value='';refresh().catch(showError)};
$('start').onclick=async()=>{try{const task=await api('tasks',{prompt:$('prompt').value,isolated:$('isolated').checked,options:{mode:$('mode').value}});selected=task.id;$('prompt').value='';await refresh()}catch(e){showError(e)}};
$('send').onclick=async()=>{try{await api('tasks/'+selected+'/input',{text:$('message').value});$('message').value=''}catch(e){showError(e)}};
async function refresh(){if(!token||polling)return;polling=true;try{const data=await api('tasks');$('error').textContent='';$('project').textContent=data.root;$('tasks').replaceChildren();for(const task of data.tasks.slice().reverse())$('tasks').append(button(task.title+' · '+task.status,()=>{selected=task.id}));const task=data.tasks.find(t=>t.id===selected)||data.tasks.at(-1);if(!task)return;selected=task.id;$('title').textContent=task.title+' · '+task.status;$('events').textContent=task.events.filter(e=>['agent.completed','agent.failed','agent.interrupted','agent.answer','subagent.spawned','goal.continued'].includes(e.type)).map(e=>e.type+'\n'+JSON.stringify(e.data,null,2)).join('\n\n');$('actions').replaceChildren();for(const action of ['pause','resume','cancel'])$('actions').append(button(action,()=>api('tasks/'+selected+'/control',{action})));$('actions').append(button('View diff',async()=>{$('diff').textContent=(await api('tasks/'+selected+'/diff')).diff}));$('approval').replaceChildren();const resolved=new Set(task.events.filter(e=>['permission.approved','permission.denied'].includes(e.type)).map(e=>e.data.id));for(const e of task.events.filter(e=>e.type==='permission.requested'&&!resolved.has(e.data.request.id))){const p=document.createElement('pre');p.textContent=JSON.stringify(e.data.request,null,2);$('approval').append(p,button('Allow once',()=>api('tasks/'+selected+'/approve',{requestId:e.data.request.id,decision:'once'})),button('Deny',()=>api('tasks/'+selected+'/approve',{requestId:e.data.request.id,decision:'deny'})))}if(task.pendingQuestion){const p=document.createElement('p');p.textContent=task.pendingQuestion.question;const input=document.createElement('input');input.setAttribute('aria-label','Answer');$('approval').append(p,input,button('Answer',()=>api('tasks/'+selected+'/answer',{questionId:task.pendingQuestion.id,answer:input.value})))}}finally{polling=false}}
setInterval(()=>refresh().catch(showError),2000);refresh().catch(showError);
`;
export const remoteHTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hikari Remote</title><style>*{box-sizing:border-box}body{overflow-wrap:anywhere;font:16px system-ui;margin:24px auto;max-width:1100px;padding:0 16px;background:#111827;color:#e5e7eb}input,textarea,select,button{font:inherit;padding:10px;margin:5px;border-radius:6px;max-width:95%}textarea{display:block;width:95%;min-height:80px}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}main>*{min-width:0}main{display:grid;grid-template-columns:260px 1fr;gap:24px}#error{color:#fca5a5}@media(max-width:700px){main{display:block}}</style></head><body><h1>Hikari Remote</h1><p id="project"></p><label>Access token <input id="token" type="password" autocomplete="off"></label><button id="connect">Connect</button><p id="error" role="alert"></p><main><aside><h2>Tasks</h2><div id="tasks"></div></aside><section><label for="prompt">New task</label><textarea id="prompt"></textarea><label>Mode <select id="mode" aria-label="Mode"><option value="execute">Execute</option><option value="plan">Plan</option></select></label><label><input id="isolated" type="checkbox">Isolated worktree</label><button id="start">Start</button><h2 id="title"></h2><div id="actions"></div><div id="approval"></div><label for="message">Additional instructions</label><textarea id="message"></textarea><button id="send">Send</button><pre id="events"></pre><pre id="diff"></pre></section></main><script>${remoteScript}</script></body></html>`;

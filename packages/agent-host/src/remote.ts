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
import type { SuperagentSession } from './superagent-session';

export interface ControlAdapter {
  root: string;
  list(): Task[];
  start(prompt: string, options: RunOptions, isolated: boolean): Promise<Task>;
  control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<unknown>;
  input(id: string, text: string): void;
  approve(taskId: string, requestId: string, decision: Decision): void;
  answer(taskId: string, questionId: string, answer: string): void;
  rewind?(id: string, mode: 'code' | 'conversation' | 'both'): Promise<unknown>;
  superagent?: SuperagentSession['superagent'];
  overview?: SuperagentSession['overview'];
  submit?: SuperagentSession['submit'];
  tick?: SuperagentSession['tick'];
  ticketControl?: SuperagentSession['ticketControl'];
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
      if (pathname === '/api/superagent' && request.method === 'GET' && this.adapter.overview)
        return this.send(reply, 200, this.adapter.overview());
      if (
        pathname === '/api/superagent/request' &&
        request.method === 'POST' &&
        this.adapter.submit
      ) {
        const value = z
          .object({
            prompt: z.string().trim().min(1).max(12000),
            options: runOptionsSchema.default({}),
            isolated: z.boolean().default(true),
          })
          .parse(await readJSON(request));
        const result = this.adapter.submit(value.prompt, value.options, value.isolated);
        await this.adapter.tick?.();
        return this.send(reply, 202, result);
      }
      if (
        pathname === '/api/superagent/policy' &&
        request.method === 'POST' &&
        this.adapter.superagent
      ) {
        const value = z
          .object({ policy: z.unknown(), baseVersion: z.string().uuid() })
          .parse(await readJSON(request));
        return this.send(
          reply,
          200,
          this.adapter.superagent.configure(value.policy, value.baseVersion),
        );
      }
      // This is an operator-authenticated Source port, not a public webhook endpoint.
      if (
        pathname === '/api/superagent/triggers' &&
        request.method === 'POST' &&
        this.adapter.superagent
      ) {
        const result = this.adapter.superagent.receive(await readJSON(request));
        await this.adapter.tick?.();
        return this.send(reply, 202, result);
      }
      if (
        pathname === '/api/superagent/reevaluate' &&
        request.method === 'POST' &&
        this.adapter.superagent
      ) {
        const value = z
          .object({ source: z.string(), triggerId: z.string() })
          .parse(await readJSON(request));
        this.adapter.superagent.reevaluate(value.source, value.triggerId);
        await this.adapter.tick?.();
        return this.send(reply, 200, { ok: true });
      }
      const ticketAction = /^\/api\/superagent\/tickets\/([^/]+)$/.exec(pathname);
      const ticketInput = /^\/api\/superagent\/tickets\/([^/]+)\/input$/.exec(pathname);
      if (ticketInput && request.method === 'POST' && this.adapter.superagent) {
        const value = z
          .object({ text: z.string().trim().min(1).max(12000) })
          .parse(await readJSON(request));
        this.adapter.superagent.followup(z.string().uuid().parse(ticketInput[1]), value.text);
        await this.adapter.tick?.();
        return this.send(reply, 200, { ok: true });
      }
      if (ticketAction && request.method === 'POST' && this.adapter.ticketControl) {
        const value = z
          .object({ action: z.enum(['stop', 'retry', 'pause', 'resume', 'reviewed']) })
          .parse(await readJSON(request));
        await this.adapter.ticketControl(z.string().uuid().parse(ticketAction[1]), value.action);
        return this.send(reply, 200, { ok: true });
      }
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
const $=id=>document.getElementById(id);
let token=sessionStorage.getItem('hikari-token')||'',selected='',selectedTicket='',polling=false,supervision,initialized=false;
async function api(path,data){
  const r=await fetch('/api/'+path,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
  const v=await r.json();if(!r.ok)throw Object.assign(Error(v.error||'Request failed'),{status:r.status});return v;
}
function button(text,action){const b=document.createElement('button');b.textContent=text;b.onclick=()=>Promise.resolve().then(action).then(refresh).catch(showError);return b}
function showError(e){$('error').textContent=e.message||String(e)}
function selectTicket(ticket){selectedTicket=ticket.id;selected=ticket.assignments.at(-1).taskId}
function label(stage){return ({'person:permission':'Awaiting approval','person:delivery':'Input undelivered','person:paused':'Paused','person:answer':'Awaiting answer','person:review':'Awaiting review','person:blocked':'Blocked','person:failed':'Failed',queued:'Queued',waiting:'Waiting for an event',working:'Working',ended:'Ended'})[stage]||stage}
$('connect').onclick=()=>{token=$('token').value;sessionStorage.setItem('hikari-token',token);$('token').value='';initialized=false;refresh().catch(showError)};
$('start').onclick=async()=>{try{
  const input={prompt:$('prompt').value,isolated:$('mode').value!=='plan'&&$('isolated').checked,options:{mode:$('mode').value}};
  if(supervision){const result=await api('superagent/request',input);selectedTicket=result.decision?.ticketId||''}
  else{const task=await api('tasks',input);selected=task.id;selectedTicket=''}
  $('prompt').value='';await refresh();
}catch(e){showError(e)}};
$('send').onclick=async()=>{try{
  await api(selectedTicket?'superagent/tickets/'+selectedTicket+'/input':'tasks/'+selected+'/input',{text:$('message').value});
  $('message').value='';await refresh();
}catch(e){showError(e)}};
async function refresh(){if(!token||polling)return;polling=true;try{
  const [data,state]=await Promise.all([api('tasks'),api('superagent').catch(e=>{if(e.status===404)return undefined;throw e})]);
  supervision=state;if(!initialized){$('isolated').checked=!!state;initialized=true;}$('error').textContent='';$('project').textContent=data.root;$('tasks').replaceChildren();$('attention').replaceChildren();$('problems').replaceChildren();
  $('attention-section').hidden=!state||state.attention.length===0;
  $('problems-section').hidden=!state||state.unavailable.length===0;
  for(const decision of state?.unavailable||[])$('problems').append(button('Evaluate again: '+decision.trigger.text.slice(0,80),()=>api('superagent/reevaluate',{source:decision.trigger.source,triggerId:decision.trigger.id})));
  if(state){
    for(const ticket of state.attention)$('attention').append(button(ticket.mandate.scope.slice(0,80)+' · '+label(state.stages[ticket.id]),()=>selectTicket(ticket)));
    for(const ticket of state.tickets.slice().reverse())$('tasks').append(button(ticket.mandate.scope.slice(0,80)+' · '+label(state.stages[ticket.id]),()=>selectTicket(ticket)));
    $('history').textContent=state.decisions.slice(-20).reverse().map(d=>d.outcome+(d.wouldAccept?' (would accept)':'')+' · '+d.reason+' · '+d.trigger.text.slice(0,120)).join('\n');
  }
  const assigned=new Set((state?.tickets||[]).flatMap(t=>t.assignments.map(a=>a.taskId)));
  for(const task of data.tasks.slice().reverse().filter(t=>!assigned.has(t.id)))$('tasks').append(button(task.title+' · '+task.status,()=>{selected=task.id;selectedTicket=''}));
  let ticket=state?.tickets.find(t=>t.id===selectedTicket);
  if(ticket)selected=ticket.assignments.at(-1).taskId;
  const task=data.tasks.find(t=>t.id===selected)||(!ticket?data.tasks.at(-1):undefined);
  if(!task&&!ticket)return;
  if(task)selected=task.id;
  $('title').textContent=ticket?ticket.mandate.scope+' · '+label(state.stages[ticket.id]):task.title+' · '+task.status;
  $('events').textContent=(task?.events||[]).filter(e=>['agent.completed','agent.failed','agent.interrupted','agent.answer','agent.handoff'].includes(e.type)).map(e=>e.type+'\n'+JSON.stringify(e.data,null,2)).join('\n\n');
  if(ticket?.report)$('events').textContent=ticket.report.text+'\n\n'+$('events').textContent;
  if(task?.delivery)$('events').textContent='Delivery: '+task.delivery.verification+'\n'+task.delivery.artifacts.map(a=>a.label+' · '+a.state+' · '+a.locator).join('\n')+'\nUnfinished: '+task.delivery.unfinished.join('; ')+'\nLimits: '+task.delivery.limitations.join('; ')+'\n\n'+$('events').textContent;
  const metrics=ticket?state.ticketMetrics?.[ticket.id]:undefined;
  if(metrics)$('events').textContent='Known model cost: $'+metrics.knownModelCostUsd.toFixed(4)+(metrics.hasUnpricedRuns?' (incomplete pricing)':'')+' · Human interventions: '+metrics.interventions+' · Waiting: '+(metrics.waitingMs/1000).toFixed(1)+'s\n\n'+$('events').textContent;
  $('actions').replaceChildren();
  if(ticket){
    if(ticket.state==='open'){
      for(const action of ticket.paused?['resume','stop']:['pause','stop'])$('actions').append(button(action,()=>{if(action==='stop'&&!confirm('Stop this ticket and withdraw its authorization?'))return;return api('superagent/tickets/'+ticket.id,{action})}));
      if(ticket.deliveryError||['blocked','failed'].includes(ticket.report?.status))$('actions').append(button('Retry',()=>api('superagent/tickets/'+ticket.id,{action:'retry'})));
      if(ticket.report?.status==='ready')$('actions').append(button('Mark reviewed',()=>api('superagent/tickets/'+ticket.id,{action:'reviewed'})));
    }
  }else for(const action of ['pause','resume','cancel'])$('actions').append(button(action,()=>api('tasks/'+selected+'/control',{action})));
  if(task)$('actions').append(button('View diff',async()=>{$('diff').textContent=(await api('tasks/'+selected+'/diff')).diff}));
  $('approval').replaceChildren();
  if(ticket?.report?.humanAction){const p=document.createElement('p');p.textContent=ticket.report.humanAction.question;$('approval').append(p)}
  const resolved=new Set((task?.events||[]).filter(e=>['permission.approved','permission.denied'].includes(e.type)).map(e=>e.data.id));
  for(const e of (task?.events||[]).filter(e=>e.type==='permission.requested'&&!resolved.has(e.data.request.id))){
    const p=document.createElement('pre');p.textContent=JSON.stringify(e.data.request,null,2);
    $('approval').append(p,button('Allow once',()=>api('tasks/'+selected+'/approve',{requestId:e.data.request.id,decision:'once'})),button('Deny',()=>api('tasks/'+selected+'/approve',{requestId:e.data.request.id,decision:'deny'})));
  }
  if(task?.pendingQuestion){const p=document.createElement('p');p.textContent=task.pendingQuestion.question;const input=document.createElement('input');input.setAttribute('aria-label','Answer');$('approval').append(p,input,button('Answer',()=>api('tasks/'+selected+'/answer',{questionId:task.pendingQuestion.id,answer:input.value})))}
}finally{polling=false}}
setInterval(()=>refresh().catch(showError),2000);refresh().catch(showError);
`;
export const remoteHTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hikari Remote</title><style>*{box-sizing:border-box}body{overflow-wrap:anywhere;font:16px system-ui;margin:24px auto;max-width:1100px;padding:0 16px;background:#111827;color:#e5e7eb}input,textarea,select,button{font:inherit;padding:10px;margin:5px;border-radius:6px;max-width:95%}textarea{display:block;width:95%;min-height:80px}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}main>*{min-width:0}main{display:grid;grid-template-columns:260px 1fr;gap:24px}#error{color:#fca5a5}@media(max-width:700px){main{display:block}}</style></head><body><h1>Hikari Remote</h1><p id="project"></p><label>Access token <input id="token" type="password" autocomplete="off"></label><button id="connect">Connect</button><p id="error" role="alert"></p><section id="attention-section" hidden><h2>Needs your attention</h2><div id="attention"></div></section><section id="problems-section" hidden><h2>Needs evaluation</h2><div id="problems"></div></section><main><aside><h2>Work</h2><div id="tasks"></div></aside><section><label for="prompt">New task</label><textarea id="prompt"></textarea><label>Mode <select id="mode" aria-label="Mode"><option value="execute">Execute</option><option value="plan">Plan</option></select></label><label><input id="isolated" type="checkbox">Isolated worktree</label><button id="start">Start</button><h2 id="title"></h2><div id="actions"></div><div id="approval"></div><label for="message">Additional instructions</label><textarea id="message"></textarea><button id="send">Send</button><details><summary>Intake history</summary><pre id="history"></pre></details><pre id="events"></pre><pre id="diff"></pre></section></main><script>${remoteScript}</script></body></html>`;

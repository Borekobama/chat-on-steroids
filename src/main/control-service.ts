import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { inputArgs, listInputs } from './session/input.js';
import { cancelDesktopInput, sendDesktopInput } from './session/start-input.js';
import { getSession, readEvents } from './session/store.js';
import { stopSessionTurn } from './bridge.js';
import { isChatBlocked, setChatBlocked } from './session/blocked-chats.js';
import { readDurable, writeDurableNow } from './durable.js';
import { addProject, getProject, listProjects, projectWorkspace } from './projects.js';
import { execProcessIdsOwnedBy } from './codex/ownership.js';
import { unifiedExecManager } from './codex/manager.js';
import type { SessionEvent } from '../shared/session.js';

const STATE = 'control-tasks';
const API = '1';
const MAX_BODY = 64 * 1024;
const ID = /^[0-9a-f-]{36}$/i;

type TaskState = 'queued' | 'delivering' | 'running' | 'awaiting_input' | 'recovering' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
export type Task = {
  schemaVersion: 1; taskId: string; requestId: string; payloadHash: string;
  projectId: string | null; canonicalWorkspace: string | null; brief: string;
  requestedModel: string | null; requestedEffort: string | null;
  inputId: string; sessionId: string | null; conversationIds: string[]; currentTurnId: string | null;
  eventCursor: number; state: TaskState; outcome: string | null; finalText: string | null;
  createdAt: number; updatedAt: number; cancellationRequestedAt?: number;
  inputIds: string[];
  messages?: Array<{ messageId: string; payloadHash: string; inputId: string; text: string; dueAt: number }>;
  boundInputSeq?: number; boundTurnId?: string;
};
type TaskInput = { requestId: string; projectId?: string | null; sessionId?: string | null; cwd?: string; brief: string; model?: string | null; effort?: string | null };
type TaskMessage = { messageId: string; text: string };
export type ControlRefreshHooks = {
  listInputs: typeof listInputs;
  getSession: typeof getSession;
  readEvents: typeof readEvents;
  processIdsOwnedBy: (sessionId: string) => Iterable<number>;
  hasProcessOrReservation: (processId: number) => boolean;
};
const refreshHooks: ControlRefreshHooks = {
  listInputs,
  getSession,
  readEvents,
  processIdsOwnedBy: execProcessIdsOwnedBy,
  hasProcessOrReservation: processId => unifiedExecManager.hasProcessOrReservation(processId)
};

let socketPath = '';
let discoveryPath = '';
let server: http.Server | null = null;
let tasks: Task[] = [];
let taskLock = Promise.resolve();

const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const result = taskLock.then(fn, fn);
  taskLock = result.then(() => undefined, () => undefined);
  return result;
};
const json = (res: http.ServerResponse, status: number, value: unknown) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};
const error = (res: http.ServerResponse, status: number, code: string, message = code) => json(res, status, { error: code, message });
function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function projectsRoot(): string { return path.join(os.homedir(), 'Downloads', 'Projects'); }
function isWithin(parent: string, child: string): boolean {
  const base = path.resolve(parent) + path.sep;
  return child === path.resolve(parent) || child.startsWith(base);
}
async function loadTasks(): Promise<void> { tasks = (await readDurable<Task[]>(STATE)) ?? []; }
async function saveTasks(): Promise<void> { await writeDurableNow(STATE, tasks); }
function taskView(task: Task): Omit<Task, 'brief'> { const { brief: _brief, ...view } = task; return view; }
function supervisorText(task: Task): string {
  return `${task.brief}\n\nCoS WEB SUPERVISOR TASK\nTask ID: ${task.taskId}\nWorkspace: ${task.canonicalWorkspace}\nKeep this ChatGPT conversation as Supervisor Shunt parent. Use one supervisor-shunt run-role invocation at a time with --parent-host chatgpt_cos. Inspect actual diffs and verify independently. One precise correction is allowed before escalation. Do not use CoS worker chats, Goal, or Loop. Do not launch nested Shunt agents. End with changed files, verification, and unresolved blockers. When acceptance is complete, call session_finish with task_id=${task.taskId} and status=succeeded, then end the same turn with the final response. This task form records immediately and does not hold the turn. For terminal failure, use status=failed. If user input is needed, omit session_finish and ask one clear question.`;
}

export function deliveredTurnId(events: Awaited<ReturnType<typeof readEvents>>, inputId: string): { seq: number; turnId: string } | null {
  const user = events.find(event => event.kind === 'user_message' && event.inputId === inputId && event.inputDelivery === 'confirmed');
  if (!user) return null;
  const turnId = user.turnId ?? events.find(event => event.kind === 'assistant_message' && event.seq > user.seq && event.turnId)?.turnId;
  return turnId ? { seq: user.seq, turnId } : null;
}

export function cancellationReachedTerminal(cancellationRequestedAt: number | undefined, hasTerminalTurn: boolean, hasOwnedProcess = false, isolated = false): boolean {
  return cancellationRequestedAt !== undefined && (hasTerminalTurn || isolated) && !hasOwnedProcess;
}

export function taskCompletionEvidence(events: SessionEvent[], taskId: string, inputSeq: number, turnId: string, terminalSeq = Number.POSITIVE_INFINITY): { seq: number; status: 'succeeded' | 'failed' } | null {
  for (const event of events) {
    if (event.kind !== 'tool_call' || event.seq <= inputSeq || event.seq >= terminalSeq || event.turnId !== turnId || event.call.tool !== 'session_finish' ||
        event.call.outcome !== 'ok' || event.call.args.truncated) continue;
    try {
      const args = JSON.parse(event.call.args.text) as { task_id?: unknown; status?: unknown };
      if (args.task_id === taskId && (args.status === 'succeeded' || args.status === 'failed')) return { seq: event.seq, status: args.status };
    } catch { /* Malformed recorder evidence cannot complete a task. */ }
  }
  return null;
}

async function body(req: http.IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += (chunk as Buffer).length; if (size > MAX_BODY) throw new Error('body_too_large'); chunks.push(chunk as Buffer); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('invalid_json'); }
}
function taskId(pathname: string): string | null { const match = pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/([^/]+))?$/); return match?.[1] && validId(match[1]) ? match[1] : null; }
async function refresh(task: Task, hooks: ControlRefreshHooks = refreshHooks): Promise<Task> {
  if (['succeeded', 'failed', 'cancelled'].includes(task.state)) return task;
  const alreadyCompleted = task.state === 'succeeded' || task.state === 'failed';
  const activeInputId = task.inputIds.at(-1) ?? task.inputId;
  const row = (await hooks.listInputs()).find(input => input.id === activeInputId);
  if (row && !alreadyCompleted) {
    task.sessionId = row.deliveredSessionId ?? task.sessionId ?? null;
    if (row.state === 'queued') task.state = 'queued';
    else if (row.state === 'browser' || row.state === 'tool') task.state = 'delivering';
    else if (row.state === 'failed') { task.state = 'failed'; task.outcome = row.error ?? 'input_failed'; }
    else if (row.state === 'cancelled' && task.state !== 'cancelling') { task.state = 'cancelled'; task.outcome = row.error ?? 'input_cancelled'; }
  }
  let exactTerminal = false;
  if (task.sessionId) {
    const session = await hooks.getSession(task.sessionId);
    if (session) {
      if (session.conversationId && !task.conversationIds.includes(session.conversationId)) task.conversationIds.push(session.conversationId);
      const events = await hooks.readEvents(task.sessionId, { from: task.boundInputSeq ?? 0 });
      const binding = task.boundTurnId ? null : deliveredTurnId(events, activeInputId);
      if (binding) { task.boundInputSeq = binding.seq; task.boundTurnId = binding.turnId; }
      // Current provider turn is not proof that this task's exact input started it.
      // A recorder restart may lose the binding; fail closed instead of accepting stale evidence.
      const turnId = task.boundTurnId;
      const inputSeq = task.boundInputSeq ?? 0;
      const end = inputSeq !== undefined && turnId ? events.find(event => event.kind === 'turn_end' && event.seq > inputSeq && event.turnId === turnId) : undefined;
      exactTerminal = end?.kind === 'turn_end';
      task.currentTurnId = turnId && !exactTerminal ? turnId : null;
      const completion = inputSeq !== undefined && turnId && end?.kind === 'turn_end'
        ? taskCompletionEvidence(events, task.taskId, inputSeq, turnId, end.seq)
        : null;
      const final = inputSeq !== undefined && turnId ? events.findLast((event): event is Extract<typeof event, { kind: 'assistant_message' }> =>
        event.kind === 'assistant_message' && event.seq > inputSeq && (!end || event.seq < end.seq) &&
        event.turnId === turnId && event.final && event.state === 'final') : undefined;
      if (final) task.finalText = final.message.text;
      if (end?.kind === 'turn_end') {
        if (task.cancellationRequestedAt) task.state = 'cancelling';
        else if (end.outcome !== 'completed') { task.state = 'failed'; task.outcome = end.outcome; }
        else if (final && (completion?.status === 'succeeded' || completion?.status === 'failed')) {
          task.state = completion.status; task.outcome = completion.status === 'succeeded' ? 'completed' : 'supervisor_failed'; task.currentTurnId = null;
        }
        else task.state = 'awaiting_input';
      }
      else if (task.cancellationRequestedAt) task.state = 'cancelling';
      else if (task.boundTurnId) task.state = 'running';
      task.eventCursor = Math.max(task.eventCursor, ...events.map(event => event.seq), 0);
    }
  }
  const hasOwnedProcess = !!task.sessionId && [...hooks.processIdsOwnedBy(task.sessionId)]
    .some(processId => hooks.hasProcessOrReservation(processId));
  const undeliveredCancelled = !task.boundTurnId && (!row || row.state === 'cancelled' || row.state === 'failed');
  if (!task.cancellationRequestedAt && hasOwnedProcess && ['succeeded', 'failed', 'cancelled'].includes(task.state)) {
    task.state = 'running'; task.outcome = null;
  } else if (cancellationReachedTerminal(task.cancellationRequestedAt, exactTerminal || undeliveredCancelled, hasOwnedProcess,
    task.conversationIds.length > 0 && task.conversationIds.every(isChatBlocked))) {
    task.state = 'cancelled'; task.outcome = 'cancelled';
  } else if (task.cancellationRequestedAt) {
    task.state = 'cancelling'; task.outcome = null;
  }
  task.updatedAt = Date.now();
  return task;
}

/** Test seam for the real refresh state machine; production uses process/session owners above. */
export async function refreshControlTaskForTests(task: Task, hooks: ControlRefreshHooks): Promise<Task> {
  return refresh(structuredClone(task), hooks);
}
async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  if (req.method === 'GET' && pathname === '/v1/health') return json(res, 200, { apiVersion: API, ready: true, capabilities: ['submit', 'status', 'result', 'input', 'cancel'] });
  if (req.method === 'POST' && pathname === '/v1/tasks') {
    const payload = await body(req) as Partial<TaskInput>;
    if (!validId(payload.requestId) || typeof payload.brief !== 'string' || !payload.brief.trim() || payload.brief.length > 16000 ||
      (payload.model !== undefined && payload.model !== null && (typeof payload.model !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(payload.model))) ||
      (payload.cwd !== undefined && (!path.isAbsolute(payload.cwd) || payload.cwd.length > 1024))) return error(res, 400, 'invalid_request');
    if (!payload.cwd) return error(res, 400, 'workspace_required');
    const canonicalWorkspace = await fs.realpath(payload.cwd).catch(() => '');
    if (!canonicalWorkspace) return error(res, 400, 'workspace_unavailable');
    let ceiling = '';
    try { ceiling = await fs.realpath(projectsRoot()); } catch { return error(res, 503, 'projects_ceiling_unavailable', 'Projects workspace is unavailable'); }
    if (!isWithin(ceiling, canonicalWorkspace)) return error(res, 403, 'workspace_outside_projects', 'Workspace must be inside ~/Downloads/Projects');
    let matchedProject = payload.projectId
      ? await getProject(payload.projectId)
      : (await listProjects()).find(project => project.path === canonicalWorkspace) ?? null;
    if (!payload.projectId && !matchedProject) matchedProject = await addProject(canonicalWorkspace).catch(() => null);
    const projectId = matchedProject?.id;
    if (!projectId) return error(res, 400, 'project_not_found');
    const project = await getProject(projectId); if (!project) return error(res, 400, 'project_not_found');
    const workspace = await projectWorkspace(projectId);
    if (workspace.real !== canonicalWorkspace) return error(res, 409, 'workspace_project_mismatch');
    if (payload.sessionId) {
      const session = await getSession(payload.sessionId);
      if (!session || session.projectId !== projectId) return error(res, 409, 'session_project_mismatch');
    }
    const requestHash = hash({ requestId: payload.requestId, projectId, sessionId: payload.sessionId ?? null,
      cwd: canonicalWorkspace, brief: payload.brief, model: payload.model ?? null, effort: payload.effort ?? null });
    const createdAt = Date.now();
    const candidate: Task = { schemaVersion: 1, taskId: randomUUID(), requestId: payload.requestId!, payloadHash: requestHash,
      projectId, canonicalWorkspace, brief: payload.brief!, requestedModel: payload.model ?? null,
      requestedEffort: payload.effort ?? null, inputId: randomUUID(), inputIds: [], sessionId: payload.sessionId ?? null,
      conversationIds: [], currentTurnId: null, eventCursor: 0, state: 'queued', outcome: null, finalText: null,
      createdAt, updatedAt: createdAt };
    candidate.inputIds.push(candidate.inputId);
    inputArgs.parse({ id: candidate.inputId, projectId, sessionId: candidate.sessionId, text: supervisorText(candidate),
      mode: 'auto', dueAt: createdAt, model: candidate.requestedModel, reasoningEffort: candidate.requestedEffort, automation: 'off' });
    const admitted = await serial(async () => {
      const prior = tasks.find(task => task.requestId === payload.requestId);
      if (prior) return { prior, task: null };
      const leased = tasks.find(task => task.canonicalWorkspace === canonicalWorkspace && !['succeeded', 'failed', 'cancelled'].includes(task.state));
      if (leased) return { prior: leased, task: null };
      tasks.push(candidate); await saveTasks(); return { prior: null, task: candidate };
    });
    if (admitted.prior) return admitted.prior.requestId === payload.requestId && admitted.prior.payloadHash === requestHash
      ? json(res, 200, { taskId: admitted.prior.taskId, state: admitted.prior.state })
      : error(res, 409, admitted.prior.requestId === payload.requestId ? 'request_conflict' : 'workspace_leased');
    const task = admitted.task!;
    const supervisorBrief = supervisorText(task);
    void sendDesktopInput(inputArgs.parse({ id: task.inputId, projectId: task.projectId, sessionId: task.sessionId, text: supervisorBrief, mode: 'auto', dueAt: task.createdAt, model: task.requestedModel, reasoningEffort: task.requestedEffort, automation: 'off' }))
      .then(() => undefined, async cause => { await serial(async () => { if (!task.cancellationRequestedAt) { task.state = 'failed'; task.outcome = cause instanceof Error ? cause.message : String(cause); } task.updatedAt = Date.now(); await saveTasks(); }); });
    return json(res, 202, { taskId: task.taskId, state: task.state });
  }
  const id = taskId(pathname); if (!id) return error(res, 404, 'not_found');
  const task = tasks.find(item => item.taskId === id); if (!task) return error(res, 404, 'task_not_found');
  const requestedCursor = url.searchParams.get('after');
  const originalCursor = requestedCursor === null ? task.eventCursor : Number(requestedCursor);
  const waitMs = Math.min(45_000, Math.max(0, Number(url.searchParams.get('timeout') ?? '0') * 1000 || 0));
  const deadline = Date.now() + waitMs;
  do {
    await serial(async () => { await refresh(task); await saveTasks(); });
    if (waitMs === 0 || task.eventCursor > originalCursor || ['awaiting_input', 'succeeded', 'failed', 'cancelled'].includes(task.state) || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  } while (true);
  if (req.method === 'GET' && pathname.endsWith('/result')) return json(res, 200, { taskId: task.taskId, state: task.state, outcome: task.outcome, finalText: task.finalText, sessionId: task.sessionId, conversationIds: task.conversationIds });
  if (req.method === 'GET') return json(res, 200, { ...taskView(task), events: [] });
  if (req.method === 'POST' && pathname.endsWith('/input')) {
    const payload = await body(req) as Partial<TaskMessage>;
    if (!validId(payload.messageId) || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 16000 || !task.sessionId) return error(res, 400, 'invalid_input');
    const payloadHash = hash({ text: payload.text, projectId: task.projectId, sessionId: task.sessionId });
    const sent = await serial(async () => {
      if (task.cancellationRequestedAt || ['succeeded', 'failed', 'cancelled'].includes(task.state)) return { terminal: true, prior: null, sent: null };
      const prior = task.messages?.find(message => message.messageId === payload.messageId);
      if (prior) {
        if (prior.payloadHash === payloadHash && !(await listInputs()).some(input => input.id === prior.inputId)) {
          await sendDesktopInput(inputArgs.parse({ id: prior.inputId, projectId: task.projectId, sessionId: task.sessionId,
            text: prior.text, mode: 'auto', dueAt: prior.dueAt, model: null, reasoningEffort: null, automation: 'off' }));
        }
        return { terminal: false, prior, sent: null };
      }
      const dueAt = Date.now();
      const input = inputArgs.parse({ id: payload.messageId, projectId: task.projectId, sessionId: task.sessionId, text: payload.text, mode: 'auto', dueAt, model: null, reasoningEffort: null, automation: 'off' });
      const intent = { messageId: payload.messageId!, payloadHash, inputId: input.id, text: input.text, dueAt };
      task.inputIds.push(input.id); (task.messages ??= []).push(intent);
      task.boundInputSeq = undefined; task.boundTurnId = undefined; task.currentTurnId = null; task.finalText = null; await saveTasks();
      const delivered = await sendDesktopInput(input); return { terminal: false, prior: null, sent: delivered };
    });
    if (sent.terminal) return error(res, 409, 'task_terminal');
    if (sent.prior) return sent.prior.payloadHash === payloadHash ? json(res, 200, { messageId: sent.prior.inputId, state: task.state }) : error(res, 409, 'message_conflict');
    return json(res, 202, { messageId: sent.sent!.id, state: sent.sent!.state });
  }
  if (req.method === 'POST' && pathname.endsWith('/cancel')) {
    await serial(async () => {
      if (['succeeded', 'failed', 'cancelled'].includes(task.state)) return;
      task.cancellationRequestedAt ??= Date.now(); task.state = 'cancelling'; await saveTasks();
      await Promise.all(task.inputIds.map(inputId => cancelDesktopInput(inputId).catch(() => false)));
      if (task.sessionId && task.currentTurnId) await stopSessionTurn(task.sessionId, task.currentTurnId).catch(() => undefined);
      for (const conversationId of task.conversationIds) setChatBlocked(conversationId, true);
      if (task.sessionId) await Promise.all([...execProcessIdsOwnedBy(task.sessionId)].map(processId => unifiedExecManager.terminateProcess(processId)));
      await refresh(task); await saveTasks();
    });
    return json(res, 202, { taskId: task.taskId, state: task.state });
  }
  return error(res, 404, 'not_found');
}

export async function startControlService(userDataDir: string): Promise<string> {
  if (process.platform !== 'darwin') return '';
  await loadTasks();
  const requested = process.env.COS_CONTROL_SOCKET;
  socketPath = requested || path.join(userDataDir, 'control', 'cos.sock');
  if (socketPath.length >= 100) throw new Error('control socket path too long');
  const dir = path.dirname(socketPath); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const dirStat = await fs.lstat(dir); if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || dirStat.uid !== process.getuid?.()) throw new Error('control directory ownership/type refused');
  await fs.chmod(dir, 0o700);
  try { const stat = await fs.lstat(socketPath); if (stat.isSymbolicLink() || !stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('control socket ownership/type refused'); await fs.unlink(socketPath); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
  server = http.createServer((req, res) => { route(req, res).catch(cause => error(res, cause instanceof Error && cause.message === 'body_too_large' ? 413 : 400, cause instanceof Error ? cause.message : 'request_failed')); });
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(socketPath, () => resolve()); });
  const socketStat = await fs.lstat(socketPath); if (!socketStat.isSocket() || socketStat.uid !== process.getuid?.()) { await stopControlService(); throw new Error('control socket ownership/type refused'); }
  await fs.chmod(socketPath, 0o600);
  discoveryPath = path.join(dir, 'cos-control.json');
  try { if ((await fs.lstat(discoveryPath)).isSymbolicLink()) throw new Error('control discovery symlink refused'); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
  const discoveryTemp = `${discoveryPath}.${process.pid}.tmp`; await fs.writeFile(discoveryTemp, JSON.stringify({ apiVersion: API, socketPath }), { mode: 0o600, flag: 'wx' }); await fs.rename(discoveryTemp, discoveryPath); await fs.chmod(discoveryPath, 0o600);
  const inputs = await listInputs();
  for (const task of tasks.filter(task => task.state === 'queued' && !inputs.some(input => input.id === task.inputId))) {
    const input = inputArgs.parse({ id: task.inputId, projectId: task.projectId, sessionId: task.sessionId, text: supervisorText(task), mode: 'auto', dueAt: task.createdAt, model: task.requestedModel, reasoningEffort: task.requestedEffort, automation: 'off' });
    void sendDesktopInput(input).catch(() => undefined);
  }
  for (const task of tasks) for (const message of task.messages ?? []) {
    if (inputs.some(input => input.id === message.inputId) || task.cancellationRequestedAt || ['succeeded', 'failed', 'cancelled'].includes(task.state)) continue;
    const input = inputArgs.parse({ id: message.inputId, projectId: task.projectId, sessionId: task.sessionId, text: message.text, mode: 'auto', dueAt: message.dueAt, model: null, reasoningEffort: null, automation: 'off' });
    void sendDesktopInput(input).catch(() => undefined);
  }
  return socketPath;
}
export async function stopControlService(): Promise<void> {
  if (!server) return; await new Promise<void>(resolve => server!.close(() => resolve())); server = null;
  await fs.rm(socketPath, { force: true }).catch(() => undefined); await fs.rm(discoveryPath, { force: true }).catch(() => undefined);
}
export function controlSocketPath(): string { return socketPath; }

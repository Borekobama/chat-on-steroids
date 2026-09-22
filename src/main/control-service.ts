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
import { readDurable, writeDurableNow, writeDurableSoon } from './durable.js';
import { addProject, getProject, listProjects, projectWorkspace } from './projects.js';
import { execProcessIdsOwnedBy } from './codex/ownership.js';
import { unifiedExecManager } from './codex/manager.js';
import type { SessionEvent } from '../shared/session.js';
import { READONLY_MAX_BODY, runReadonlyCodex } from './control-readonly.js';
import { getConfig } from './config.js';

const STATE = 'control-tasks';
const API = '1';
const MAX_BODY = 64 * 1024;
const ID = /^[0-9a-f-]{36}$/i;

type TaskState = 'queued' | 'delivering' | 'running' | 'awaiting_input' | 'recovering' | 'cancelling' | 'delivery_failed' | 'succeeded' | 'failed' | 'cancelled';
export type Task = {
  schemaVersion: 1; taskId: string; requestId: string; payloadHash: string;
  projectId: string | null; canonicalWorkspace: string | null; brief: string;
  requestedModel: string | null; requestedEffort: string | null;
  inputId: string; sessionId: string | null; conversationIds: string[]; currentTurnId: string | null;
  eventCursor: number; state: TaskState; outcome: string | null; finalText: string | null;
  createdAt: number; updatedAt: number; cancellationRequestedAt?: number;
  cancellationBlocks?: string[];
  inputIds: string[];
  messages?: Array<{ messageId: string; payloadHash: string; inputId: string; text: string; dueAt: number }>;
  boundInputSeq?: number; boundTurnId?: string;
  completionStatus?: 'succeeded' | 'failed'; completionSeq?: number; completionRecordedAt?: number;
  completionInputId?: string; completionTurnId?: string;
  completionAcknowledged?: boolean;
  inputReplayAt?: number;
  failureReason?: string; deliveryState?: string;
  lastEvent?: Record<string, unknown>; lastToolCall?: Record<string, unknown>;
};
type TaskInput = { requestId: string; projectId?: string | null; sessionId?: string | null; cwd?: string; brief: string; model?: string | null; effort?: string | null };
type TaskMessage = { messageId: string; text: string };
export type ControlRefreshHooks = {
  listInputs: typeof listInputs;
  getSession: typeof getSession;
  readEvents: typeof readEvents;
  processIdsOwnedBy: (sessionId: string) => Iterable<number>;
  hasProcessOrReservation: (processId: number) => boolean;
  sendInput?: typeof sendDesktopInput;
};
const refreshHooks: ControlRefreshHooks = {
  listInputs,
  getSession,
  readEvents,
  processIdsOwnedBy: execProcessIdsOwnedBy,
  sendInput: sendDesktopInput,
  hasProcessOrReservation: processId => { const state = unifiedExecManager.backgroundState(new Set([processId])); return state.running.includes(processId) || state.exitedUnread.some(row => row.processId === processId); }
};

let socketPath = '';
let discoveryPath = '';
let server: http.Server | null = null;
let tasks: Task[] = [];
let committedTasks: Task[] = [];
let taskLock = Promise.resolve();
let cancellationSweep: NodeJS.Timeout | null = null;
const TERMINAL_STATES = new Set<TaskState>(['delivery_failed', 'succeeded', 'failed', 'cancelled']);
const terminal = (state: TaskState): boolean => TERMINAL_STATES.has(state);

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
export function migrateTask(value: unknown): Task | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<Task>;
  if (item.schemaVersion !== undefined && item.schemaVersion !== 1) return null;
  if (item.messages !== undefined && (!Array.isArray(item.messages) || item.messages.some(message =>
    !message || !validId(message.messageId) || !validId(message.inputId) ||
    typeof message.payloadHash !== 'string' || typeof message.text !== 'string' || !Number.isFinite(message.dueAt)))) return null;
  for (const key of ['createdAt', 'updatedAt', 'eventCursor', 'boundInputSeq', 'completionSeq', 'completionRecordedAt', 'inputReplayAt', 'cancellationRequestedAt'] as const) {
    if (item[key] !== undefined && (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key]! < 0)) return null;
  }
  if (!validId(item.taskId) || !validId(item.requestId) || typeof item.brief !== 'string' ||
      !Array.isArray(item.inputIds) && !validId(item.inputId)) return null;
  const inputId = validId(item.inputId) ? item.inputId : item.inputIds?.[0];
  if (!validId(inputId)) return null;
  const now = Date.now();
  return {
    schemaVersion: 1, taskId: item.taskId, requestId: item.requestId,
    payloadHash: typeof item.payloadHash === 'string' ? item.payloadHash : hash(item),
    projectId: typeof item.projectId === 'string' ? item.projectId : null,
    canonicalWorkspace: typeof item.canonicalWorkspace === 'string' ? item.canonicalWorkspace : null,
    brief: item.brief, requestedModel: typeof item.requestedModel === 'string' ? item.requestedModel : null,
    requestedEffort: typeof item.requestedEffort === 'string' ? item.requestedEffort : null,
    inputId, inputIds: Array.isArray(item.inputIds) && item.inputIds.length ? item.inputIds.filter(validId) : [inputId],
    sessionId: typeof item.sessionId === 'string' ? item.sessionId : null,
    conversationIds: Array.isArray(item.conversationIds) ? item.conversationIds.filter((id): id is string => typeof id === 'string') : [],
    currentTurnId: typeof item.currentTurnId === 'string' ? item.currentTurnId : null,
    eventCursor: typeof item.eventCursor === 'number' && Number.isFinite(item.eventCursor) ? item.eventCursor : 0,
    state: typeof item.state === 'string' && ['queued', 'delivering', 'running', 'awaiting_input', 'recovering', 'cancelling', 'delivery_failed', 'succeeded', 'failed', 'cancelled'].includes(item.state)
      ? item.state as TaskState : 'queued',
    outcome: typeof item.outcome === 'string' ? item.outcome : null,
    finalText: typeof item.finalText === 'string' ? item.finalText : null,
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : now,
    cancellationRequestedAt: item.cancellationRequestedAt,
    cancellationBlocks: Array.isArray(item.cancellationBlocks) ? item.cancellationBlocks.filter((id): id is string => typeof id === 'string') : undefined,
    messages: Array.isArray(item.messages) ? item.messages : undefined,
    boundInputSeq: item.boundInputSeq, boundTurnId: item.boundTurnId,
    completionStatus: item.completionStatus, completionSeq: item.completionSeq,
    completionRecordedAt: item.completionRecordedAt, completionInputId: item.completionInputId,
    completionTurnId: item.completionTurnId, inputReplayAt: item.inputReplayAt,
    completionAcknowledged: item.completionAcknowledged === true,
    failureReason: item.failureReason, deliveryState: item.deliveryState,
    lastEvent: item.lastEvent, lastToolCall: item.lastToolCall
  };
}
async function loadTasks(): Promise<void> {
  const saved = await readDurable<unknown>(STATE);
  const values = Array.isArray(saved) ? saved : [];
  const migrated = values.map(migrateTask);
  const rejected = values.filter((_value, index) => migrated[index] === null);
  tasks = migrated.filter((task): task is Task => task !== null);
  committedTasks = structuredClone(tasks);
  if (rejected.length) await writeDurableNow(`${STATE}-quarantine`, { schemaVersion: 1, records: rejected.slice(0, 100) });
  if (tasks.length !== values.length) await saveTasks();
}
async function saveTasks(): Promise<void> {
  // Keep request receipts and cancellation ownership: count eviction permits duplicate execution.
  const next = structuredClone(tasks);
  try {
    await writeDurableNow(STATE, next);
    committedTasks = next;
  } catch (cause) {
    const current = new Map(tasks.map(task => [task.taskId, task]));
    tasks = committedTasks.map(saved => {
      const task = current.get(saved.taskId) ?? {} as Task;
      for (const key of Object.keys(task)) delete (task as unknown as Record<string, unknown>)[key];
      return Object.assign(task, structuredClone(saved));
    });
    writeDurableSoon(STATE, structuredClone(committedTasks));
    throw cause;
  }
}
function scheduleCancellationSweep(): void {
  if (cancellationSweep || !tasks.some(task => task.cancellationBlocks?.length)) return;
  cancellationSweep = setTimeout(() => {
    cancellationSweep = null;
    void serial(async () => {
      for (const task of tasks.filter(item => item.cancellationBlocks?.length)) await refresh(task);
      await saveTasks();
    }).catch(() => undefined).finally(scheduleCancellationSweep);
  }, 1000);
  cancellationSweep.unref?.();
}
function taskView(task: Task): Omit<Task, 'brief'> { const { brief: _brief, ...view } = task; return view; }
export function workspaceLeaseView(task: Task) {
  return { error: 'workspace_leased', message: 'Workspace already has an active task',
    taskId: task.taskId, state: task.state, workspace: task.canonicalWorkspace };
}
function supervisorText(task: Task): string {
  return `${task.brief}\n\nCoS WEB SUPERVISOR TASK\nTask ID: ${task.taskId}\nWorkspace: ${task.canonicalWorkspace}\nKeep this ChatGPT conversation as Supervisor Shunt parent. Use one supervisor-shunt run-role invocation at a time with --parent-host chatgpt_cos. Inspect actual diffs and verify independently. One precise correction is allowed before escalation. Do not use CoS worker chats, Goal, or Loop. Do not launch nested Shunt agents. End with changed files, verification, and unresolved blockers. When acceptance is complete, call supervisor_task_finish with task_id=${task.taskId} and status=succeeded, then end the same turn with the final response. This task form records immediately and does not hold the turn. For terminal failure, use status=failed. If user input is needed, omit supervisor_task_finish and ask one clear question.`;
}

export function deliveredTurnId(events: Awaited<ReturnType<typeof readEvents>>, inputId: string): { seq: number; time: number; turnId: string } | null {
  const user = events.find(event => event.kind === 'user_message' && event.inputId === inputId &&
    (event.inputDelivery === 'offered' || event.inputDelivery === 'confirmed'));
  if (!user) return null;
  // A tool handout is published to history before the carrier tool call itself is recorded.
  // That exact later call therefore supplies the provider turn immediately. Its call start
  // time remains older than the offer and is fenced from task-completion evidence below.
  const turnId = user.turnId ?? events.find(event => event.seq > user.seq &&
    (event.kind === 'tool_call' || event.kind === 'assistant_message') && event.turnId)?.turnId;
  return turnId ? { seq: user.seq, time: user.time, turnId } : null;
}

export function cancellationReachedTerminal(cancellationRequestedAt: number | undefined, hasTerminalTurn: boolean, hasOwnedProcess = false, isolated = false): boolean {
  return cancellationRequestedAt !== undefined && (hasTerminalTurn || isolated) && !hasOwnedProcess;
}

export function taskCompletionEvidence(events: SessionEvent[], taskId: string, inputSeq: number, turnId: string,
  terminalSeq = Number.POSITIVE_INFINITY, inputDeliveredAt = Number.NEGATIVE_INFINITY): { seq: number; status: 'succeeded' | 'failed' } | null {
  for (const event of events) {
    if (event.kind !== 'tool_call' || event.seq <= inputSeq || event.seq >= terminalSeq || event.turnId !== turnId ||
        event.call.tool !== 'supervisor_task_finish' ||
        event.call.outcome !== 'ok' || event.call.args.truncated || event.time <= inputDeliveredAt) continue;
    try {
      const args = JSON.parse(event.call.args.text) as { task_id?: unknown; status?: unknown };
      if (args.task_id === taskId && (args.status === 'succeeded' || args.status === 'failed')) return { seq: event.seq, status: args.status };
    } catch { /* Malformed recorder evidence cannot complete a task. */ }
  }
  return null;
}

export function recoveredTaskCompletionEvidence(events: SessionEvent[], taskId: string, inputSeq: number,
  inputDeliveredAt = Number.NEGATIVE_INFINITY, turnId?: string): { seq: number; time: number; status: 'succeeded' | 'failed'; turnId?: string } | null {
  for (const event of events) {
    if (event.kind !== 'tool_call' || event.seq <= inputSeq ||
        event.call.tool !== 'supervisor_task_finish' || !event.turnId ||
        event.call.outcome !== 'ok' || event.call.args.truncated || event.time <= inputDeliveredAt ||
        (turnId !== undefined && event.turnId !== turnId)) continue;
    try {
      const args = JSON.parse(event.call.args.text) as { task_id?: unknown; status?: unknown };
      if (args.task_id === taskId && (args.status === 'succeeded' || args.status === 'failed')) {
        return { seq: event.seq, time: event.time, status: args.status, turnId: event.turnId };
      }
    } catch { /* Malformed recorder evidence cannot complete a task. */ }
  }
  return null;
}

/** A successful tool response is a durable acknowledgement, never merely echoed arguments. */
export async function finishControlTask(taskId: string, status: 'succeeded' | 'failed',
  sessionId: string, conversationId: string, startedAt: number): Promise<void> {
  await serial(async () => {
    const task = tasks.find(item => item.taskId === taskId);
    if (!task || (task.sessionId !== null && task.sessionId !== sessionId) || task.cancellationRequestedAt || terminal(task.state)) {
      throw new Error('control_task_not_owned_or_active');
    }
    const session = await getSession(sessionId);
    if (!session || session.conversationId !== conversationId || !session.activeTurnId) {
      throw new Error('control_task_turn_unproven');
    }
    const inputId = task.inputIds.at(-1) ?? task.inputId;
    const events = await readEvents(sessionId);
    const delivered = deliveredTurnId(events, inputId);
    if (!delivered || !Number.isFinite(delivered.time) || startedAt <= delivered.time) {
      throw new Error('control_task_input_not_delivered');
    }
    if (session.activeTurnId !== delivered.turnId) throw new Error('control_task_turn_unproven');
    if (events.some(event => event.kind === 'user_message' && event.seq > delivered.seq && event.inputId !== inputId)) {
      throw new Error('control_task_input_superseded');
    }
    task.boundInputSeq = delivered.seq;
    task.sessionId = sessionId;
    task.boundTurnId = delivered.turnId;
    task.completionInputId = inputId;
    task.completionTurnId = session.activeTurnId;
    task.completionStatus = status;
    task.completionAcknowledged = true;
    task.completionRecordedAt = Date.now();
    task.completionSeq = events.reduce((last, event) => Math.max(last, event.seq), delivered.seq);
    task.updatedAt = Date.now();
    await saveTasks();
  });
}

function eventView(event: SessionEvent): Record<string, unknown> {
  const view: Record<string, unknown> = { seq: event.seq, time: event.time, kind: event.kind };
  if ('turnId' in event && event.turnId) view.turnId = event.turnId;
  if (event.kind === 'turn_end') { view.outcome = event.outcome; if (event.detail) view.detail = event.detail; }
  if (event.kind === 'tool_call') { view.tool = event.call.tool; view.outcome = event.call.outcome; }
  return view;
}

async function body(req: http.IncomingMessage, maxBody = MAX_BODY): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += (chunk as Buffer).length; if (size > maxBody) throw new Error('body_too_large'); chunks.push(chunk as Buffer); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('invalid_json'); }
}
function taskId(pathname: string): string | null { const match = pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/([^/]+))?$/); return match?.[1] && validId(match[1]) ? match[1] : null; }
async function refresh(task: Task, hooks: ControlRefreshHooks = refreshHooks): Promise<Task> {
  const alreadyCompleted = task.completionStatus !== undefined;
  const activeInputId = task.inputIds.at(-1) ?? task.inputId;
  let row = (await hooks.listInputs()).find(input => input.id === activeInputId);
  if (!row && !task.cancellationRequestedAt && hooks.sendInput && (!task.inputReplayAt || Date.now() - task.inputReplayAt >= 1000) && !terminal(task.state)) {
    task.inputReplayAt = Date.now();
    const message = task.messages?.find(item => item.inputId === activeInputId);
    const input = inputArgs.parse({ id: activeInputId, projectId: task.projectId, sessionId: task.sessionId,
      text: message?.text ?? supervisorText(task), mode: 'auto', dueAt: message?.dueAt ?? task.createdAt,
      model: message ? null : task.requestedModel, reasoningEffort: message ? null : task.requestedEffort, automation: 'off' });
    await hooks.sendInput(input).catch(() => undefined);
    row = (await hooks.listInputs()).find(inputRow => inputRow.id === activeInputId);
  }
  if (row && !alreadyCompleted) {
    task.sessionId = row.deliveredSessionId ?? task.sessionId ?? null;
    if (row.state === 'queued') task.state = 'queued';
    else if (row.state === 'browser' || row.state === 'tool') task.state = 'delivering';
    else if (row.state === 'failed') { task.state = 'failed'; task.outcome = row.error ?? 'input_failed'; task.failureReason = task.outcome; }
    else if (row.state === 'cancelled' && task.state !== 'cancelling') { task.state = 'cancelled'; task.outcome = row.error ?? 'input_cancelled'; }
  }
  let exactTerminal = false;
  if (task.sessionId) {
    const session = await hooks.getSession(task.sessionId);
    if (session) {
      if (session.conversationId && !task.conversationIds.includes(session.conversationId)) task.conversationIds.push(session.conversationId);
      const events = await hooks.readEvents(task.sessionId, { from: task.boundInputSeq ?? 0 });
      const lastEvent = events.at(-1);
      const lastTool = events.findLast(event => event.kind === 'tool_call');
      if (lastEvent) task.lastEvent = eventView(lastEvent);
      if (lastTool) task.lastToolCall = eventView(lastTool);
      const binding = task.boundTurnId ? null : deliveredTurnId(events, activeInputId);
      if (binding) {
        task.boundInputSeq = binding.seq;
        task.boundTurnId = binding.turnId;
        // Keep the prior answer while a follow-up is only queued. Exact delivery is the point
        // at which that answer stops satisfying the task's current work.
        task.finalText = null;
      }
      // Current provider turn is not proof that this task's exact input started it.
      // A recorder restart may lose the binding; fail closed instead of accepting stale evidence.
      const turnId = task.boundTurnId;
      const inputSeq = task.boundInputSeq ?? 0;
      const end = inputSeq !== undefined && turnId ? events.find(event => event.kind === 'turn_end' && event.seq > inputSeq && event.turnId === turnId) : undefined;
      exactTerminal = end?.kind === 'turn_end';
      if (turnId) task.currentTurnId = !exactTerminal ? turnId : null;
      else if (task.currentTurnId && events.some(event => event.kind === 'turn_end' && event.turnId === task.currentTurnId)) task.currentTurnId = null;
      // Only the handler's persisted acknowledgement owns completion. Recorder arguments
      // cannot recreate authority lost before admission or belonging to a previous input.
      if (task.completionStatus && (!task.completionAcknowledged || task.completionInputId !== activeInputId || !task.completionTurnId)) {
        task.completionStatus = undefined;
      }
      const completionTurnId = task.completionTurnId ?? turnId;
      const final = events.findLast((event): event is Extract<typeof event, { kind: 'assistant_message' }> =>
        event.kind === 'assistant_message' && event.seq > inputSeq && event.final && event.state === 'final' &&
        event.turnId === completionTurnId && (!task.completionSeq || event.seq > task.completionSeq));
      if (final && task.completionInputId === activeInputId) task.finalText = final.message.text;
      if (task.completionStatus === 'failed') {
        task.state = 'failed'; task.outcome = 'supervisor_failed'; task.failureReason = 'Supervisor reported task failure.';
      }
      else if (task.completionStatus === 'succeeded') {
        if (final) { task.state = 'succeeded'; task.outcome = 'completed'; task.deliveryState = 'delivered'; task.failureReason = undefined; }
        else if (Date.now() - (task.completionRecordedAt ?? Date.now()) >= 60_000) {
          task.state = 'delivery_failed'; task.outcome = 'final_delivery_missing'; task.deliveryState = 'failed';
          task.failureReason = 'Supervisor completed work, but no final assistant response was recorded within 60 seconds.';
        } else { task.state = 'delivering'; task.outcome = 'completion_recorded'; task.deliveryState = 'pending'; }
      }
      else if (end?.kind === 'turn_end') {
        if (task.cancellationRequestedAt) task.state = 'cancelling';
        else if (end.outcome !== 'completed') {
          task.failureReason = end.detail ?? end.reason ?? end.outcome;
          const laterActivity = events.some(event => event.seq > end.seq &&
            (event.kind === 'tool_call' || event.kind === 'assistant_message' || event.kind === 'user_message'));
          task.state = laterActivity || Date.now() - end.time < 60_000 ? 'recovering' : 'failed';
          task.outcome = task.failureReason;
        }
        else task.state = 'awaiting_input';
      }
      else if (task.cancellationRequestedAt) task.state = 'cancelling';
      else if (task.boundTurnId) task.state = 'running';
      for (const event of events) task.eventCursor = Math.max(task.eventCursor, event.seq);
    }
  }
  const hasOwnedProcess = !!task.sessionId && [...hooks.processIdsOwnedBy(task.sessionId)]
    .some(processId => hooks.hasProcessOrReservation(processId));
  if (task.cancellationBlocks?.length) {
    if (exactTerminal && !hasOwnedProcess) {
      for (const conversationId of task.cancellationBlocks) setChatBlocked(conversationId, false);
      task.cancellationBlocks = [];
    } else {
      for (const conversationId of task.cancellationBlocks) setChatBlocked(conversationId, true);
    }
  }
  const undeliveredCancelled = !task.boundTurnId && (!row || row.state === 'cancelled' || row.state === 'failed');
  if (!task.cancellationRequestedAt && hasOwnedProcess && terminal(task.state)) {
    task.state = 'running'; task.outcome = null;
  } else if (cancellationReachedTerminal(task.cancellationRequestedAt, exactTerminal || undeliveredCancelled, hasOwnedProcess,
    task.conversationIds.length > 0 && task.conversationIds.every(isChatBlocked))) {
    task.state = 'cancelled'; task.outcome = 'cancelled';
  } else if (task.cancellationRequestedAt) {
    task.state = 'cancelling'; task.outcome = null;
  }
  return task;
}

/** Test seam for the real refresh state machine; production uses process/session owners above. */
export async function refreshControlTaskForTests(task: Task, hooks: ControlRefreshHooks): Promise<Task> {
  return refresh(structuredClone(task), hooks);
}

/** A new message invalidates prior completion authority. The currently running provider turn
 * and prior final stay useful until this exact new input actually crosses a delivery boundary. */
export function beginControlTaskFollowup(task: Task): void {
  task.boundInputSeq = undefined;
  task.boundTurnId = undefined;
  task.completionStatus = undefined;
  task.completionSeq = undefined;
  task.completionRecordedAt = undefined;
  task.completionInputId = undefined;
  task.completionTurnId = undefined;
  task.completionAcknowledged = undefined;
  task.deliveryState = undefined;
}
async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  if (req.method === 'GET' && pathname === '/v1/health') {
    const capabilities = ['submit', 'status', 'result', 'input', 'cancel', 'supervisor_task_finish'];
    const sandbox = getConfig().commandSandbox;
    const executableReady = sandbox.enabled && path.isAbsolute(sandbox.codexPath) && await fs.stat(sandbox.codexPath)
      .then(stat => stat.isFile() && (stat.mode & 0o111) !== 0, () => false);
    if (executableReady) capabilities.push('worker_writable', 'command_sandbox');
    if (process.platform === 'darwin' && executableReady) capabilities.push('codex_readonly');
    return json(res, 200, { apiVersion: API, ready: true, capabilities, capabilityReasons: {
      worker_writable: executableReady ? 'available' : sandbox.enabled ? 'codex_executable_unavailable' : 'disabled',
      codex_readonly: process.platform !== 'darwin' ? 'platform_unavailable' : executableReady ? 'available' : 'sandbox_unavailable'
    } });
  }
  if (req.method === 'POST' && pathname === '/v1/codex/readonly') {
    const result = await runReadonlyCodex(await body(req, READONLY_MAX_BODY));
    return json(res, 200, result);
  }
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
      const leased = tasks.find(task => task.canonicalWorkspace && !terminal(task.state) &&
        (isWithin(task.canonicalWorkspace, canonicalWorkspace) || isWithin(canonicalWorkspace, task.canonicalWorkspace)));
      if (leased) return { prior: leased, task: null };
      tasks.push(candidate); await saveTasks(); return { prior: null, task: candidate };
    });
    if (admitted.prior) return admitted.prior.requestId === payload.requestId && admitted.prior.payloadHash === requestHash
      ? json(res, 200, { taskId: admitted.prior.taskId, state: admitted.prior.state })
      : admitted.prior.requestId === payload.requestId
        ? error(res, 409, 'request_conflict')
        : json(res, 409, workspaceLeaseView(admitted.prior));
    const task = admitted.task!;
    const supervisorBrief = supervisorText(task);
    void sendDesktopInput(inputArgs.parse({ id: task.inputId, projectId: task.projectId, sessionId: task.sessionId, text: supervisorBrief, mode: 'auto', dueAt: task.createdAt, model: task.requestedModel, reasoningEffort: task.requestedEffort, automation: 'off' }))
      .catch(async cause => { await serial(async () => { if (!task.cancellationRequestedAt) { task.state = 'recovering'; task.outcome = cause instanceof Error ? cause.message : String(cause); } task.updatedAt = Date.now(); await saveTasks(); }); })
      .catch(() => undefined); // Durable rollback preserves the receipt for a later refresh.
    return json(res, 202, { taskId: task.taskId, state: task.state });
  }
  const id = taskId(pathname); if (!id) return error(res, 404, 'not_found');
  const task = tasks.find(item => item.taskId === id); if (!task) return error(res, 404, 'task_not_found');
  const requestedCursor = url.searchParams.get('after');
  const originalCursor = requestedCursor === null ? task.eventCursor : Number(requestedCursor);
  const waitMs = Math.min(45_000, Math.max(0, Number(url.searchParams.get('timeout') ?? '0') * 1000 || 0));
  const deadline = Date.now() + waitMs;
  do {
    await serial(async () => {
      const before = JSON.stringify({ ...task, updatedAt: 0 });
      await refresh(task);
      const after = JSON.stringify({ ...task, updatedAt: 0 });
      if (before !== after) { task.updatedAt = Date.now(); await saveTasks(); }
    });
    if (waitMs === 0 || task.eventCursor > originalCursor || task.state === 'awaiting_input' || terminal(task.state) || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  } while (true);
  if (req.method === 'GET' && pathname.endsWith('/result')) return json(res, 200, {
    taskId: task.taskId, state: task.state, outcome: task.outcome, finalText: task.finalText,
    failureReason: task.failureReason ?? null, deliveryState: task.deliveryState ?? null,
    eventCursor: task.eventCursor, lastEvent: task.lastEvent ?? null, lastToolCall: task.lastToolCall ?? null,
    sessionId: task.sessionId, conversationIds: task.conversationIds, turnId: task.currentTurnId,
    workspace: task.canonicalWorkspace
  });
  if (req.method === 'GET') return json(res, 200, { ...taskView(task), events: [] });
  if (req.method === 'POST' && pathname.endsWith('/input')) {
    const payload = await body(req) as Partial<TaskMessage>;
    if (!validId(payload.messageId) || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 16000 || !task.sessionId) return error(res, 400, 'invalid_input');
    const payloadHash = hash({ text: payload.text, projectId: task.projectId, sessionId: task.sessionId });
    const sent = await serial(async () => {
      if (task.cancellationRequestedAt || terminal(task.state)) return { terminal: true, prior: null, sent: null };
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
      beginControlTaskFollowup(task); await saveTasks();
      const delivered = await sendDesktopInput(input); return { terminal: false, prior: null, sent: delivered };
    });
    if (sent.terminal) return error(res, 409, 'task_terminal');
    if (sent.prior) return sent.prior.payloadHash === payloadHash ? json(res, 200, { messageId: sent.prior.inputId, state: task.state }) : error(res, 409, 'message_conflict');
    return json(res, 202, { messageId: sent.sent!.id, state: sent.sent!.state });
  }
  if (req.method === 'POST' && pathname.endsWith('/cancel')) {
    await serial(async () => {
      if (terminal(task.state)) return;
      task.cancellationRequestedAt ??= Date.now(); task.state = 'cancelling'; await saveTasks();
      await Promise.all(task.inputIds.map(inputId => cancelDesktopInput(inputId).catch(() => false)));
      if (task.sessionId && task.currentTurnId) await stopSessionTurn(task.sessionId, task.currentTurnId).catch(() => undefined);
      const cancellationBlocks = task.conversationIds.filter(conversationId => !isChatBlocked(conversationId));
      task.cancellationBlocks = [...new Set([...(task.cancellationBlocks ?? []), ...cancellationBlocks])];
      // Persist ownership before fallible browser/process side effects.
      await saveTasks();
      for (const conversationId of cancellationBlocks) {
        try { setChatBlocked(conversationId, true); } catch { /* refresh reconciles missing blocks */ }
      }
      if (task.sessionId) {
        await Promise.allSettled([...execProcessIdsOwnedBy(task.sessionId)].map(processId => unifiedExecManager.terminateProcess(processId)));
      }
      await refresh(task); task.updatedAt = Date.now(); await saveTasks();
      scheduleCancellationSweep();
    });
    return json(res, 202, { taskId: task.taskId, state: task.state });
  }
  return error(res, 404, 'not_found');
}

export async function startControlService(userDataDir: string): Promise<string> {
  if (process.platform !== 'darwin') return '';
  await loadTasks();
  scheduleCancellationSweep();
  const requested = process.env.COS_CONTROL_SOCKET;
  socketPath = requested || path.join(userDataDir, 'control', 'cos.sock');
  if (socketPath.length >= 100) throw new Error('control socket path too long');
  const dir = path.dirname(socketPath); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const dirStat = await fs.lstat(dir); if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || dirStat.uid !== process.getuid?.()) throw new Error('control directory ownership/type refused');
  await fs.chmod(dir, 0o700);
  try { const stat = await fs.lstat(socketPath); if (stat.isSymbolicLink() || !stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('control socket ownership/type refused'); await fs.unlink(socketPath); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
  server = http.createServer((req, res) => { route(req, res).catch(cause => {
    const message = cause instanceof Error ? cause.message : 'request_failed';
    const status = message === 'body_too_large' ? 413 : message === 'codex_readonly_busy' ? 429 : 400;
    error(res, status, message);
  }); });
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(socketPath, () => resolve()); });
  const socketStat = await fs.lstat(socketPath); if (!socketStat.isSocket() || socketStat.uid !== process.getuid?.()) { await stopControlService(); throw new Error('control socket ownership/type refused'); }
  await fs.chmod(socketPath, 0o600);
  discoveryPath = path.join(dir, 'cos-control.json');
  try { if ((await fs.lstat(discoveryPath)).isSymbolicLink()) throw new Error('control discovery symlink refused'); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
  const discoveryTemp = `${discoveryPath}.${process.pid}.tmp`; await fs.writeFile(discoveryTemp, JSON.stringify({ apiVersion: API, socketPath }), { mode: 0o600, flag: 'wx' }); await fs.rename(discoveryTemp, discoveryPath); await fs.chmod(discoveryPath, 0o600);
  const inputs = await listInputs();
  for (const task of tasks.filter(task => task.state === 'queued' && !task.cancellationRequestedAt && !inputs.some(input => input.id === task.inputId))) {
    const input = inputArgs.parse({ id: task.inputId, projectId: task.projectId, sessionId: task.sessionId, text: supervisorText(task), mode: 'auto', dueAt: task.createdAt, model: task.requestedModel, reasoningEffort: task.requestedEffort, automation: 'off' });
    void sendDesktopInput(input).catch(() => undefined);
  }
  for (const task of tasks) for (const message of task.messages ?? []) {
    if (inputs.some(input => input.id === message.inputId) || task.cancellationRequestedAt || terminal(task.state)) continue;
    const input = inputArgs.parse({ id: message.inputId, projectId: task.projectId, sessionId: task.sessionId, text: message.text, mode: 'auto', dueAt: message.dueAt, model: null, reasoningEffort: null, automation: 'off' });
    void sendDesktopInput(input).catch(() => undefined);
  }
  return socketPath;
}
export async function stopControlService(): Promise<void> {
  if (cancellationSweep) clearTimeout(cancellationSweep); cancellationSweep = null;
  if (!server) return; await new Promise<void>(resolve => server!.close(() => resolve())); server = null;
  await fs.rm(socketPath, { force: true }).catch(() => undefined); await fs.rm(discoveryPath, { force: true }).catch(() => undefined);
}
export function controlSocketPath(): string { return socketPath; }

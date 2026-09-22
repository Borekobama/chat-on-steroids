import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { initDurableStore, readDurable, writeDurableNow } from '../src/main/durable.js';
import { appendEvent, createSession, initSessionStore } from '../src/main/session/store.js';
import { finishControlTask, migrateTask } from '../src/main/control-service.js';
import { beginControlTaskFollowup, cancellationReachedTerminal, deliveredTurnId, recoveredTaskCompletionEvidence, refreshControlTaskForTests, startControlService, stopControlService, taskCompletionEvidence, workspaceLeaseView, type ControlRefreshHooks, type Task } from '../src/main/control-service.js';
import { readonlyCodexCommand, readonlyCodexEnvironment, readonlySeatbeltProfile, validateReadonlyRequest } from '../src/main/control-readonly.js';
import type { SessionEvent } from '../src/shared/session.js';
const blocked = vi.hoisted(() => new Set<string>());
vi.mock('../src/main/session/blocked-chats.js', () => ({
  isChatBlocked: (id: string) => blocked.has(id),
  setChatBlocked: (id: string, next: boolean) => next ? blocked.add(id) : blocked.delete(id)
}));

async function request(socketPath: string, method: string, route: string, value?: unknown): Promise<{ status: number; body: any }> {
  const body = value === undefined ? undefined : JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: route, headers: body ? {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body)
    } : {} }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

describe('CoS control service', () => {
  afterEach(() => { blocked.clear(); return stopControlService(); });

  it.runIf(process.platform === 'darwin')('serves health only on its protected Unix socket', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-control-'));
    initDurableStore(root);
    const socketPath = await startControlService(root);
    const response = await request(socketPath, 'GET', '/v1/health');
    expect(response).toEqual({ status: 200, body: {
      apiVersion: '1', ready: true, capabilities: ['submit', 'status', 'result', 'input', 'cancel', 'supervisor_task_finish'],
      capabilityReasons: { worker_writable: 'disabled', codex_readonly: 'sandbox_unavailable' }
    } });
    await expect((await import('node:fs/promises')).stat(socketPath).then(stat => stat.mode & 0o777)).resolves.toBe(0o600);
  });

  it.runIf(process.platform === 'darwin')('rejects malformed task admission before browser delivery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-control-'));
    initDurableStore(root);
    const socketPath = await startControlService(root);
    const response = await request(socketPath, 'POST', '/v1/tasks', { requestId: 'bad', brief: '' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });

  it.runIf(process.platform === 'darwin')('refuses to replace a non-socket control path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-control-'));
    initDurableStore(root);
    const control = path.join(root, 'control');
    await mkdir(control, { mode: 0o700 });
    await writeFile(path.join(control, 'cos.sock'), 'do not replace');
    await expect(startControlService(root)).rejects.toThrow('ownership/type refused');
  });

  it('binds delivered inputs when only the assistant event carries the provider turn id', () => {
    const events = [
      { kind: 'user_message', seq: 3, time: 100, inputId: 'input-1', inputDelivery: 'confirmed' },
      { kind: 'assistant_message', seq: 12, time: 200, turnId: 'provider-turn', final: true, state: 'final' }
    ] as SessionEvent[];
    expect(deliveredTurnId(events, 'input-1')).toEqual({ seq: 3, time: 100, turnId: 'provider-turn' });
  });

  it('binds an active-turn tool handout to its carrier call without treating that carrier as later work', () => {
    const events = [
      { kind: 'user_message', seq: 5, time: 200, inputId: 'input-2', inputDelivery: 'offered' },
      { kind: 'tool_call', seq: 6, time: 150, turnId: 'active-turn', call: { tool: 'read', outcome: 'ok', args: { truncated: false, text: '{}' } } }
    ] as SessionEvent[];
    expect(deliveredTurnId(events, 'input-2')).toEqual({ seq: 5, time: 200, turnId: 'active-turn' });
  });

  it('finishes cancellation after the bound turn reaches a terminal response', () => {
    expect(cancellationReachedTerminal(Date.now(), true)).toBe(true);
    expect(cancellationReachedTerminal(Date.now(), true, true)).toBe(false);
    expect(cancellationReachedTerminal(Date.now(), false)).toBe(false);
    expect(cancellationReachedTerminal(Date.now(), false, false, true)).toBe(true);
    expect(cancellationReachedTerminal(Date.now(), false, true, true)).toBe(false);
    expect(cancellationReachedTerminal(undefined, true)).toBe(false);
  });

  it('accepts only exact bound immediate task completion evidence', () => {
    const finish = (seq: number, turnId: string, taskId: string, status: string, time = seq * 10) => ({
      kind: 'tool_call', seq, time, turnId, call: { tool: 'supervisor_task_finish', outcome: 'ok', args: { truncated: false, text: JSON.stringify({ task_id: taskId, status }) } }
    }) as SessionEvent;
    const events = [
      finish(3, 'turn-1', 'wrong-task', 'succeeded'),
      finish(4, 'wrong-turn', 'task-1', 'succeeded'),
      finish(5, 'turn-1', 'task-1', 'failed')
    ];
    expect(taskCompletionEvidence(events, 'task-1', 2, 'turn-1')).toEqual({ seq: 5, status: 'failed' });
    expect(taskCompletionEvidence(events, 'task-1', 5, 'turn-1')).toBeNull();
    expect(taskCompletionEvidence(events, 'task-1', 2, 'turn-1', 5)).toBeNull();
    expect(taskCompletionEvidence([finish(6, 'turn-1', 'task-1', 'succeeded', 150)], 'task-1', 5, 'turn-1', 7, 200)).toBeNull();
    expect(taskCompletionEvidence([finish(6, 'turn-1', 'task-1', 'succeeded', 200)], 'task-1', 5, 'turn-1', 7, 200)).toBeNull();
  });

  it('recovers exact task completion after a provider retry changes turns', () => {
    const finish = { kind: 'tool_call', seq: 8, time: 300, turnId: 'retry', call: { tool: 'supervisor_task_finish', outcome: 'ok',
      args: { truncated: false, text: JSON.stringify({ task_id: 'task-1', status: 'succeeded' }) } } } as SessionEvent;
    expect(recoveredTaskCompletionEvidence([finish], 'task-1', 2, 200)).toEqual({ seq: 8, time: 300, status: 'succeeded', turnId: 'retry' });
    expect(recoveredTaskCompletionEvidence([finish], 'wrong-task', 2, 200)).toBeNull();
  });

  const task = (overrides: Partial<Task> = {}): Task => ({
    schemaVersion: 1, taskId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', requestId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', payloadHash: 'hash',
    projectId: 'project', canonicalWorkspace: '/workspace', brief: 'brief', requestedModel: null, requestedEffort: null,
    inputId: 'input-1', inputIds: ['input-1'], sessionId: 'session-1', conversationIds: [], currentTurnId: null,
    eventCursor: 0, state: 'delivering', outcome: null, finalText: null, createdAt: 1, updatedAt: 1, ...overrides
  });
  const hooks = (events: SessionEvent[], activeProcesses = false): ControlRefreshHooks => ({
    listInputs: async () => [{ id: 'input-1', state: 'sent', deliveredSessionId: 'session-1' }] as any,
    getSession: async () => ({ id: 'session-1', conversationId: 'conversation-1', activeTurnId: 'unrelated-active-turn' }) as any,
    readEvents: async () => events as any,
    processIdsOwnedBy: () => [91],
    hasProcessOrReservation: () => activeProcesses
  });

  const acknowledged = (turnId: string, seq = 2, recordedAt = Date.now()): Partial<Task> => ({
    completionAcknowledged: true,
    completionStatus: 'succeeded', completionInputId: 'input-1', completionTurnId: turnId,
    completionSeq: seq, completionRecordedAt: recordedAt
  });

  it.runIf(process.platform === 'darwin')('persists completion only for the delivered input and exact session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-completion-'));
    initDurableStore(root); initSessionStore(root);
    const session = await createSession({ conversationId: 'conversation-completion' });
    const inputId = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
    const row = task({ inputId, inputIds: [inputId], sessionId: null, state: 'running' });
    await writeDurableNow('control-tasks', [row]);
    await startControlService(root);
    await appendEvent(session.id, { kind: 'turn_start', source: 'app', time: 50, turnId: 'exact-turn' });
    await appendEvent(session.id, { kind: 'user_message', source: 'app', time: 100, turnId: 'exact-turn', inputId,
      inputDelivery: 'confirmed', message: { text: 'brief', chars: 5, truncated: false } });
    await expect(finishControlTask(row.taskId, 'succeeded', 'wrong-session', 'conversation-completion', 200)).rejects.toThrow('turn_unproven');
    await expect(finishControlTask(row.taskId, 'succeeded', session.id, 'conversation-completion', 100)).rejects.toThrow('not_delivered');
    await finishControlTask(row.taskId, 'succeeded', session.id, 'conversation-completion', 200);
    const saved = await readDurable<Task[]>('control-tasks');
    expect(saved?.[0]).toMatchObject({ completionAcknowledged: true, completionInputId: inputId, completionTurnId: 'exact-turn' });
    await appendEvent(session.id, { kind: 'user_message', source: 'app', time: 300, turnId: 'exact-turn',
      message: { text: 'new request', chars: 11, truncated: false } });
    await expect(finishControlTask(row.taskId, 'succeeded', session.id, 'conversation-completion', 400)).rejects.toThrow('superseded');
  });

  it('quarantines unknown versions and malformed persisted messages', () => {
    const row = task({ inputId: 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa', inputIds: [] });
    expect(migrateTask({ ...row, schemaVersion: 20 })).toBeNull();
    expect(migrateTask({ ...row, messages: [null] })).toBeNull();
    expect(migrateTask({ ...row, completionRecordedAt: 'bad' })).toBeNull();
    expect(migrateTask(row)?.inputIds).toEqual([row.inputId]);
  });

  it('does not accept legacy or unacknowledged completion-shaped recorder arguments', async () => {
    for (const tool of ['session_finish', 'supervisor_task_finish']) {
      const events = [
        { kind: 'user_message', seq: 1, time: 10, inputId: 'input-1', inputDelivery: 'confirmed', turnId: 'turn' },
        { kind: 'tool_call', seq: 2, time: 20, turnId: 'turn', call: { tool, outcome: 'ok', args: { truncated: false, text: JSON.stringify({ task_id: task().taskId, status: 'succeeded' }) } } },
        { kind: 'assistant_message', seq: 3, time: 30, turnId: 'turn', final: true, state: 'final', message: { text: 'wrong' } }
      ] as SessionEvent[];
      const result = await refreshControlTaskForTests(task(), hooks(events));
      expect(result.state).not.toBe('succeeded');
      expect(result.finalText).toBeNull();
    }
  });

  it('never replays a cancelled input missing from the outbox', async () => {
    const fixture = hooks([]);
    fixture.listInputs = async () => [];
    fixture.sendInput = vi.fn();
    await refreshControlTaskForTests(task({ cancellationRequestedAt: 1, state: 'cancelling' }), fixture);
    expect(fixture.sendInput).not.toHaveBeenCalled();
  });

  it('returns enough lease evidence to wait or cancel the exact task', () => {
    expect(workspaceLeaseView(task())).toEqual({
      error: 'workspace_leased', message: 'Workspace already has an active task',
      taskId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', state: 'delivering', workspace: '/workspace'
    });
  });

  it.each([3, 5])('accepts exact-turn final at sequence %i and retains the lease until process cleanup', async (finalSeq) => {
    const events = [
      { kind: 'user_message', seq: 1, inputId: 'input-1', inputDelivery: 'confirmed', turnId: 'exact-turn' },
      { kind: 'tool_call', seq: 2, turnId: 'exact-turn', call: { tool: 'session_finish', outcome: 'ok', args: { truncated: false, text: JSON.stringify({ task_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'succeeded' }) } } },
      { kind: 'assistant_message', seq: finalSeq, turnId: 'exact-turn', final: true, state: 'final', message: { text: 'done' } },
      { kind: 'turn_end', seq: 4, turnId: 'exact-turn', outcome: 'completed' }
    ] as SessionEvent[];
    await expect(refreshControlTaskForTests(task(acknowledged('exact-turn')), hooks(events, true))).resolves.toMatchObject({
      state: 'running', boundTurnId: 'exact-turn', currentTurnId: null, outcome: null
    });
    await expect(refreshControlTaskForTests(task(acknowledged('exact-turn')), hooks(events, false))).resolves.toMatchObject({
      state: 'succeeded', outcome: 'completed', finalText: 'done'
    });
  });

  it('cancels without final text only after exact turn end and process cleanup', async () => {
    const events = [
      { kind: 'user_message', seq: 1, inputId: 'input-1', inputDelivery: 'confirmed', turnId: 'exact-turn' },
      { kind: 'turn_end', seq: 2, turnId: 'exact-turn', outcome: 'stopped' }
    ] as SessionEvent[];
    const cancelling = task({ cancellationRequestedAt: 5 });
    await expect(refreshControlTaskForTests(cancelling, hooks(events, true))).resolves.toMatchObject({ state: 'cancelling' });
    await expect(refreshControlTaskForTests(cancelling, hooks(events, false))).resolves.toMatchObject({ state: 'cancelled', outcome: 'cancelled' });
  });

  it('keeps a provider failure recoverable and accepts later completion and final output', async () => {
    const taskId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const events = [
      { kind: 'user_message', seq: 1, time: 100, inputId: 'input-1', inputDelivery: 'confirmed', turnId: 'failed-turn' },
      { kind: 'turn_end', seq: 2, time: 150, turnId: 'failed-turn', outcome: 'failed', detail: 'Connection interrupted' },
      { kind: 'tool_call', seq: 3, time: 200, call: { tool: 'read', outcome: 'ok', args: { truncated: false, text: '{}' } } },
      { kind: 'tool_call', seq: 4, time: 250, turnId: 'retry-turn', call: { tool: 'session_finish', outcome: 'ok', args: { truncated: false, text: JSON.stringify({ task_id: taskId, status: 'succeeded' }) } } },
      { kind: 'assistant_message', seq: 5, time: 300, turnId: 'retry-turn', final: true, state: 'final', message: { text: 'recovered result' } }
    ] as SessionEvent[];
    await expect(refreshControlTaskForTests(task({ taskId, state: 'recovering', ...acknowledged('retry-turn', 4) }), hooks(events))).resolves.toMatchObject({
      state: 'succeeded', outcome: 'completed', finalText: 'recovered result', completionSeq: 4,
      lastToolCall: { seq: 4, tool: 'session_finish' }
    });
  });

  it('reports provider failure detail and last safe event diagnostics', async () => {
    const events = [
      { kind: 'user_message', seq: 1, time: 1, inputId: 'input-1', inputDelivery: 'confirmed', turnId: 'failed-turn' },
      { kind: 'turn_end', seq: 2, time: 2, turnId: 'failed-turn', outcome: 'failed', detail: 'Connection interrupted' }
    ] as SessionEvent[];
    await expect(refreshControlTaskForTests(task(), hooks(events))).resolves.toMatchObject({
      state: 'failed', outcome: 'Connection interrupted', failureReason: 'Connection interrupted',
      lastEvent: { seq: 2, kind: 'turn_end', outcome: 'failed', detail: 'Connection interrupted' }
    });
  });

  it('separates recorded completion from missing final delivery', async () => {
    const taskId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const events = [
      { kind: 'user_message', seq: 1, time: 1, inputId: 'input-1', inputDelivery: 'confirmed', turnId: 'exact-turn' },
      { kind: 'tool_call', seq: 2, time: 2, turnId: 'exact-turn', call: { tool: 'session_finish', outcome: 'ok', args: { truncated: false, text: JSON.stringify({ task_id: taskId, status: 'succeeded' }) } } },
      { kind: 'turn_end', seq: 3, time: 3, turnId: 'exact-turn', outcome: 'completed' }
    ] as SessionEvent[];
    await expect(refreshControlTaskForTests(task({ taskId, ...acknowledged('exact-turn', 2, 2) }), hooks(events))).resolves.toMatchObject({
      state: 'delivery_failed', outcome: 'final_delivery_missing', deliveryState: 'failed', completionSeq: 2
    });
  });

  it('releases only cancellation-owned blocks after exact turn termination', async () => {
    blocked.add('conversation-1');
    const events = [
      { kind: 'user_message', seq: 1, inputId: 'input-1', inputDelivery: 'confirmed', turnId: 'exact-turn' },
      { kind: 'turn_end', seq: 2, turnId: 'exact-turn', outcome: 'stopped' }
    ] as SessionEvent[];
    await expect(refreshControlTaskForTests(task({ state: 'cancelled', cancellationRequestedAt: 5,
      cancellationBlocks: ['conversation-1'] }), hooks(events))).resolves.toMatchObject({ state: 'cancelled', cancellationBlocks: [] });
    expect(blocked.has('conversation-1')).toBe(false);
  });

  it('rebinds followup work only from its new exact input evidence', async () => {
    const followup = task({ inputIds: ['input-1', 'input-2'], boundInputSeq: undefined, boundTurnId: undefined, finalText: 'old answer' });
    const evidence = [
      { kind: 'user_message', seq: 1, time: 10, inputId: 'input-1', inputDelivery: 'confirmed', turnId: 'stale-turn' },
      { kind: 'user_message', seq: 5, time: 50, inputId: 'input-2', inputDelivery: 'confirmed', turnId: 'followup-turn' }
    ] as SessionEvent[];
    const fixture = hooks(evidence);
    fixture.listInputs = async () => [{ id: 'input-2', state: 'sent', deliveredSessionId: 'session-1' }] as any;
    await expect(refreshControlTaskForTests(followup, fixture)).resolves.toMatchObject({
      state: 'running', boundInputSeq: 5, boundTurnId: 'followup-turn', currentTurnId: 'followup-turn', finalText: null
    });
  });

  it('keeps the active turn and prior final until a followup is actually delivered', async () => {
    const followup = task({ currentTurnId: 'active-turn', boundInputSeq: 2, boundTurnId: 'active-turn', finalText: 'old answer', inputIds: ['input-1', 'input-2'] });
    beginControlTaskFollowup(followup);
    expect(followup).toMatchObject({ currentTurnId: 'active-turn', finalText: 'old answer', boundInputSeq: undefined, boundTurnId: undefined });
    const fixture = hooks([]);
    fixture.listInputs = async () => [{ id: 'input-2', state: 'queued', deliveredSessionId: 'session-1' }] as any;
    await expect(refreshControlTaskForTests(followup, fixture)).resolves.toMatchObject({
      state: 'queued', currentTurnId: 'active-turn', finalText: 'old answer', boundTurnId: undefined
    });
  });

  it('rebinds active-turn tool input and requires completion to start after the handout', async () => {
    const taskId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const followup = task({ taskId, currentTurnId: 'active-turn', inputIds: ['input-1', 'input-2'], finalText: 'old answer' });
    beginControlTaskFollowup(followup);
    const evidence = [
      { kind: 'user_message', seq: 5, time: 200, inputId: 'input-2', inputDelivery: 'offered' },
      // This call carries the handout in its result. Its sequence is later, but it began before delivery.
      { kind: 'tool_call', seq: 6, time: 150, turnId: 'active-turn', call: { tool: 'session_finish', outcome: 'ok', args: { truncated: false, text: JSON.stringify({ task_id: taskId, status: 'succeeded' }) } } },
      { kind: 'tool_call', seq: 7, time: 250, turnId: 'active-turn', call: { tool: 'session_finish', outcome: 'ok', args: { truncated: false, text: JSON.stringify({ task_id: taskId, status: 'succeeded' }) } } },
      { kind: 'assistant_message', seq: 8, time: 300, turnId: 'active-turn', final: true, state: 'final', message: { text: 'new answer' } },
      { kind: 'turn_end', seq: 9, time: 310, turnId: 'active-turn', outcome: 'completed' }
    ] as SessionEvent[];
    const fixture = hooks(evidence);
    fixture.listInputs = async () => [{ id: 'input-2', state: 'tool', deliveredSessionId: 'session-1' }] as any;
    Object.assign(followup, acknowledged('active-turn', 7), { completionInputId: 'input-2' });
    await expect(refreshControlTaskForTests(followup, fixture)).resolves.toMatchObject({
      state: 'succeeded', boundInputSeq: 5, boundTurnId: 'active-turn', currentTurnId: null, finalText: 'new answer'
    });
  });

  it('constructs one fixed native seatbelt command and disables nested Codex sandboxes', () => {
    const executable = '/Applications/ChatGPT.app/Contents/Resources/codex';
    const workspace = '/Projects/app';
    const runtime = '/tmp/cos-run';
    const auth = '/Users/alice/.codex/auth.json';
    const command = readonlyCodexCommand(executable, workspace, runtime, 'gpt-5.6-sol', 'high', '/Projects/schema.json', auth);
    expect(command[0]).toBe('/usr/bin/sandbox-exec');
    expect(command).toContain('--sandbox');
    expect(command[command.indexOf('--sandbox') + 1]).toBe('danger-full-access');
    expect(command).toContain('--ephemeral');
    expect(command).toContain('--output-schema');
    expect(command).not.toContain('--permission-profile');
    expect(command.join(' ')).toContain('codex exec');
    const policy = readonlySeatbeltProfile(runtime, workspace, executable, auth, '/Projects/schema.json');
    expect(policy).not.toContain('(allow file-read*)');
    expect(policy).toContain(`(subpath "${workspace}")`);
    expect(policy).toContain(`(literal "${auth}")`);
    expect(policy).toContain('(literal "/Projects/schema.json")');
    expect(policy).toContain('(allow file-write* (subpath "/tmp/cos-run"))');
    expect(policy).not.toContain(`(allow file-write* (subpath "${workspace}"))`);
    expect(policy).toContain(`(deny file-write* (subpath "${workspace}"))`);
    expect(policy).toContain('(allow network-outbound)');
    expect(policy).toContain('(allow file-map-executable');
  });

  it('keeps HOME, CODEX_HOME and XDG state inside the private runtime', () => {
    const realHome = os.homedir();
    const runtime = path.join(os.tmpdir(), 'cos-run');
    const codeHome = path.join(runtime, '.codex');
    const environment = readonlyCodexEnvironment(runtime, codeHome, {
      HOME: realHome,
      CODEX_HOME: path.join(realHome, '.codex'),
      XDG_CONFIG_HOME: path.join(realHome, '.config'),
      XDG_CACHE_HOME: path.join(realHome, '.cache'),
      OPENAI_API_KEY: 'not-for-the-child',
      SSL_CERT_FILE: '/etc/ssl/cert.pem',
      PATH: '/usr/bin'
    });
    expect(environment.HOME).toBe(runtime);
    expect(environment.CODEX_HOME).toBe(codeHome);
    expect(environment.XDG_CONFIG_HOME).toBe(codeHome);
    expect(environment.XDG_CACHE_HOME).toBe(path.join(runtime, 'cache'));
    expect(environment.XDG_DATA_HOME).toBe(path.join(runtime, 'data'));
    expect(environment.PATH).toBe('/usr/bin');
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.SSL_CERT_FILE).toBe('/etc/ssl/cert.pem');
    expect(Object.values(environment)).not.toContain(path.join(realHome, '.codex'));
  });

  it('validates role, model, reasoning, Projects containment and regular JSON schemas', async () => {
    const projects = path.join(os.homedir(), 'Downloads', 'Projects');
    const workspace = await mkdtemp(path.join(projects, '.cos-control-readonly-'));
    const schemaRoot = await mkdtemp(path.join(projects, '.cos-control-schema-'));
    const schema = path.join(schemaRoot, 'schema.json');
    await writeFile(schema, '{}');
    try {
      await expect(validateReadonlyRequest({ role: 'scout', cwd: workspace, model: 'gpt-5.6-sol', reasoningEffort: 'high', prompt: 'inspect', outputSchema: schema }))
        .resolves.toMatchObject({ role: 'scout', workspace, outputSchema: schema });
      await expect(validateReadonlyRequest({ role: 'worker', cwd: workspace, model: 'gpt-5.6-sol', reasoningEffort: 'high', prompt: 'inspect' }))
        .rejects.toThrow('invalid_role');
      await expect(validateReadonlyRequest({ role: 'reviewer', cwd: workspace, model: 'bad model', reasoningEffort: 'high', prompt: 'inspect' }))
        .rejects.toThrow('invalid_model');
      await expect(validateReadonlyRequest({ role: 'reviewer', cwd: workspace, model: 'gpt-5.6-sol', reasoningEffort: 'invalid', prompt: 'inspect' }))
        .rejects.toThrow('invalid_reasoning_effort');
      await expect(validateReadonlyRequest({ role: 'reviewer', cwd: os.tmpdir(), model: 'gpt-5.6-sol', reasoningEffort: 'high', prompt: 'inspect' }))
        .rejects.toThrow('workspace_outside_projects');
      await expect(validateReadonlyRequest({ role: 'reviewer', cwd: workspace, model: 'gpt-5.6-sol', reasoningEffort: 'high', prompt: 'inspect', outputSchema: path.join(workspace, 'missing.json') }))
        .rejects.toThrow('output_schema_invalid');
      await expect(validateReadonlyRequest({ role: 'reviewer', cwd: workspace, model: 'gpt-5.6-sol', reasoningEffort: 'high', prompt: 'inspect', executable: '/bin/sh' }))
        .rejects.toThrow('invalid_readonly_request');
    } finally {
      await (await import('node:fs/promises')).rm(workspace, { recursive: true, force: true });
      await (await import('node:fs/promises')).rm(schemaRoot, { recursive: true, force: true });
    }
  });
});

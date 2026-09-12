import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { initDurableStore } from '../src/main/durable.js';
import { cancellationReachedTerminal, deliveredTurnId, refreshControlTaskForTests, startControlService, stopControlService, taskCompletionEvidence, type ControlRefreshHooks, type Task } from '../src/main/control-service.js';
import type { SessionEvent } from '../src/shared/session.js';

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
  afterEach(() => stopControlService());

  it.runIf(process.platform === 'darwin')('serves health only on its protected Unix socket', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cos-control-'));
    initDurableStore(root);
    const socketPath = await startControlService(root);
    const response = await request(socketPath, 'GET', '/v1/health');
    expect(response).toEqual({ status: 200, body: {
      apiVersion: '1', ready: true, capabilities: ['submit', 'status', 'result', 'input', 'cancel']
    } });
    expect((await import('node:fs/promises')).stat(socketPath).then(stat => stat.mode & 0o777)).resolves.toBe(0o600);
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
      { kind: 'user_message', seq: 3, inputId: 'input-1', inputDelivery: 'confirmed' },
      { kind: 'assistant_message', seq: 12, turnId: 'provider-turn', final: true, state: 'final' }
    ] as SessionEvent[];
    expect(deliveredTurnId(events, 'input-1')).toEqual({ seq: 3, turnId: 'provider-turn' });
  });

  it('finishes cancellation after the bound turn reaches a terminal response', () => {
    expect(cancellationReachedTerminal(Date.now(), true)).toBe(true);
    expect(cancellationReachedTerminal(Date.now(), true, true)).toBe(false);
    expect(cancellationReachedTerminal(Date.now(), false)).toBe(false);
    expect(cancellationReachedTerminal(undefined, true)).toBe(false);
  });

  it('accepts only exact bound immediate task completion evidence', () => {
    const finish = (seq: number, turnId: string, taskId: string, status: string) => ({
      kind: 'tool_call', seq, turnId, call: { tool: 'session_finish', outcome: 'ok', args: { truncated: false, text: JSON.stringify({ task_id: taskId, status }) } }
    }) as SessionEvent;
    const events = [
      finish(3, 'turn-1', 'wrong-task', 'succeeded'),
      finish(4, 'wrong-turn', 'task-1', 'succeeded'),
      finish(5, 'turn-1', 'task-1', 'failed')
    ];
    expect(taskCompletionEvidence(events, 'task-1', 2, 'turn-1')).toEqual({ seq: 5, status: 'failed' });
    expect(taskCompletionEvidence(events, 'task-1', 5, 'turn-1')).toBeNull();
    expect(taskCompletionEvidence(events, 'task-1', 2, 'turn-1', 5)).toBeNull();
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

  it('binds completion to the exact delivered input and retains the lease until owned process cleanup', async () => {
    const events = [
      { kind: 'user_message', seq: 1, inputId: 'input-1', inputDelivery: 'confirmed', turnId: 'exact-turn' },
      { kind: 'tool_call', seq: 2, turnId: 'exact-turn', call: { tool: 'session_finish', outcome: 'ok', args: { truncated: false, text: JSON.stringify({ task_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'succeeded' }) } } },
      { kind: 'assistant_message', seq: 3, turnId: 'exact-turn', final: true, state: 'final', message: { text: 'done' } },
      { kind: 'turn_end', seq: 4, turnId: 'exact-turn', outcome: 'completed' }
    ] as SessionEvent[];
    await expect(refreshControlTaskForTests(task(), hooks(events, true))).resolves.toMatchObject({
      state: 'running', boundTurnId: 'exact-turn', currentTurnId: null, outcome: null
    });
    await expect(refreshControlTaskForTests(task(), hooks(events, false))).resolves.toMatchObject({
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

  it('rebinds followup work only from its new exact input evidence', async () => {
    const followup = task({ inputIds: ['input-1', 'input-2'], boundInputSeq: undefined, boundTurnId: undefined });
    const evidence = [
      { kind: 'user_message', seq: 1, inputId: 'input-1', inputDelivery: 'confirmed', turnId: 'stale-turn' },
      { kind: 'user_message', seq: 5, inputId: 'input-2', inputDelivery: 'confirmed', turnId: 'followup-turn' }
    ] as SessionEvent[];
    const fixture = hooks(evidence);
    fixture.listInputs = async () => [{ id: 'input-2', state: 'sent', deliveredSessionId: 'session-1' }] as any;
    await expect(refreshControlTaskForTests(followup, fixture)).resolves.toMatchObject({
      state: 'running', boundInputSeq: 5, boundTurnId: 'followup-turn', currentTurnId: 'followup-turn'
    });
  });
});

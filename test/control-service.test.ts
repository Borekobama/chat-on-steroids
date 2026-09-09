import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { initDurableStore } from '../src/main/durable.js';
import { deliveredTurnId, startControlService, stopControlService } from '../src/main/control-service.js';
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
});

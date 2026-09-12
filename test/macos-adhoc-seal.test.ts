import { beforeEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: ports.spawn }));
vi.mock('node:fs', () => ({ existsSync: ports.exists }));
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import seal from '../scripts/afterpack-macos-adhoc-seal.mjs';
const context = { electronPlatformName: 'darwin', appOutDir: '/package', packager: { appInfo: { productFilename: 'Chat On Steroids' } } };
beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  ports.exists.mockReturnValue(true);
  ports.spawn.mockImplementation((_command: string, args: string[]) => ({ status: 0, stdout: '',
    stderr: args.includes('--display') ? 'Identifier=com.chatonsteroids.app\nSignature=adhoc\nTeamIdentifier=not set\n' : '' }));
});
it.each(['win32', 'linux'])('does not run macOS signing on %s', async platform => {
  await seal({ ...context, electronPlatformName: platform });
  expect(ports.spawn).not.toHaveBeenCalled();
});
it('accepts successful signature details on stderr after strict verification', async () => {
  await expect(seal(context)).resolves.toBeUndefined();
  expect(ports.spawn.mock.calls.map(call => call[1].slice(0, 2))).toEqual([
    ['--force', '--deep'], ['--verify', '--deep'], ['--display', '--verbose=4']
  ]);
});
it('fails packaging when verification fails or signing has no resource envelope', async () => {
  ports.spawn.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
    .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'invalid resource seal' });
  await expect(seal(context)).rejects.toThrow('invalid resource seal');
  expect(ports.spawn).toHaveBeenCalledTimes(2);
  ports.exists.mockReturnValueOnce(true).mockReturnValueOnce(false);
  await expect(seal(context)).rejects.toThrow('no bundle CodeResources');
});
it('rejects a TeamIdentifier even if codesign reports adhoc', async () => {
  ports.spawn.mockImplementation((_command: string, args: string[]) => ({ status: 0, stdout: '',
    stderr: args.includes('--display') ? 'Signature=adhoc\nTeamIdentifier=TEAM123\n' : '' }));
  await expect(seal(context)).rejects.toThrow('trust-bearing');
});
it('uses an explicitly requested persistent local identity', async () => {
  vi.stubEnv('COS_MAC_SIGNING_IDENTITY', 'LOCAL-CERTIFICATE-HASH');
  ports.spawn.mockImplementation(() => ({ status: 0, stdout: '', stderr: 'Identifier=com.chatonsteroids.app\n' }));
  await expect(seal(context)).resolves.toBeUndefined();
  expect(ports.spawn.mock.calls[0]![1]).toEqual([
    '--force', '--deep', '--sign', 'LOCAL-CERTIFICATE-HASH', '/package/Chat On Steroids.app'
  ]);
});
it('uses an explicitly requested stable local designated requirement', async () => {
  vi.stubEnv('COS_MAC_DESIGNATED_REQUIREMENT', 'identifier "com.chatonsteroids.app"');
  await expect(seal(context)).resolves.toBeUndefined();
  expect(ports.spawn.mock.calls[1]![1]).toEqual([
    '--force', '--sign', '-', '-r=designated => identifier "com.chatonsteroids.app"',
    '/package/Chat On Steroids.app'
  ]);
});

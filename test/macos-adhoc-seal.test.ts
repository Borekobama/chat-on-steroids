import { beforeEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: ports.spawn }));
vi.mock('node:fs', () => ({ existsSync: ports.exists }));
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import seal from '../scripts/afterpack-macos-adhoc-seal.mjs';
const context = { electronPlatformName: 'darwin', appOutDir: '/package', packager: { appInfo: { productFilename: 'Chat On Steroids' } } };
const mediaKeys = [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSAudioCaptureUsageDescription'
];
let presentMediaKeys: Set<string>;

function successfulSpawn(command: string, args: string[]) {
  if (command === 'plutil') {
    if (args[0] === '-convert') return { status: 0,
      stdout: JSON.stringify(Object.fromEntries([...presentMediaKeys].map(key => [key, 'usage declaration']))), stderr: '' };
    const key = args[1] ?? '';
    if (args[0] === '-remove') {
      presentMediaKeys.delete(key);
      return { status: 0, stdout: '', stderr: '' };
    }
  }
  return { status: 0, stdout: '',
    stderr: args.includes('--display') ? 'Identifier=com.chatonsteroids.app\nSignature=adhoc\nTeamIdentifier=not set\n' : '' };
}

beforeEach(() => {
  vi.resetAllMocks();
<<<<<<< HEAD
  vi.unstubAllEnvs();
=======
  presentMediaKeys = new Set(mediaKeys);
>>>>>>> origin/main
  ports.exists.mockReturnValue(true);
  ports.spawn.mockImplementation(successfulSpawn);
});
it.each(['win32', 'linux'])('does not run macOS signing on %s', async platform => {
  await seal({ ...context, electronPlatformName: platform });
  expect(ports.spawn).not.toHaveBeenCalled();
});
it('removes Electron media privacy declarations before sealing the bundle', async () => {
  presentMediaKeys.add('NSScreenCaptureUsageDescription');
  await expect(seal(context)).resolves.toBeUndefined();
  expect(presentMediaKeys).toEqual(new Set(['NSScreenCaptureUsageDescription']));
  expect(ports.spawn.mock.calls.filter(call => call[0] === 'plutil' && call[1][0] === '-remove').map(call => call[1][1]))
    .toEqual(mediaKeys);
  const firstSignature = ports.spawn.mock.calls.findIndex(call => call[0] === 'codesign');
  expect(ports.spawn.mock.calls.slice(firstSignature).every(call => call[0] === 'codesign')).toBe(true);
});
it('accepts bundles with the unused declarations already absent', async () => {
  presentMediaKeys.clear();
  await expect(seal(context)).resolves.toBeUndefined();
  expect(ports.spawn.mock.calls.some(call => call[1][0] === '-remove')).toBe(false);
});
it.each(['read', 'remove', 'unchanged'])('refuses to seal when plist cleanup fails: %s', async failure => {
  ports.spawn.mockImplementation((command: string, args: string[]) => {
    if (command === 'plutil' && args[0] === (failure === 'read' ? '-convert' : '-remove')) {
      return failure === 'unchanged'
        ? { status: 0, stdout: '', stderr: '' }
        : { status: 1, stdout: '', stderr: 'plist operation failed' };
    }
    return successfulSpawn(command, args);
  });
  await expect(seal(context)).rejects.toThrow(failure === 'unchanged' ? 'failed to remove' : 'plist operation failed');
  expect(ports.spawn.mock.calls.some(call => call[0] === 'codesign')).toBe(false);
});
it('accepts successful signature details on stderr after strict verification', async () => {
  await expect(seal(context)).resolves.toBeUndefined();
  expect(ports.spawn.mock.calls.filter(call => call[0] === 'codesign').map(call => call[1].slice(0, 2))).toEqual([
    ['--force', '--deep'], ['--verify', '--deep'], ['--display', '--verbose=4']
  ]);
});
it('fails packaging when verification fails or signing has no resource envelope', async () => {
  ports.spawn.mockImplementation((command: string, args: string[]) => {
    const result = successfulSpawn(command, args);
    return command === 'codesign' && args.includes('--verify')
      ? { status: 1, stdout: '', stderr: 'invalid resource seal' }
      : result;
  });
  await expect(seal(context)).rejects.toThrow('invalid resource seal');
  expect(ports.spawn.mock.calls.filter(call => call[0] === 'codesign')).toHaveLength(2);

  vi.clearAllMocks();
  presentMediaKeys = new Set(mediaKeys);
  ports.exists.mockReturnValueOnce(true).mockReturnValueOnce(false);
  ports.spawn.mockImplementation(successfulSpawn);
  await expect(seal(context)).rejects.toThrow('no bundle CodeResources');
});
it('rejects a TeamIdentifier even if codesign reports adhoc', async () => {
  ports.spawn.mockImplementation((command: string, args: string[]) => {
    const result = successfulSpawn(command, args);
    return command === 'codesign' && args.includes('--display')
      ? { status: 0, stdout: '', stderr: 'Signature=adhoc\nTeamIdentifier=TEAM123\n' }
      : result;
  });
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

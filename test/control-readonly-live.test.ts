import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readonlySeatbeltProfile, readonlyCodexCommand, readonlyCodexEnvironment } from '../src/main/control-readonly.js';

it.skipIf(process.platform !== 'darwin' || process.env.COS_CODEX_LIVE !== '1')('starts the real Codex runtime inside the broker policy', async () => {
  const runtime = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cos-codex-live-')));
  try {
    const home = path.join(runtime, '.codex');
    await mkdir(home, { mode: 0o700 });
    const auth = path.join(os.homedir(), '.codex', 'auth.json');
    await symlink(auth, path.join(home, 'auth.json'));
    const command = readonlyCodexCommand('/Applications/ChatGPT.app/Contents/Resources/codex', process.cwd(), runtime, 'gpt-5.6-luna', 'low', null, auth);
    const child = spawnSync(command[0]!, command.slice(1), { input: 'Reply exactly BROKER_OK. Do not use tools.', encoding: 'utf8', timeout: 60000, env: readonlyCodexEnvironment(runtime, home) });
    const diagnostics = child.stderr.split('\n').filter(line => /denied|not permitted|sandbox|failed|Error|error|panicked/i.test(line)).map(line => line.replace(/(?:sk-|eyJ)[A-Za-z0-9._-]+/g, '[redacted]')).join('\n');
    expect(child.status, diagnostics).toBe(0);
  } finally { await rm(runtime, { recursive: true, force: true }); }
}, 65000);

it.skipIf(process.platform !== 'darwin' || process.env.COS_READONLY_LIVE !== '1')('enforces the broker policy in the macOS kernel', async () => {
  const runtime = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cos-policy-live-')));
  const workspace = await mkdtemp(path.join(process.cwd(), '.cos-policy-live-'));
  const outside = await mkdtemp(path.join(os.homedir(), '.cos-policy-live-'));
  try {
    await writeFile(path.join(workspace, 'source'), 'source');
    await writeFile(path.join(outside, 'private'), 'private');
    await mkdir(path.join(runtime, 'state'));
    const auth = path.join(os.homedir(), '.codex', 'auth.json');
    const profile = readonlySeatbeltProfile(runtime, workspace, '/usr/bin/perl', auth);
    const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/perl', '-e', `
      use strict;
      open(my $source, '<', $ARGV[0]) or die 'source read denied'; close($source);
      open(my $auth, '<', $ARGV[1]) or die 'auth read denied'; close($auth);
      open(my $state, '>', $ARGV[2]) or die 'runtime write denied'; close($state);
      open(my $create, '>', $ARGV[3]) and die 'source create allowed';
      open(my $modify, '>>', $ARGV[0]) and die 'source modify allowed';
      unlink($ARGV[0]) and die 'source delete allowed';
      open(my $private, '<', $ARGV[4]) and die 'private read allowed';
      open(my $secret, '>>', $ARGV[1]) and die 'auth write allowed';
      open(my $installed, '>', $ARGV[5]) and die 'installed write allowed';
      print 'policy verified';
    `, path.join(workspace, 'source'), auth, path.join(runtime, 'state', 'created'),
    path.join(workspace, 'created'), path.join(outside, 'private'),
    path.join('/Applications', path.basename(runtime))], { encoding: 'utf8', timeout: 10000 });
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout).toBe('policy verified');
  } finally {
    await Promise.all([runtime, workspace, outside].map(directory => rm(directory, { recursive: true, force: true })));
  }
});

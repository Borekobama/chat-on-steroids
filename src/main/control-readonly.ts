import { promises as fs } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from './config.js';
import { terminateProcessTree } from './exec.js';
import { isReasoningEffort } from '../shared/session.js';

export const READONLY_MAX_BODY = 256 * 1024;
export const READONLY_MAX_PROMPT = 96_000;
export const READONLY_MAX_OUTPUT = 1_048_576;
export const READONLY_MAX_SCHEMA = 64 * 1024;
export const READONLY_TIMEOUT_MS = 15 * 60_000;
export const READONLY_MAX_EVENTS = 64;
export const READONLY_MAX_EVENT_BYTES = 32 * 1024;
export const READONLY_MAX_IN_FLIGHT = 2;
export const READONLY_ROLES = ['scout', 'reviewer'] as const;
export type ReadonlyRole = (typeof READONLY_ROLES)[number];

export type ReadonlyRequest = {
  role: ReadonlyRole;
  cwd: string;
  model: string;
  reasoningEffort: string;
  prompt: string;
  outputSchema?: string | null;
  timeoutMs?: number;
};

export type ReadonlyResult = {
  role: ReadonlyRole;
  output: string;
  usage: Record<string, number>;
  events: Array<Record<string, unknown>>;
};

type ValidatedReadonlyRequest = ReadonlyRequest & {
  workspace: string;
  outputSchema: string | null;
};

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const MAX_REASONING = 32;
const REQUEST_KEYS = new Set(['role', 'cwd', 'model', 'reasoningEffort', 'prompt', 'outputSchema', 'timeoutMs']);
const USAGE_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'] as const;

function within(parent: string, child: string): boolean {
  const base = path.resolve(parent) + path.sep;
  return child === path.resolve(parent) || child.startsWith(base);
}

function quoteProfilePath(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replace(/[\r\n]/g, ' ');
}

function profilePath(pathname: string, kind: 'literal' | 'subpath'): string {
  return `(${kind} "${quoteProfilePath(pathname)}")`;
}

function ancestors(pathname: string): string[] {
  const values: string[] = [];
  let current = path.resolve(pathname);
  for (;;) {
    values.push(current);
    const parent = path.dirname(current);
    if (parent === current) return values;
    current = parent;
  }
}

function applicationRoot(executable: string): string | null {
  let current = path.resolve(executable);
  for (;;) {
    if (path.basename(current).endsWith('.app')) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const SYSTEM_READ_SUBPATHS = [
  '/System/Library',
  '/Library/Apple/System/Library',
  '/usr/lib',
  '/usr/bin',
  '/usr/share/zoneinfo',
  '/private/etc/ssl',
  '/etc/ssl'
];
const SYSTEM_READ_LITERALS = [
  '/private/etc/hosts',
  '/private/etc/resolv.conf',
  '/etc/hosts',
  '/etc/resolv.conf'
];

function profileRule(operation: string, subpaths: readonly string[], literals: readonly string[] = []): string {
  const entries = [
    ...new Set(subpaths.map(value => profilePath(value, 'subpath'))),
    ...new Set(literals.map(value => profilePath(value, 'literal')))
  ];
  return `(allow ${operation} ${entries.join(' ')})`;
}

/** One native seatbelt for the broker and its complete Codex child process. */
export function readonlySeatbeltProfile(
  runtimeDir: string,
  workspace = runtimeDir,
  executable = runtimeDir,
  authPath: string | null = null,
  outputSchema: string | null = null
): string {
  if (![runtimeDir, workspace, executable].every(pathname => path.isAbsolute(pathname)) ||
      (authPath !== null && !path.isAbsolute(authPath)) || (outputSchema !== null && !path.isAbsolute(outputSchema))) {
    throw bad('runtime_directory_invalid');
  }
  const shipped = applicationRoot(executable) ?? executable;
  const readSubpaths = [...new Set([
    path.resolve(runtimeDir),
    path.resolve(workspace),
    path.resolve(shipped),
    ...SYSTEM_READ_SUBPATHS
  ])];
  const readLiterals = [
    ...SYSTEM_READ_LITERALS,
    ...(authPath === null ? [] : [path.resolve(authPath)]),
    ...(outputSchema === null ? [] : [path.resolve(outputSchema)])
  ];
  const metadataLiterals = [...new Set([
    ...readSubpaths.flatMap(ancestors),
    ...readLiterals.flatMap(ancestors)
  ])];
  const executableSubpaths = [...new Set([
    path.resolve(shipped),
    '/System/Library',
    '/Library/Apple/System/Library',
    '/usr/lib',
    '/usr/bin'
  ])];
  return [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    profileRule('file-read-data', readSubpaths, readLiterals),
    profileRule('file-read-metadata', readSubpaths, metadataLiterals),
    profileRule('file-map-executable', executableSubpaths),
    `(deny file-write* (subpath "${quoteProfilePath(path.resolve(workspace))}"))`,
    ...(authPath === null ? [] : [`(deny file-write* (literal "${quoteProfilePath(path.resolve(authPath))}"))`]),
    profileRule('file-write*', [path.resolve(runtimeDir)]),
    '(allow network-outbound)'
  ].join('\n');
}

export function readonlyCodexCommand(
  executable: string,
  workspace: string,
  runtimeDir: string,
  model: string,
  reasoningEffort: string,
  outputSchema: string | null,
  authPath: string | null = null
): string[] {
  const output = path.join(runtimeDir, 'output.json');
  const command = [
    '/usr/bin/sandbox-exec', '-p', readonlySeatbeltProfile(runtimeDir, workspace, executable, authPath, outputSchema), executable, 'exec',
    '--ephemeral', '--ignore-user-config', '--ignore-rules', '--disable', 'multi_agent',
    '--json', '--color', 'never', '--sandbox', 'danger-full-access', '--model', model,
    '--config', `model_reasoning_effort="${reasoningEffort}"`, '--cd', workspace,
    '--output-last-message', output
  ];
  if (outputSchema) command.push('--output-schema', outputSchema);
  command.push('-');
  return command;
}

/** Environment state is private to one run; none of the caller's home state is inherited. */
export function readonlyCodexEnvironment(
  runtimeDir: string,
  codeHome: string,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (!path.isAbsolute(runtimeDir) || !path.isAbsolute(codeHome) || !within(runtimeDir, codeHome)) {
    throw bad('runtime_directory_invalid');
  }
  // The app can itself carry connector/tunnel/plugin credentials. A read-only child needs
  // process basics and certificate/locale hints, not the app's ambient secret namespace.
  const passthrough = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (passthrough.has(key) || key.startsWith('LC_'))) environment[key] = value;
  }
  // The Codex transport on this host needs the system CA bundle explicitly. Keep verification
  // enabled and point only at the fixed system path already admitted by the seatbelt profile.
  environment.SSL_CERT_FILE = '/etc/ssl/cert.pem';
  environment.HOME = runtimeDir;
  environment.CODEX_HOME = codeHome;
  environment.XDG_CONFIG_HOME = codeHome;
  environment.XDG_CACHE_HOME = path.join(runtimeDir, 'cache');
  environment.XDG_DATA_HOME = path.join(runtimeDir, 'data');
  environment.TMPDIR = runtimeDir;
  environment.TMP = runtimeDir;
  environment.TEMP = runtimeDir;
  return environment;
}

function bad(message: string): Error {
  return new Error(message);
}

let readonlyInFlight = 0;

async function canonicalProjectsRoot(): Promise<string> {
  const root = path.join(os.homedir(), 'Downloads', 'Projects');
  return fs.realpath(root).catch(() => { throw bad('projects_ceiling_unavailable'); });
}

async function regularCanonicalFile(value: string, projects: string): Promise<string> {
  if (!path.isAbsolute(value) || value.length > 1024) throw bad('output_schema_invalid');
  const stat = await fs.lstat(value).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > READONLY_MAX_SCHEMA) throw bad('output_schema_invalid');
  const real = await fs.realpath(value).catch(() => '');
  if (!real || !within(projects, real) || path.extname(real).toLowerCase() !== '.json') throw bad('output_schema_invalid');
  try { JSON.parse(await fs.readFile(real, 'utf8')); } catch { throw bad('output_schema_invalid'); }
  return real;
}

export async function validateReadonlyRequest(input: unknown): Promise<ValidatedReadonlyRequest> {
  if (!input || typeof input !== 'object') throw bad('invalid_readonly_request');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !REQUEST_KEYS.has(key))) throw bad('invalid_readonly_request');
  const role = value.role;
  const cwd = value.cwd;
  const reasoningEffort = value.reasoningEffort;
  const outputSchema = value.outputSchema ?? null;
  const timeoutMs = value.timeoutMs ?? READONLY_TIMEOUT_MS;
  if (role !== 'scout' && role !== 'reviewer') throw bad('invalid_role');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.length > 1024) throw bad('invalid_workspace');
  if (typeof value.model !== 'string' || !MODEL.test(value.model)) throw bad('invalid_model');
  if (typeof reasoningEffort !== 'string' || reasoningEffort.length > MAX_REASONING || !isReasoningEffort(reasoningEffort)) {
    throw bad('invalid_reasoning_effort');
  }
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > READONLY_MAX_PROMPT) throw bad('invalid_prompt');
  if (outputSchema !== null && typeof outputSchema !== 'string') throw bad('output_schema_invalid');
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > READONLY_TIMEOUT_MS) {
    throw bad('invalid_timeout');
  }
  const projects = await canonicalProjectsRoot();
  const workspace = await fs.realpath(cwd).catch(() => '');
  if (!workspace) throw bad('workspace_unavailable');
  const workspaceStat = await fs.stat(workspace);
  if (!workspaceStat.isDirectory() || !within(projects, workspace)) throw bad('workspace_outside_projects');
  const schema = outputSchema === null ? null : await regularCanonicalFile(outputSchema, projects);
  return { role, cwd, model: value.model, reasoningEffort, prompt: value.prompt,
    workspace, outputSchema: schema, timeoutMs } as ValidatedReadonlyRequest;
}

async function trustedExecutable(): Promise<string> {
  const configured = getConfig().commandSandbox.codexPath;
  if (!path.isAbsolute(configured) || configured.length > 4096) throw bad('codex_executable_unavailable');
  const stat = await fs.stat(configured).catch(() => null);
  if (!stat?.isFile() || (stat.mode & 0o111) === 0) throw bad('codex_executable_unavailable');
  return await fs.realpath(configured);
}

async function trustedAuthPath(): Promise<string> {
  const home = await fs.realpath(os.homedir()).catch(() => '');
  if (!home) throw bad('codex_auth_unavailable');
  const authPath = path.join(home, '.codex', 'auth.json');
  const stat = await fs.lstat(authPath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw bad('codex_auth_unavailable');
  const real = await fs.realpath(authPath).catch(() => '');
  if (real !== authPath) throw bad('codex_auth_unavailable');
  return authPath;
}

function boundedEvents(stdout: string): { events: Array<Record<string, unknown>>; usage: Record<string, number> } {
  const events: Array<Record<string, unknown>> = [];
  let usage: Record<string, number> = {};
  for (const line of stdout.split('\n')) {
    if (line.length > READONLY_MAX_EVENT_BYTES || events.length >= READONLY_MAX_EVENTS) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    if (event.type !== 'turn.completed') continue;
    const candidate = event.usage ?? (event.turn && typeof event.turn === 'object' ? (event.turn as Record<string, unknown>).usage : null);
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      usage = Object.fromEntries(USAGE_KEYS.flatMap(key => {
        const number = (candidate as Record<string, unknown>)[key];
        return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? [[key, number]] : [];
      }));
    }
    events.push({ type: 'turn.completed', ...(Object.keys(usage).length ? { usage } : {}) });
  }
  return { events, usage };
}

function collect(child: ChildProcess, max: number): Promise<{ stdout: string }> {
  let stdout = ''; let size = 0;
  child.stdout?.on('data', chunk => {
    if (size >= max) return;
    const bytes = Buffer.from(chunk);
    const remaining = max - size;
    const text = bytes.subarray(0, remaining).toString('utf8');
    stdout += text;
    size += Buffer.byteLength(text);
  });
  // Drain stderr without retaining it: diagnostics must not become a credential exfiltration
  // channel if a provider-side failure happens to echo auth material.
  child.stderr?.on('data', () => undefined);
  return new Promise((resolve, reject) => child.once('error', reject).once('close', () => resolve({ stdout })));
}

export async function runReadonlyCodex(input: unknown): Promise<ReadonlyResult> {
  if (process.platform !== 'darwin') throw bad('readonly_codex_unavailable');
  if (readonlyInFlight >= READONLY_MAX_IN_FLIGHT) throw bad('codex_readonly_busy');
  readonlyInFlight += 1;
  try {
    const request = await validateReadonlyRequest(input);
    const executable = await trustedExecutable();
    const authPath = await trustedAuthPath();
    const runtimeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cos-readonly-')));
    const codeHome = path.join(runtimeDir, '.codex');
    let child: ChildProcess | null = null;
    try {
      await fs.chmod(runtimeDir, 0o700);
      await fs.mkdir(codeHome, { mode: 0o700 });
      await fs.chmod(codeHome, 0o700);
      await fs.symlink(authPath, path.join(codeHome, 'auth.json'), 'file');
      const command = readonlyCodexCommand(executable, request.workspace, runtimeDir, request.model, request.reasoningEffort, request.outputSchema, authPath);
      const environment = readonlyCodexEnvironment(runtimeDir, codeHome);
      child = spawn(command[0]!, command.slice(1), {
        cwd: request.workspace,
        env: environment,
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      child.stdin?.end(request.prompt, 'utf8');
      let timedOut = false;
      let timeoutCleanup: Promise<void> | null = null;
      const timeout = setTimeout(() => {
        timedOut = true;
        timeoutCleanup = child?.pid ? terminateProcessTree(child.pid) : Promise.resolve();
      }, request.timeoutMs);
      timeout.unref?.();
      let captured: { stdout: string };
      const childPid = child.pid;
      try {
        captured = await collect(child, READONLY_MAX_OUTPUT);
        if (timeoutCleanup) await timeoutCleanup;
      } finally {
        clearTimeout(timeout);
        // detached:true makes pid the process-group id. Kill the group even when the leader
        // already exited so a surviving descendant cannot race output validation or outlive cleanup.
        if (childPid) await terminateProcessTree(childPid);
      }
      if (timedOut) throw bad('codex_readonly_timeout');
      if (child.exitCode !== 0) throw bad('codex_readonly_failed');
      const outputPath = path.join(runtimeDir, 'output.json');
      const outputStat = await fs.lstat(outputPath).catch(() => null);
      if (!outputStat?.isFile() || outputStat.isSymbolicLink() || outputStat.size <= 0 || outputStat.size > READONLY_MAX_OUTPUT) {
        throw bad('codex_readonly_missing_output');
      }
      const output = await fs.readFile(outputPath, 'utf8').catch(() => '');
      if (!output || Buffer.byteLength(output) > READONLY_MAX_OUTPUT) throw bad('codex_readonly_missing_output');
      const parsed = boundedEvents(captured.stdout);
      return { role: request.role, output, usage: parsed.usage, events: parsed.events };
    } finally {
      await fs.rm(runtimeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    readonlyInFlight -= 1;
  }
}

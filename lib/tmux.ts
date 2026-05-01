import { run } from './git';

export async function tmuxAvailable(): Promise<boolean> {
  const { exitCode } = await run(['tmux', '-V']);
  return exitCode === 0;
}

async function hasSession(session: string): Promise<boolean> {
  const { exitCode } = await run(['tmux', 'has-session', '-t', session]);
  return exitCode === 0;
}

/**
 * Build `-e KEY=VAL` flags for every env var in process.env so the tmux
 * window inherits the harness's environment instead of whatever the tmux
 * server happened to be started with. Without this, Claude inside tmux
 * can't see the user's `ANTHROPIC_*` / `CLAUDE_CODE_OAUTH_TOKEN` and
 * exits with "Not logged in".
 */
function envFlags(): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    // tmux rejects keys with `=` in them and values containing NUL bytes.
    if (key.length === 0 || key.includes('=') || value.includes('\0')) continue;
    out.push('-e', `${key}=${value}`);
  }
  return out;
}

export async function ensureSession(session: string): Promise<void> {
  if (await hasSession(session)) {
    // Existing tmux server may have a stale env; push the current process env
    // onto the session so subsequent windows inherit auth tokens etc.
    await pushEnvToSession(session);
    return;
  }
  // Create a detached session with a placeholder window. The placeholder is
  // immediately renamed and other windows replace it as runs start.
  const { exitCode, stderr } = await run([
    'tmux',
    'new-session',
    '-d',
    ...envFlags(),
    '-s',
    session,
    '-n',
    '_idle',
    'sh',
    '-c',
    'echo "harness tmux session — windows appear as Claude runs spawn"; tail -f /dev/null',
  ]);
  if (exitCode !== 0) {
    throw new Error(`tmux new-session failed: ${stderr.trim()}`);
  }
}

async function pushEnvToSession(session: string): Promise<void> {
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (key.length === 0 || key.includes('=') || value.includes('\0')) continue;
    await run(['tmux', 'set-environment', '-t', session, key, value]);
  }
}

async function killWindow(session: string, window: string): Promise<void> {
  await run(['tmux', 'kill-window', '-t', `${session}:${window}`]);
}

/**
 * Open (or replace) a window in the harness tmux session that runs `command`
 * via `sh -c`. Safe to call when the session already has a window of the same
 * name — the existing one is killed first.
 */
export async function openWindow(args: {
  session: string;
  window: string;
  command: string;
}): Promise<void> {
  await killWindow(args.session, args.window);
  const { exitCode, stderr } = await run([
    'tmux',
    'new-window',
    '-d',
    ...envFlags(),
    '-t',
    args.session,
    '-n',
    args.window,
    'sh',
    '-c',
    // Keep the window open after the viewer exits so the user can scroll.
    `${args.command}; printf '\\n[viewer exited — press any key to close]'; read _`,
  ]);
  if (exitCode !== 0) {
    throw new Error(`tmux new-window failed: ${stderr.trim()}`);
  }
}

export function sanitizeWindowName(s: string): string {
  // tmux window names cannot contain '.' or ':'. Keep it short and printable.
  return s.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40);
}

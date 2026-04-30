import { run } from './git';

export async function tmuxAvailable(): Promise<boolean> {
  const { exitCode } = await run(['tmux', '-V']);
  return exitCode === 0;
}

async function hasSession(session: string): Promise<boolean> {
  const { exitCode } = await run(['tmux', 'has-session', '-t', session]);
  return exitCode === 0;
}

export async function ensureSession(session: string): Promise<void> {
  if (await hasSession(session)) return;
  // Create a detached session with a placeholder window. The placeholder is
  // immediately renamed and other windows replace it as runs start.
  const { exitCode, stderr } = await run([
    'tmux',
    'new-session',
    '-d',
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

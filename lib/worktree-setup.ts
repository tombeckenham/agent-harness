import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { run } from './git';
import type { Logger } from './log';

/**
 * Stable per-issue worktree path matching the dotfiles `ghwt` workflow:
 * `~/.claude/worktrees/{repoName}-{issue}`. Using a deterministic location
 * means a leftover worktree from a prior harness run is reused (not blocked
 * with "already used by worktree" errors), and the user can find it the
 * same way they find ghwt-managed ones.
 */
export function worktreePathForIssue(repoRoot: string, issue: number): string {
  const repoName = basename(repoRoot);
  return join(homedir(), '.claude', 'worktrees', `${repoName}-${String(issue)}`);
}

/**
 * Mirror of dotfiles `_worktree_setup`. Run after a fresh worktree creation
 * so the worktree has whatever local state Claude needs (env files, db,
 * installed deps) and doesn't drift back to the parent checkout for them.
 */
export async function setupWorktree(args: {
  worktreePath: string;
  repoRoot: string;
  log: Logger;
}): Promise<void> {
  const { worktreePath, repoRoot, log } = args;
  const cursorConfig = join(repoRoot, '.cursor', 'worktrees.json');
  if (existsSync(cursorConfig)) {
    await runCursorSetup({ cursorConfig, worktreePath, repoRoot, log });
    return;
  }
  await runDefaultSetup({ worktreePath, repoRoot, log });
}

async function runCursorSetup(args: {
  cursorConfig: string;
  worktreePath: string;
  repoRoot: string;
  log: Logger;
}): Promise<void> {
  const { cursorConfig, worktreePath, repoRoot, log } = args;
  let commands: string[];
  try {
    const parsed = JSON.parse(readFileSync(cursorConfig, 'utf8')) as unknown;
    commands = extractSetupCommands(parsed);
  } catch (err) {
    log.warn('worktree.setup.cursor-parse-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (commands.length === 0) return;
  log.info('worktree.setup.cursor', { count: commands.length });
  for (const cmd of commands) {
    const expanded = cmd.replaceAll('$ROOT_WORKTREE_PATH', repoRoot);
    log.info('worktree.setup.run', { cmd: expanded });
    const { exitCode, stderr } = await run(['bash', '-c', expanded], {
      cwd: worktreePath,
    });
    if (exitCode !== 0) {
      log.warn('worktree.setup.cmd-failed', { cmd: expanded, exitCode, stderr: stderr.slice(0, 500) });
    }
  }
}

function extractSetupCommands(parsed: unknown): string[] {
  if (typeof parsed !== 'object' || parsed === null) return [];
  const arr = (parsed as { 'setup-worktree'?: unknown })['setup-worktree'];
  if (!Array.isArray(arr)) return [];
  return arr.filter((c): c is string => typeof c === 'string');
}

async function runDefaultSetup(args: {
  worktreePath: string;
  repoRoot: string;
  log: Logger;
}): Promise<void> {
  const { worktreePath, repoRoot, log } = args;
  // Copy local.db if present. SQLite dev DBs are gitignored but Claude needs
  // them to run repo scripts that touch the db.
  const localDb = join(repoRoot, 'local.db');
  if (existsSync(localDb)) {
    await copyFile(localDb, join(worktreePath, 'local.db'));
    log.info('worktree.setup.copied', { file: 'local.db' });
  }

  // Copy every .env.local under the repo, preserving relative paths.
  const envFiles = await findEnvLocalFiles(repoRoot);
  for (const src of envFiles) {
    const rel = relative(repoRoot, src);
    const dest = join(worktreePath, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }
  if (envFiles.length > 0) {
    log.info('worktree.setup.env-files', { count: envFiles.length });
  }

  // Detect package manager by lockfile and install deps inside the worktree.
  const pm = detectPackageManager(worktreePath);
  if (pm) {
    log.info('worktree.setup.install', { pm });
    const { exitCode, stderr } = await run([pm, 'install'], { cwd: worktreePath });
    if (exitCode !== 0) {
      log.warn('worktree.setup.install-failed', { pm, exitCode, stderr: stderr.slice(0, 500) });
    }
  }
}

const PRUNED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.turbo',
]);

async function findEnvLocalFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (PRUNED_DIRS.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile() && entry.name === '.env.local') {
        out.push(full);
      } else if (entry.isSymbolicLink()) {
        // Follow only file symlinks to .env.local; avoid loops.
        try {
          const s = await stat(full);
          if (s.isFile() && entry.name === '.env.local') out.push(full);
        } catch {
          // dangling symlink — skip
        }
      }
    }
  };
  await walk(root);
  return out;
}

function detectPackageManager(worktreePath: string): 'bun' | 'pnpm' | 'npm' | null {
  if (!existsSync(join(worktreePath, 'package.json'))) return null;
  if (
    existsSync(join(worktreePath, 'bun.lock')) ||
    existsSync(join(worktreePath, 'bun.lockb'))
  ) {
    return 'bun';
  }
  if (existsSync(join(worktreePath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(worktreePath, 'package-lock.json'))) return 'npm';
  return null;
}


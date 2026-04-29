import { z } from 'zod';
import type { Logger } from './log';

type RunOpts = { cwd?: string; signal?: AbortSignal };
type RunResult = { stdout: string; stderr: string; exitCode: number };

export async function run(
  cmd: string[],
  opts: RunOpts = {}
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    signal: opts.signal,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

export async function runOk(
  cmd: string[],
  opts: RunOpts = {}
): Promise<string> {
  const { stdout, stderr, exitCode } = await run(cmd, opts);
  if (exitCode !== 0) {
    throw new Error(
      `Command failed (exit ${exitCode}): ${cmd.join(' ')}\n${stderr || stdout}`
    );
  }
  return stdout.trim();
}

export type Repo = { owner: string; name: string };

export async function detectRepo(cwd: string): Promise<Repo> {
  const url = await runOk(['git', 'remote', 'get-url', 'origin'], { cwd });
  // Match git@github.com:owner/name.git or https://github.com/owner/name(.git)
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  const owner = m?.[1];
  const name = m?.[2];
  if (owner === undefined || name === undefined) {
    throw new Error(`Cannot parse GitHub repo from origin: ${url}`);
  }
  return { owner, name };
}

export async function gitStatusClean(cwd: string): Promise<boolean> {
  const out = await runOk(['git', 'status', '--porcelain'], { cwd });
  return out.length === 0;
}

export async function fetchAll(cwd: string): Promise<void> {
  await runOk(['git', 'fetch', '--all', '--prune'], { cwd });
}

export async function currentBranch(cwd: string): Promise<string> {
  return runOk(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
}

export async function revParse(ref: string, cwd: string): Promise<string> {
  return runOk(['git', 'rev-parse', ref], { cwd });
}

export async function branchExistsRemote(
  branch: string,
  cwd: string
): Promise<boolean> {
  const { exitCode } = await run(
    ['git', 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
    { cwd }
  );
  return exitCode === 0;
}

export async function addWorktree(
  worktreePath: string,
  branch: string,
  baseRef: string,
  cwd: string
): Promise<void> {
  // Create new branch from baseRef in a fresh worktree.
  await runOk(['git', 'worktree', 'add', '-b', branch, worktreePath, baseRef], {
    cwd,
  });
}

export async function adoptWorktree(
  worktreePath: string,
  branch: string,
  cwd: string
): Promise<void> {
  // Branch already exists; just attach a worktree.
  await runOk(['git', 'worktree', 'add', worktreePath, branch], { cwd });
}

export async function removeWorktree(
  worktreePath: string,
  cwd: string
): Promise<void> {
  await run(['git', 'worktree', 'remove', '--force', worktreePath], { cwd });
}

export async function commitsSince(
  baseRef: string,
  cwd: string
): Promise<number> {
  const out = await runOk(['git', 'rev-list', '--count', `${baseRef}..HEAD`], {
    cwd,
  });
  return Number.parseInt(out, 10);
}

export async function pushBranch(branch: string, cwd: string): Promise<void> {
  await runOk(['git', 'push', '-u', 'origin', branch], { cwd });
}

export type RemoteSyncStatus = 'in-sync' | 'ahead' | 'behind' | 'diverged';

export async function remoteSyncStatus(
  branch: string,
  cwd: string
): Promise<RemoteSyncStatus> {
  await runOk(['git', 'fetch', 'origin', branch], { cwd });
  const local = await runOk(['git', 'rev-parse', 'HEAD'], { cwd });
  const remote = await runOk(['git', 'rev-parse', `origin/${branch}`], { cwd });
  if (local === remote) return 'in-sync';
  const { stdout: ahead } = await run(
    ['git', 'rev-list', '--count', `origin/${branch}..HEAD`],
    { cwd }
  );
  const { stdout: behind } = await run(
    ['git', 'rev-list', '--count', `HEAD..origin/${branch}`],
    { cwd }
  );
  const a = Number.parseInt(ahead.trim(), 10) || 0;
  const b = Number.parseInt(behind.trim(), 10) || 0;
  if (a > 0 && b === 0) return 'ahead';
  if (a === 0 && b > 0) return 'behind';
  return 'diverged';
}

export async function runLefthookPreCommit(cwd: string): Promise<RunResult> {
  return run(['bun', 'lefthook', 'run', 'pre-commit'], { cwd });
}

export async function ghAuthOk(): Promise<boolean> {
  const { exitCode } = await run(['gh', 'auth', 'status']);
  return exitCode === 0;
}

const issueViewSchema = z.object({
  title: z.string(),
  body: z.string().nullish(),
  state: z.string(),
  labels: z.array(z.object({ name: z.string() })),
});

export async function ghIssueView(
  issue: number,
  repo: Repo
): Promise<{ title: string; body: string; state: string; labels: string[] }> {
  const json = await runOk([
    'gh',
    'issue',
    'view',
    String(issue),
    '--repo',
    `${repo.owner}/${repo.name}`,
    '--json',
    'title,body,state,labels',
  ]);
  const data = issueViewSchema.parse(JSON.parse(json));
  return {
    title: data.title,
    body: data.body ?? '',
    state: data.state,
    labels: data.labels.map((l) => l.name),
  };
}

export async function ghPrCreate(args: {
  cwd: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft?: boolean;
}): Promise<number> {
  const cmd = [
    'gh',
    'pr',
    'create',
    '--base',
    args.base,
    '--head',
    args.head,
    '--title',
    args.title,
    '--body',
    args.body,
  ];
  if (args.draft) cmd.push('--draft');
  const url = await runOk(cmd, { cwd: args.cwd });
  const m = url.match(/\/pull\/(\d+)/);
  const num = m?.[1];
  if (num === undefined) {
    throw new Error(`Could not parse PR number from: ${url}`);
  }
  return Number.parseInt(num, 10);
}

export async function ghPrFindForBranch(
  branch: string,
  repo: Repo
): Promise<number | null> {
  const json = await runOk([
    'gh',
    'pr',
    'list',
    '--repo',
    `${repo.owner}/${repo.name}`,
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number',
  ]);
  const arr = z.array(z.object({ number: z.number() })).parse(JSON.parse(json));
  return arr[0]?.number ?? null;
}

export type CiCheck = {
  name: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | skipped | null
};

export async function ghPrChecks(pr: number, repo: Repo): Promise<CiCheck[]> {
  const { stdout, exitCode } = await run([
    'gh',
    'pr',
    'checks',
    String(pr),
    '--repo',
    `${repo.owner}/${repo.name}`,
    '--json',
    'name,status,conclusion',
  ]);
  // gh exits 8 when checks are pending or have failed; output is still JSON.
  if (exitCode !== 0 && exitCode !== 8) {
    throw new Error(`gh pr checks failed (exit ${exitCode})`);
  }
  return ciCheckArraySchema.parse(JSON.parse(stdout || '[]'));
}

const ciCheckArraySchema = z.array(
  z.object({
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
  })
);

export async function ghPrComments(
  pr: number,
  repo: Repo
): Promise<{
  reviews: Array<{
    author: string;
    state: string;
    body: string;
    submittedAt: string;
  }>;
  comments: Array<{ author: string; body: string; createdAt: string }>;
}> {
  const json = await runOk([
    'gh',
    'pr',
    'view',
    String(pr),
    '--repo',
    `${repo.owner}/${repo.name}`,
    '--json',
    'reviews,comments',
  ]);
  const data = prCommentsSchema.parse(JSON.parse(json));
  return {
    reviews: data.reviews.map((r) => ({
      author: r.author.login,
      state: r.state,
      body: r.body,
      submittedAt: r.submittedAt,
    })),
    comments: data.comments.map((c) => ({
      author: c.author.login,
      body: c.body,
      createdAt: c.createdAt,
    })),
  };
}

const prCommentsSchema = z.object({
  reviews: z.array(
    z.object({
      author: z.object({ login: z.string() }),
      state: z.string(),
      body: z.string(),
      submittedAt: z.string(),
    })
  ),
  comments: z.array(
    z.object({
      author: z.object({ login: z.string() }),
      body: z.string(),
      createdAt: z.string(),
    })
  ),
});

export async function ghPrAddLabel(
  pr: number,
  label: string,
  repo: Repo
): Promise<void> {
  await run([
    'gh',
    'pr',
    'edit',
    String(pr),
    '--repo',
    `${repo.owner}/${repo.name}`,
    '--add-label',
    label,
  ]);
}

export async function ensureSafeAbort(cwd: string, log: Logger): Promise<void> {
  // Recovery: if a previous run died mid-commit, drop the partial state.
  const status = await runOk(['git', 'status', '--porcelain'], { cwd });
  if (status.length > 0) {
    log.warn('Worktree dirty on resume; resetting hard', { cwd });
    await runOk(['git', 'reset', '--hard', 'HEAD'], { cwd });
    await runOk(['git', 'clean', '-fd'], { cwd });
  }
}

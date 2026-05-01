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

const TRANSIENT_GH_PATTERNS: readonly RegExp[] = [
  /connection (?:refused|reset)/i,
  /i\/o timeout/i,
  /timeout (?:awaiting|exceeded)/i,
  /EOF/,
  /HTTP 5\d\d/i,
  /network is unreachable/i,
  /temporary failure/i,
  /unexpected EOF/i,
  /context deadline exceeded/i,
];

export function isTransientGhError(stderr: string): boolean {
  return TRANSIENT_GH_PATTERNS.some((re) => re.test(stderr));
}

export type RetryOpts = {
  maxAttempts?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
};

/**
 * Runs a `gh` command, retrying on transient network/server errors.
 * Use only for idempotent reads — never for mutations.
 */
export async function runGhWithRetry(
  cmd: string[],
  opts: RunOpts & RetryOpts = {}
): Promise<RunResult> {
  const max = opts.maxAttempts ?? 3;
  const base = opts.baseDelayMs ?? 2000;
  let lastResult: RunResult | undefined;
  for (let attempt = 1; attempt <= max; attempt++) {
    if (opts.signal?.aborted) break;
    const result = await run(cmd, opts);
    lastResult = result;
    if (result.exitCode === 0) return result;
    if (!isTransientGhError(result.stderr)) return result;
    if (attempt === max) break;
    const delay = base * 2 ** (attempt - 1);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (lastResult === undefined) {
    throw new Error(
      'runGhWithRetry: no attempts executed (aborted before run)'
    );
  }
  return lastResult;
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
  const { stdout, stderr, exitCode } = await runGhWithRetry([
    'gh',
    'issue',
    'view',
    String(issue),
    '--repo',
    `${repo.owner}/${repo.name}`,
    '--json',
    'title,body,state,labels',
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `gh issue view failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`
    );
  }
  const data = issueViewSchema.parse(JSON.parse(stdout));
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
  const { stdout, stderr, exitCode } = await runGhWithRetry([
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
  if (exitCode !== 0) {
    throw new Error(
      `gh pr list failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`
    );
  }
  const arr = z
    .array(z.object({ number: z.number() }))
    .parse(JSON.parse(stdout));
  return arr[0]?.number ?? null;
}

export type CiCheck = {
  name: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | skipped | null
};

export async function ghPrChecks(pr: number, repo: Repo): Promise<CiCheck[]> {
  const { stdout, stderr, exitCode } = await runGhWithRetry([
    'gh',
    'pr',
    'checks',
    String(pr),
    '--repo',
    `${repo.owner}/${repo.name}`,
    '--json',
    'name,bucket,state',
  ]);
  // gh exits 8 when checks are pending or have failed; output is still JSON.
  // gh exits 1 on a freshly-created PR before any check has been registered
  // ("no checks reported on the 'X' branch"); treat that as an empty result so
  // pollCi can keep waiting.
  if (exitCode === 1 && /no checks reported/i.test(stderr)) {
    return [];
  }
  if (exitCode !== 0 && exitCode !== 8) {
    throw new Error(
      `gh pr checks failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`
    );
  }
  const raw = ghCheckArraySchema.parse(JSON.parse(stdout || '[]'));
  return raw.map(toCiCheck);
}

// gh CLI emits `bucket` (pass|fail|pending|skipping|cancel) and `state`
// (SUCCESS|FAILURE|IN_PROGRESS|...). Translate into the legacy
// `status`/`conclusion` pair so downstream code stays oblivious.
function toCiCheck(raw: { name: string; bucket: string; state: string }): CiCheck {
  switch (raw.bucket) {
    case 'pending':
      return { name: raw.name, status: 'in_progress', conclusion: null };
    case 'pass':
      return { name: raw.name, status: 'completed', conclusion: 'success' };
    case 'fail':
      return { name: raw.name, status: 'completed', conclusion: 'failure' };
    case 'skipping':
      return { name: raw.name, status: 'completed', conclusion: 'skipped' };
    case 'cancel':
      return { name: raw.name, status: 'completed', conclusion: 'cancelled' };
    default:
      return {
        name: raw.name,
        status: 'completed',
        conclusion: raw.state.toLowerCase(),
      };
  }
}

const ghCheckArraySchema = z.array(
  z.object({
    name: z.string(),
    bucket: z.string(),
    state: z.string(),
  })
);

export async function ghPrComments(
  pr: number,
  repo: Repo
): Promise<{
  reviews: Array<{
    author: string;
    isBot: boolean;
    state: string;
    body: string;
    submittedAt: string;
  }>;
  comments: Array<{
    author: string;
    isBot: boolean;
    body: string;
    createdAt: string;
  }>;
}> {
  // Use the REST API directly so we get `user.type` ("Bot" vs "User"). gh's
  // own `--json comments,reviews` strips `[bot]` from logins and doesn't
  // expose the type, which left us unable to distinguish CI bot noise from
  // human review feedback.
  const repoSlug = `${repo.owner}/${repo.name}`;
  const [commentsRes, reviewsRes] = await Promise.all([
    runGhWithRetry(['gh', 'api', `/repos/${repoSlug}/issues/${String(pr)}/comments`]),
    runGhWithRetry(['gh', 'api', `/repos/${repoSlug}/pulls/${String(pr)}/reviews`]),
  ]);
  if (commentsRes.exitCode !== 0) {
    throw new Error(
      `gh api comments failed (exit ${commentsRes.exitCode}): ${commentsRes.stderr.trim() || commentsRes.stdout.trim()}`
    );
  }
  if (reviewsRes.exitCode !== 0) {
    throw new Error(
      `gh api reviews failed (exit ${reviewsRes.exitCode}): ${reviewsRes.stderr.trim() || reviewsRes.stdout.trim()}`
    );
  }
  const rawComments = prRestCommentArraySchema.parse(JSON.parse(commentsRes.stdout));
  const rawReviews = prRestReviewArraySchema.parse(JSON.parse(reviewsRes.stdout));
  return {
    reviews: rawReviews.map((r) => ({
      author: r.user.login,
      isBot: r.user.type === 'Bot',
      state: r.state,
      body: r.body,
      submittedAt: r.submitted_at,
    })),
    comments: rawComments.map((c) => ({
      author: c.user.login,
      isBot: c.user.type === 'Bot',
      body: c.body,
      createdAt: c.created_at,
    })),
  };
}

const restUserSchema = z.object({
  login: z.string(),
  type: z.string(),
});

const prRestCommentArraySchema = z.array(
  z.object({
    user: restUserSchema,
    body: z.string().nullable().transform((v) => v ?? ''),
    created_at: z.string(),
  })
);

const prRestReviewArraySchema = z.array(
  z.object({
    user: restUserSchema,
    state: z.string(),
    body: z.string().nullable().transform((v) => v ?? ''),
    submitted_at: z.string().nullable().transform((v) => v ?? ''),
  })
);

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

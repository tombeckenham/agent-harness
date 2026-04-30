/**
 * Ralphy inner-loop driver. Per iteration:
 *   1. Gather world state (branch, PR, CI, unaddressed review comments).
 *   2. Render the engineer prompt with that state.
 *   3. Run a single Claude session with engineer permissions.
 *   4. Parse the terminal verdict and return what the runner should do next.
 *
 * The runner alternates these "engineer steps" with separate reviewer passes
 * and CI polls between iterations.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractFencedJson, runClaude } from './claude';
import { peekCi, type CiResult } from './ci';
import {
  commitsSince,
  ghPrChecks,
  ghPrComments,
  type CiCheck,
  type Repo,
} from './git';
import type { Logger } from './log';
import { buildEngineerPrompt } from './prompt';
import type { IssueState } from './state';

const ALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'Read',
  'Grep',
  'Glob',
  'TodoWrite',
  'Task',
];

const DISALLOWED_TOOLS = [
  'Bash(gh pr merge:*)',
  'Bash(gh pr close:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh issue close:*)',
  'Bash(gh issue edit:*)',
  'Bash(gh issue comment:*)',
  'Bash(gh pr comment:*)',
  'Bash(gh pr review:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
];

export type EngineerVerdict = {
  status: 'continue' | 'done' | 'blocked';
  summary: string;
  reason?: string;
};

function isEngineerVerdict(v: unknown): v is EngineerVerdict {
  if (typeof v !== 'object' || v === null) return false;
  const status = (v as { status?: unknown }).status;
  return status === 'continue' || status === 'done' || status === 'blocked';
}

export type EngineerStepResult = {
  ok: boolean;
  verdict: EngineerVerdict | null;
  newCommits: number;
  transcriptPath: string;
  error?: string;
};

export type WorldSnapshot = {
  branchState: string;
  prState: string;
  ciState: string;
  reviewState: string;
};

export async function gatherWorldState(args: {
  issue: IssueState;
  repo: Repo;
  log: Logger;
}): Promise<WorldSnapshot> {
  const { issue, repo, log } = args;
  const branchState = await describeBranch(issue);
  const prState = describePr(issue);

  let ciState = '_No PR yet — CI cannot run._';
  let reviewState = '_No PR yet — no reviews._';

  if (issue.prNumber !== undefined) {
    try {
      const ci = await peekCi(issue.prNumber, repo);
      ciState = describeCi(ci);
    } catch (err) {
      log.warn('ralphy.peek-ci-failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      ciState =
        '_CI status unavailable (gh error). Try `gh pr checks` yourself._';
    }
    try {
      reviewState = await describeReviewFeedback(issue.prNumber, repo);
    } catch (err) {
      log.warn('ralphy.review-fetch-failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      reviewState = '_Review feedback unavailable (gh error)._';
    }
  }

  return { branchState, prState, ciState, reviewState };
}

async function describeBranch(issue: IssueState): Promise<string> {
  let count: number;
  try {
    count = await commitsSince(issue.baseRef, issue.worktreePath);
  } catch (err) {
    return `Could not inspect branch: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (count === 0) {
    return `No commits yet on \`${issue.branch}\` since \`${issue.baseRef}\`. Nothing has been implemented.`;
  }
  return `${String(count)} commit(s) on \`${issue.branch}\` since \`${issue.baseRef}\`. Use \`git log --oneline ${issue.baseRef}..HEAD\` to inspect.`;
}

function describePr(issue: IssueState): string {
  if (issue.prNumber === undefined) {
    return 'No PR open yet. Once you push commits, the harness will open one for you.';
  }
  return `PR #${String(issue.prNumber)} open. Use \`gh pr view ${String(issue.prNumber)}\` for details.`;
}

function describeCi(ci: CiResult): string {
  switch (ci.status) {
    case 'none':
      return 'No checks reported yet (PR may have just opened).';
    case 'pending':
      return `${String(ci.checks.length)} check(s) still running. ${formatCheckSummary(ci.checks)}`;
    case 'green':
      return `All ${String(ci.checks.length)} check(s) passed. CI is green.`;
    case 'red':
      return `CI failing:\n${ci.failureSummary}`;
    case 'timeout':
      return `Polling timed out with ${String(ci.checks.length)} check(s) still pending. ${formatCheckSummary(ci.checks)}`;
  }
}

function formatCheckSummary(checks: CiCheck[]): string {
  const lines = checks
    .slice(0, 10)
    .map(
      (c) =>
        `  - ${c.name}: ${c.status}${c.conclusion ? ` (${c.conclusion})` : ''}`
    );
  if (checks.length > 10) {
    lines.push(`  ... and ${String(checks.length - 10)} more`);
  }
  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

async function describeReviewFeedback(pr: number, repo: Repo): Promise<string> {
  const { reviews, comments } = await ghPrComments(pr, repo);
  const blockingReviews = reviews.filter(
    (r) =>
      r.state === 'CHANGES_REQUESTED' ||
      (r.state === 'COMMENTED' && r.body.trim().length > 0)
  );
  if (blockingReviews.length === 0 && comments.length === 0) {
    return '_No review comments yet._';
  }
  const reviewLines = blockingReviews.map(
    (r) =>
      `### Review by @${r.author} (${r.state}, ${r.submittedAt})\n${r.body}`
  );
  const commentLines = comments
    .filter((c) => c.body.trim().length > 0)
    .map((c) => `### Comment by @${c.author} (${c.createdAt})\n${c.body}`);
  return [...reviewLines, ...commentLines].join('\n\n');
}

export async function runEngineerStep(args: {
  issue: IssueState;
  repo: Repo;
  runDir: string;
  prevPrSummary: string;
  budgetMs: number;
  maxRounds: number;
  round: number;
  snapshot: WorldSnapshot;
  log: Logger;
}): Promise<EngineerStepResult> {
  const { issue, repo, runDir, budgetMs, log } = args;
  const phaseLog = log.child({ phase: 'engineer', issue: issue.issue });

  const transcriptDir = join(
    runDir,
    `issue-${String(issue.issue)}`,
    'transcripts'
  );
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(
    transcriptDir,
    `engineer-${String(args.round)}.jsonl`
  );

  const prompt = buildEngineerPrompt({
    issue: issue.issue,
    title: issue.title,
    body: '(use `gh issue view` for the full issue body if you need it)',
    repo: `${repo.owner}/${repo.name}`,
    cwd: issue.worktreePath,
    branch: issue.branch,
    baseRef: issue.baseRef,
    prevPrSummary: args.prevPrSummary,
    round: args.round,
    maxRounds: args.maxRounds,
    branchState: args.snapshot.branchState,
    prState: args.snapshot.prState,
    ciState: args.snapshot.ciState,
    reviewState: args.snapshot.reviewState,
    pr: issue.prNumber ?? 0,
    budgetMinutes: Math.round(budgetMs / 60000),
  });

  const startCount = await commitsSince(issue.baseRef, issue.worktreePath);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs);

  let result;
  try {
    result = await runClaude({
      prompt,
      cwd: issue.worktreePath,
      transcriptPath,
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      permissionMode: 'acceptEdits',
      signal: ctrl.signal,
      log: phaseLog,
    });
  } finally {
    clearTimeout(timer);
  }

  const endCount = await commitsSince(issue.baseRef, issue.worktreePath);
  const newCommits = endCount - startCount;

  if (result.abortedForTimeout) {
    return {
      ok: false,
      verdict: null,
      newCommits,
      transcriptPath,
      error: `Engineer step timed out after ${String(budgetMs)}ms`,
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      verdict: null,
      newCommits,
      transcriptPath,
      error: `Claude exited with code ${String(result.exitCode)}`,
    };
  }

  const verdict = extractFencedJson(
    result.lastAssistantText,
    isEngineerVerdict
  );
  if (!verdict) {
    phaseLog.warn('engineer.no-verdict-json');
    return {
      ok: true,
      verdict: { status: 'continue', summary: '(no verdict JSON emitted)' },
      newCommits,
      transcriptPath,
    };
  }

  return { ok: true, verdict, newCommits, transcriptPath };
}

/**
 * Re-poll CI fully (long timeout) — used by the runner between engineer
 * iterations once a PR exists, so the next iteration's snapshot reflects
 * the latest results rather than the agent's stale view.
 */
export async function refreshCi(args: {
  pr: number;
  repo: Repo;
  log: Logger;
}): Promise<CiCheck[]> {
  return ghPrChecks(args.pr, args.repo);
}

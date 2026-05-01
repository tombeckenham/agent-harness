import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractFencedJson, isReviewVerdict, runClaude } from '../lib/claude';
import { type Repo } from '../lib/git';
import type { Logger } from '../lib/log';
import { buildReviewPrompt } from '../lib/prompt';
import type { IssueState } from '../lib/state';

// Reviewer is read-only on the working tree and limited to gh subcommands
// that fetch PR context or post comments — it cannot close, merge, edit
// labels/title, or otherwise mutate the PR's metadata.
const ALLOWED_TOOLS = [
  'Bash(gh issue view:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr diff:*)',
  'Bash(gh pr checks:*)',
  'Bash(gh pr review:*)',
  'Bash(gh pr comment:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Read',
  'Grep',
  'Glob',
  'TodoWrite',
];

const DISALLOWED_TOOLS = [
  'Edit',
  'Write',
  'Bash(git push:*)',
  'Bash(git commit:*)',
  'Bash(git reset:*)',
  'Bash(gh pr close:*)',
  'Bash(gh pr merge:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh issue close:*)',
  'Bash(gh issue edit:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
];

export type ReviewVerdict = {
  verdict: 'clean' | 'needs_changes';
  blockingCount: number;
  summary: string;
  transcriptPath: string;
};

export async function runReviewPhase(args: {
  issue: IssueState;
  repo: Repo;
  repoRoot: string;
  runDir: string;
  round: number;
  maxRounds: number;
  budgetMs: number;
  log: Logger;
}): Promise<ReviewVerdict> {
  const { issue, repo, round, maxRounds, budgetMs, log } = args;
  const phaseLog = log.child({ phase: 'review', issue: issue.issue });
  const transcriptPath = join(
    args.runDir,
    `issue-${issue.issue}`,
    'transcripts',
    `review-${round}.jsonl`
  );
  mkdirSync(join(args.runDir, `issue-${issue.issue}`, 'transcripts'), {
    recursive: true,
  });

  if (issue.prNumber === undefined) {
    throw new Error(
      `Review phase requires a PR number for issue #${issue.issue}`
    );
  }

  // Reviewer runs in the engineer's worktree. Tool restrictions
  // (DISALLOWED_TOOLS) prevent it from editing files, committing, or pushing
  // — git only allows one worktree per branch, so the previous "separate
  // review worktree" pattern was perpetually fighting that constraint.
  const prompt = buildReviewPrompt({
    repo: `${repo.owner}/${repo.name}`,
    pr: issue.prNumber,
    branch: issue.branch,
    baseRef: issue.baseRef,
    issue: issue.issue,
    title: issue.title,
    cwd: issue.worktreePath,
    round,
    maxRounds,
  });

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
      permissionMode: 'default',
      signal: ctrl.signal,
      log: phaseLog,
    });
  } finally {
    clearTimeout(timer);
  }

  if (result.abortedForTimeout || result.exitCode !== 0) {
    phaseLog.warn('review.failed-or-timed-out', {
      abortedForTimeout: result.abortedForTimeout,
      exitCode: result.exitCode,
    });
    // Reviewer process itself crashed (auth issue, missing binary, etc.) —
    // mark needs_changes so the issue isn't silently merged. A timeout is
    // also pessimistic by default; the user can re-run if they trust the PR.
    return {
      verdict: 'needs_changes',
      blockingCount: 0,
      summary: `Reviewer process failed (exit ${String(result.exitCode)}${result.abortedForTimeout ? ', timed out' : ''}).`,
      transcriptPath,
    };
  }

  const parsed = extractFencedJson(result.lastAssistantText, isReviewVerdict);

  if (!parsed) {
    phaseLog.warn('review.no-verdict-json');
    return {
      verdict: 'clean',
      blockingCount: 0,
      summary: 'Reviewer did not emit verdict JSON; treated as clean.',
      transcriptPath,
    };
  }

  return {
    verdict: parsed.verdict,
    blockingCount: parsed.blockingCount ?? 0,
    summary: parsed.summary ?? '',
    transcriptPath,
  };
}

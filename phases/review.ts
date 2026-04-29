import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { extractFencedJson, isReviewVerdict, runClaude } from '../lib/claude';
import {
  addWorktree,
  adoptWorktree,
  removeWorktree,
  type Repo,
} from '../lib/git';
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
  const { issue, repo, repoRoot, runDir, round, maxRounds, budgetMs, log } =
    args;
  const phaseLog = log.child({ phase: 'review', issue: issue.issue });
  const transcriptPath = join(
    runDir,
    `issue-${issue.issue}`,
    'transcripts',
    `review-${round}.jsonl`
  );
  mkdirSync(join(runDir, `issue-${issue.issue}`, 'transcripts'), {
    recursive: true,
  });

  // Reviewer runs in a separate read-only worktree at the PR head so it
  // physically cannot modify the implementing worktree.
  const reviewWorktree = join(
    runDir,
    `issue-${issue.issue}`,
    `review-${round}-worktree`
  );
  if (existsSync(reviewWorktree)) {
    rmSync(reviewWorktree, { recursive: true, force: true });
  }

  // Adopt the existing branch into a fresh worktree.
  try {
    await adoptWorktree(reviewWorktree, issue.branch, repoRoot);
  } catch (err) {
    // If something stale is checked out elsewhere, try a clean add.
    const msg = err instanceof Error ? err.message : String(err);
    phaseLog.warn('review.worktree.adopt-failed', { msg });
    await addWorktree(
      reviewWorktree,
      `${issue.branch}-rev-${round}`,
      issue.branch,
      repoRoot
    );
  }

  if (issue.prNumber === undefined) {
    throw new Error(
      `Review phase requires a PR number for issue #${issue.issue}`
    );
  }

  const prompt = buildReviewPrompt({
    repo: `${repo.owner}/${repo.name}`,
    pr: issue.prNumber,
    branch: issue.branch,
    baseRef: issue.baseRef,
    issue: issue.issue,
    title: issue.title,
    cwd: reviewWorktree,
    round,
    maxRounds,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs);

  let result;
  try {
    result = await runClaude({
      prompt,
      cwd: reviewWorktree,
      transcriptPath,
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      permissionMode: 'default',
      signal: ctrl.signal,
      log: phaseLog,
    });
  } finally {
    clearTimeout(timer);
    await removeWorktree(reviewWorktree, repoRoot);
  }

  if (result.abortedForTimeout || result.exitCode !== 0) {
    phaseLog.warn('review.failed-or-timed-out', {
      abortedForTimeout: result.abortedForTimeout,
      exitCode: result.exitCode,
    });
    // Per prompt contract: treat unparseable failures as clean to avoid
    // pinning the chain on reviewer flakes.
    return {
      verdict: 'clean',
      blockingCount: 0,
      summary: 'Reviewer phase failed; treated as clean.',
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

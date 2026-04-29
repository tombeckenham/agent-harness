import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractFencedJson,
  isImplementVerdict,
  runClaude,
} from '../lib/claude';
import {
  commitsSince,
  ensureSafeAbort,
  ghPrComments,
  pushBranch,
  remoteSyncStatus,
  runLefthookPreCommit,
  type CiCheck,
  type Repo,
} from '../lib/git';
import type { Logger } from '../lib/log';
import { buildFixPrompt } from '../lib/prompt';
import type { IssueState } from '../lib/state';

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
  'Bash(gh pr create:*)',
  'Bash(gh pr merge:*)',
  'Bash(gh pr close:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
];

export type FixResult = {
  ok: boolean;
  newCommits: number;
  error?: string;
  transcriptPath: string;
};

export async function runFixPhase(args: {
  issue: IssueState;
  repo: Repo;
  runDir: string;
  round: number;
  maxRounds: number;
  budgetMs: number;
  ciFailures: CiCheck[] | null;
  log: Logger;
}): Promise<FixResult> {
  const { issue, repo, runDir, round, maxRounds, budgetMs, ciFailures, log } =
    args;
  const phaseLog = log.child({ phase: 'fix', issue: issue.issue });

  if (issue.prNumber === undefined) {
    throw new Error(`Fix phase requires a PR number for issue #${issue.issue}`);
  }

  const issueDir = join(runDir, `issue-${issue.issue}`);
  const transcriptPath = join(issueDir, 'transcripts', `fix-${round}.jsonl`);
  mkdirSync(join(issueDir, 'transcripts'), { recursive: true });

  await ensureSafeAbort(issue.worktreePath, phaseLog);

  // Build the review feedback block.
  const { reviews, comments } = await ghPrComments(issue.prNumber, repo);
  const reviewLines = reviews
    .filter((r) => r.body && r.body.trim().length > 0)
    .map((r) => `### Review by @${r.author} (${r.state})\n${r.body}`);
  const commentLines = comments
    .filter((c) => c.body && c.body.trim().length > 0)
    .map((c) => `### Comment by @${c.author}\n${c.body}`);
  const reviewBlock =
    [...reviewLines, ...commentLines].join('\n\n') || '_No review feedback._';

  // CI failure block + log file the prompt can reference.
  const ciLogPath = join(issueDir, `ci-failures-${round}.txt`);
  let ciBlock = '_No CI failures._';
  if (ciFailures && ciFailures.length > 0) {
    const failed = ciFailures.filter((c) => c.conclusion === 'failure');
    if (failed.length > 0) {
      ciBlock = failed
        .map((c) => `- **${c.name}**: ${c.conclusion}`)
        .join('\n');
      writeFileSync(
        ciLogPath,
        failed
          .map(
            (c) => `${c.name}\n  status=${c.status} conclusion=${c.conclusion}`
          )
          .join('\n\n')
      );
    }
  }

  const prompt = buildFixPrompt({
    repo: `${repo.owner}/${repo.name}`,
    pr: issue.prNumber,
    issue: issue.issue,
    title: issue.title,
    branch: issue.branch,
    cwd: issue.worktreePath,
    round,
    maxRounds,
    reviewBlock,
    ciBlock,
    ciLogPath,
    budgetMinutes: Math.round(budgetMs / 60000),
  });

  const startSha = await commitsSince(issue.baseRef, issue.worktreePath);
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

  if (result.abortedForTimeout) {
    return {
      ok: false,
      newCommits: 0,
      error: `Fix phase timed out after ${budgetMs}ms`,
      transcriptPath,
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      newCommits: 0,
      error: `Claude exited with code ${result.exitCode}`,
      transcriptPath,
    };
  }

  const verdict = extractFencedJson(
    result.lastAssistantText,
    isImplementVerdict
  );
  if (verdict?.status === 'blocked') {
    return {
      ok: false,
      newCommits: 0,
      error: `Claude reported blocked: ${verdict.reason ?? ''}`,
      transcriptPath,
    };
  }

  const endSha = await commitsSince(issue.baseRef, issue.worktreePath);
  const added = endSha - startSha;
  phaseLog.info('fix.commits-added', { added });

  if (added === 0) {
    // No commits = nothing to push, but also nothing to verify against
    // CI feedback. Treat as a no-op fix; the next review round will decide.
    return { ok: true, newCommits: 0, transcriptPath };
  }

  // Lefthook self-check before push.
  const lefthook = await runLefthookPreCommit(issue.worktreePath);
  if (lefthook.exitCode !== 0) {
    phaseLog.warn('lefthook.failed', {
      exitCode: lefthook.exitCode,
      stderr: lefthook.stderr.slice(0, 2000),
    });
    return {
      ok: false,
      newCommits: added,
      error: `Pre-push lefthook failed (exit ${lefthook.exitCode}).`,
      transcriptPath,
    };
  }

  // Verify the push happened. Claude may have forgotten or been killed.
  const sync = await remoteSyncStatus(issue.branch, issue.worktreePath);
  if (sync === 'ahead') {
    phaseLog.warn('fix.push-missed-by-claude; pushing now');
    await pushBranch(issue.branch, issue.worktreePath);
  } else if (sync === 'diverged') {
    return {
      ok: false,
      newCommits: added,
      error: `Local and remote diverged on ${issue.branch}; refusing to force-push.`,
      transcriptPath,
    };
  } else if (sync === 'behind') {
    return {
      ok: false,
      newCommits: added,
      error: `Local is behind origin/${issue.branch}; another writer is on this branch.`,
      transcriptPath,
    };
  }

  return { ok: true, newCommits: added, transcriptPath };
}

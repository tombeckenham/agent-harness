import { existsSync } from 'node:fs';
import { addWorktree, adoptWorktree, ensureSafeAbort } from './git';
import type { Logger } from './log';
import type { IssueState } from './state';

export async function prepareIssueWorktree(args: {
  issue: IssueState;
  repoRoot: string;
  log: Logger;
}): Promise<void> {
  const { issue, repoRoot, log } = args;

  if (!existsSync(issue.worktreePath)) {
    log.info('worktree.create', {
      path: issue.worktreePath,
      base: issue.baseRef,
      branch: issue.branch,
    });
    try {
      await addWorktree(
        issue.worktreePath,
        issue.branch,
        issue.baseRef,
        repoRoot
      );
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('already exists')) throw err;
      log.info('worktree.adopt-after-conflict', {
        path: issue.worktreePath,
        branch: issue.branch,
      });
      await adoptWorktree(issue.worktreePath, issue.branch, repoRoot);
      return;
    }
  }

  log.info('worktree.exists', { path: issue.worktreePath });
  await ensureSafeAbort(issue.worktreePath, log);
}

export function formatPrTitle(issueTitle: string, issue: number): string {
  return `${issueTitle} #${issue}`;
}

export function formatPrBody(args: {
  issue: number;
  summary: string;
  isStacked: boolean;
  baseRef: string;
}): string {
  const stacked = args.isStacked
    ? `\n> Stacked on \`${args.baseRef}\`. Merge the parent PR first; GitHub will auto-retarget this one.\n`
    : '';
  const summary = args.summary.split('\n').slice(0, 20).join('\n');
  return `## Related Issue
Closes #${args.issue}
${stacked}
## Summary
${summary}

## Notes
Opened by the agent-harness overnight runner. See the \`harness-active\` label.
`;
}

// Used as a fallback when the harness wants to mention the previous PR in the
// chain as context for the engineer prompt.
export function buildPrevPrSummary(
  prev: import('./state').IssueState | undefined
): string {
  if (!prev) return 'None — first PR in chain.';
  const prLine =
    prev.prNumber === undefined
      ? 'No PR yet.'
      : `PR: #${String(prev.prNumber)}`;
  return [
    `Issue #${String(prev.issue)}: ${prev.title}`,
    `Branch: ${prev.branch}`,
    prLine,
    `Status: ${prev.status}`,
  ].join('\n');
}

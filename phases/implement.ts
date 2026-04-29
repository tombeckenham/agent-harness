import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractFencedJson,
  isImplementVerdict,
  runClaude,
} from '../lib/claude';
import {
  addWorktree,
  adoptWorktree,
  commitsSince,
  ensureSafeAbort,
  ghIssueView,
  ghPrAddLabel,
  ghPrCreate,
  ghPrFindForBranch,
  pushBranch,
  runLefthookPreCommit,
  type Repo,
} from '../lib/git';
import type { Logger } from '../lib/log';
import { buildImplementPrompt } from '../lib/prompt';
import type { IssueState } from '../lib/state';

const HARNESS_LABEL = 'harness-active';

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
  'Bash(git push:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr merge:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
];

export type ImplementResult = {
  ok: boolean;
  prNumber?: number;
  error?: string;
  transcriptPath: string;
};

export async function runImplementPhase(args: {
  issue: IssueState;
  repo: Repo;
  repoRoot: string;
  runDir: string;
  prevPrSummary: string;
  budgetMs: number;
  log: Logger;
}): Promise<ImplementResult> {
  const { issue, repo, repoRoot, runDir, prevPrSummary, budgetMs, log } = args;
  const phaseLog = log.child({ phase: 'implement', issue: issue.issue });
  const transcriptPath = join(
    runDir,
    `issue-${issue.issue}`,
    'transcripts',
    `implement-${issue.attempts.implement + 1}.jsonl`
  );
  mkdirSync(join(runDir, `issue-${issue.issue}`, 'transcripts'), {
    recursive: true,
  });

  // 1. Set up the worktree (idempotent on resume).
  if (!existsSync(issue.worktreePath)) {
    phaseLog.info('worktree.create', {
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
    } catch (err) {
      // Branch may already exist (resume after partial run).
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already exists')) {
        phaseLog.info('worktree.adopt', {
          path: issue.worktreePath,
          branch: issue.branch,
        });
        await adoptWorktree(issue.worktreePath, issue.branch, repoRoot);
      } else {
        throw err;
      }
    }
  } else {
    phaseLog.info('worktree.exists', { path: issue.worktreePath });
    await ensureSafeAbort(issue.worktreePath, phaseLog);
  }

  // 2. Fetch issue body (the spawned Claude could too, but we want it in context).
  const meta = await ghIssueView(issue.issue, repo);

  // 3. Build prompt and run Claude.
  const prompt = buildImplementPrompt({
    issue: issue.issue,
    title: meta.title,
    body: meta.body || '(no body)',
    repo: `${repo.owner}/${repo.name}`,
    cwd: issue.worktreePath,
    branch: issue.branch,
    baseRef: issue.baseRef,
    prevPrSummary,
    budgetMinutes: Math.round(budgetMs / 60000),
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
      error: `Implement phase timed out after ${budgetMs}ms`,
      transcriptPath,
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
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
      error: `Claude reported blocked: ${verdict.reason ?? 'no reason given'}`,
      transcriptPath,
    };
  }

  // 4. Verify there are commits on the branch.
  const newCommits = await commitsSince(issue.baseRef, issue.worktreePath);
  if (newCommits === 0) {
    return {
      ok: false,
      error: 'No commits on branch — Claude did not implement anything.',
      transcriptPath,
    };
  }
  phaseLog.info('commits.created', { count: newCommits });

  // 5. Lefthook self-check pre-push. Catches cases where Claude forgot.
  const lefthook = await runLefthookPreCommit(issue.worktreePath);
  if (lefthook.exitCode !== 0) {
    phaseLog.warn('lefthook.failed', {
      exitCode: lefthook.exitCode,
      stderr: lefthook.stderr.slice(0, 2000),
    });
    return {
      ok: false,
      error: `Pre-push lefthook failed (exit ${lefthook.exitCode}). Last commit may not pass CI.`,
      transcriptPath,
    };
  }

  // 6. Push.
  await pushBranch(issue.branch, issue.worktreePath);
  phaseLog.info('branch.pushed', { branch: issue.branch });

  // 6. Open PR (or adopt existing one if a previous run got this far).
  let prNumber = await ghPrFindForBranch(issue.branch, repo);
  if (prNumber === null) {
    const prTitle = formatPrTitle(meta.title, issue.issue);
    const prBody = formatPrBody({
      issue: issue.issue,
      summary: result.lastAssistantText,
      isStacked: issue.baseRef !== 'main',
      baseRef: issue.baseRef,
    });
    prNumber = await ghPrCreate({
      cwd: issue.worktreePath,
      base: issue.baseRef,
      head: issue.branch,
      title: prTitle,
      body: prBody,
      draft: false,
    });
    phaseLog.info('pr.created', { pr: prNumber });
  } else {
    phaseLog.info('pr.adopted', { pr: prNumber });
  }

  // 7. Tag with harness label so collaborators know to leave it alone.
  await ghPrAddLabel(prNumber, HARNESS_LABEL, repo);

  return { ok: true, prNumber, transcriptPath };
}

function formatPrTitle(issueTitle: string, issue: number): string {
  // Mirror the project's commit style: `<title> #<issue>`.
  return `${issueTitle} #${issue}`;
}

function formatPrBody(args: {
  issue: number;
  summary: string;
  isStacked: boolean;
  baseRef: string;
}): string {
  const stacked = args.isStacked
    ? `\n> Stacked on \`${args.baseRef}\`. Merge the parent PR first; GitHub will auto-retarget this one to \`main\`.\n`
    : '';
  return `## Related Issue
Closes #${args.issue}
${stacked}
## Summary of Changes
${args.summary.split('\n').slice(0, 20).join('\n')}

## Risk Assessment
- [x] Low
- [ ] Medium
- [ ] High

## Additional Notes
Opened by the agent-harness overnight runner. See the \`harness-active\` label.
`;
}

import {
  buildPrevPrSummary,
  formatPrBody,
  formatPrTitle,
  prepareIssueWorktree,
} from './lib/branch';
import { peekCi, pollCi } from './lib/ci';
import {
  commitsSince,
  ghIssueView,
  ghPrAddLabel,
  ghPrCreate,
  ghPrFindForBranch,
  pushBranch,
  remoteSyncStatus,
  type Repo,
} from './lib/git';
import type { Logger } from './lib/log';
import { gatherWorldState, runEngineerStep } from './lib/ralphy';
import {
  recordError,
  saveState,
  type HarnessState,
  type IssueState,
} from './lib/state';
import { runReviewPhase } from './phases/review';

const HARNESS_LABEL = 'harness-active';

export type RunnerArgs = {
  state: HarnessState;
  statePath: string;
  repo: Repo;
  repoRoot: string;
  runDir: string;
  log: Logger;
};

function at<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) {
    throw new Error(
      `Index ${String(i)} out of bounds (length ${String(arr.length)})`
    );
  }
  return v;
}

export async function runChain(args: RunnerArgs): Promise<HarnessState> {
  let state = args.state;

  for (let i = 0; i < state.chain.length; i++) {
    const issueLog = args.log.child({ issue: state.chain[i]?.issue });
    issueLog.info('issue.start', {
      status: at(state.chain, i).status,
      base: at(state.chain, i).baseRef,
      branch: at(state.chain, i).branch,
    });

    if (at(state.chain, i).status === 'done') {
      issueLog.info('issue.skip-done');
      continue;
    }

    state = await runIssue(state, args, i, issueLog);

    const finalStatus = at(state.chain, i).status;
    if (finalStatus === 'failed') {
      if (
        state.config.onFailure === 'stop' ||
        state.config.onFailure === 'prompt'
      ) {
        issueLog.warn('chain.stop', { reason: 'issue failed' });
        return state;
      }
      issueLog.warn('chain.skip', { reason: 'issue failed' });
      continue;
    }

    // Wire next issue's baseRef.
    if (i + 1 < state.chain.length) {
      const next = at(state.chain, i + 1);
      const updated = { ...next, baseRef: at(state.chain, i).branch };
      state = persistAt(state, args.statePath, i + 1, updated);
    }
  }

  return state;
}

async function runIssue(
  state: HarnessState,
  args: RunnerArgs,
  index: number,
  log: Logger
): Promise<HarnessState> {
  let working = state;
  const update = (next: IssueState): void => {
    working = persistAt(working, args.statePath, index, next);
  };

  let issue = at(working.chain, index);
  update({ ...issue, status: 'in-progress' });
  issue = at(working.chain, index);

  try {
    await prepareIssueWorktree({
      issue,
      repoRoot: args.repoRoot,
      log,
    });
  } catch (err) {
    update(
      recordError(
        issue,
        `worktree prep failed: ${err instanceof Error ? err.message : String(err)}`
      )
    );
    return working;
  }

  // Adopt an existing PR if a previous run already opened one.
  if (issue.prNumber === undefined) {
    const existing = await ghPrFindForBranch(issue.branch, args.repo);
    if (existing !== null) {
      log.info('pr.adopted', { pr: existing });
      update({ ...issue, prNumber: existing });
      issue = at(working.chain, index);
    }
  }

  const issueDeadline = Date.now() + working.config.budgets.issueHardCapMs;
  const prevPrSummary = buildPrevPrSummary(
    index > 0 ? at(working.chain, index - 1) : undefined
  );

  while (issue.rounds < working.config.maxRounds) {
    if (Date.now() > issueDeadline) {
      update(recordError(issue, 'issue hard cap exceeded'));
      return working;
    }

    const round = issue.rounds + 1;
    update({ ...issue, rounds: round });
    issue = at(working.chain, index);

    const snapshot = await gatherWorldState({ issue, repo: args.repo, log });
    log.info('ralphy.snapshot', {
      round,
      hasPr: issue.prNumber !== undefined,
      branchPreview: snapshot.branchState.slice(0, 80),
      ciPreview: snapshot.ciState.slice(0, 80),
    });

    // If PR is open and CI is green and there's no unaddressed feedback,
    // jump straight to a reviewer pass instead of burning an engineer turn.
    if (issue.prNumber !== undefined && issueLooksReadyForReview(snapshot)) {
      const verdict = await runReviewer(working, args, index, issue, log);
      working = verdict.state;
      issue = at(working.chain, index);
      if (issue.status === 'done' || issue.status === 'failed') return working;
      continue;
    }

    const stepResult = await runEngineerStep({
      issue,
      repo: args.repo,
      runDir: args.runDir,
      prevPrSummary,
      budgetMs: working.config.budgets.engineerMs,
      maxRounds: working.config.maxRounds,
      round,
      snapshot,
      log,
    });

    if (!stepResult.ok) {
      update(
        recordError(
          issue,
          stepResult.error ?? 'engineer step failed',
          stepResult.transcriptPath
        )
      );
      return working;
    }

    if (stepResult.verdict?.status === 'blocked') {
      update(
        recordError(
          issue,
          `agent reported blocked: ${stepResult.verdict.reason ?? '(no reason)'}`,
          stepResult.transcriptPath
        )
      );
      return working;
    }

    // Push any new commits and ensure a PR exists.
    if (stepResult.newCommits > 0 || (await hasUnpushedCommits(issue))) {
      await pushIfBehind(issue, log);
      if (issue.prNumber === undefined) {
        const pr = await openPr(
          issue,
          args.repo,
          log,
          stepResult.verdict?.summary ?? ''
        );
        update({ ...issue, prNumber: pr });
        issue = at(working.chain, index);
      }
    }

    if (stepResult.verdict?.status === 'done') {
      // Agent thinks it's done — gate on a reviewer pass before believing it.
      if (issue.prNumber === undefined) {
        // No PR means no commits made — agent prematurely declared done.
        update(
          recordError(
            issue,
            'agent reported done but no PR exists (no commits made)',
            stepResult.transcriptPath
          )
        );
        return working;
      }
      // Wait for CI to settle, then run the reviewer.
      await awaitCiSettled(issue.prNumber, args.repo, working, log);
      issue = at(working.chain, index);
      const verdict = await runReviewer(working, args, index, issue, log);
      working = verdict.state;
      issue = at(working.chain, index);
      if (issue.status === 'done' || issue.status === 'failed') return working;
      continue;
    }

    // status === 'continue': loop back, fresh snapshot next iteration.
  }

  update(
    recordError(
      issue,
      `max rounds (${String(working.config.maxRounds)}) exhausted without completion`
    )
  );
  return working;
}

function issueLooksReadyForReview(snapshot: {
  branchState: string;
  ciState: string;
  reviewState: string;
}): boolean {
  const ciGreen = /CI is green/.test(snapshot.ciState);
  const noFeedback = /No review comments yet/.test(snapshot.reviewState);
  const hasCommits = !/No commits yet/.test(snapshot.branchState);
  return ciGreen && noFeedback && hasCommits;
}

async function awaitCiSettled(
  pr: number,
  repo: Repo,
  state: HarnessState,
  log: Logger
): Promise<void> {
  const peek = await peekCi(pr, repo);
  if (peek.status === 'green' || peek.status === 'red') return;
  log.info('ci.awaiting-settle', { pr });
  await pollCi({ pr, repo, budgetMs: state.config.budgets.ciMs, log });
}

async function runReviewer(
  state: HarnessState,
  args: RunnerArgs,
  index: number,
  issue: IssueState,
  log: Logger
): Promise<{ state: HarnessState }> {
  if (issue.prNumber === undefined) {
    return { state };
  }
  const reviewRound = issue.reviewRounds + 1;
  let working = persistAt(state, args.statePath, index, {
    ...issue,
    reviewRounds: reviewRound,
  });
  const updated = at(working.chain, index);

  const verdict = await runReviewPhase({
    issue: updated,
    repo: args.repo,
    repoRoot: args.repoRoot,
    runDir: args.runDir,
    round: reviewRound,
    maxRounds: state.config.maxRounds,
    budgetMs: state.config.budgets.reviewMs,
    log,
  });

  log.info('review.verdict', {
    verdict: verdict.verdict,
    blockingCount: verdict.blockingCount,
  });

  if (verdict.verdict === 'clean') {
    working = persistAt(working, args.statePath, index, {
      ...at(working.chain, index),
      status: 'done',
    });
  }
  // If needs_changes: leave status as in-progress; the next engineer iteration
  // will see the feedback in its snapshot and address it.
  return { state: working };
}

async function pushIfBehind(issue: IssueState, log: Logger): Promise<void> {
  const sync = await remoteSyncStatus(issue.branch, issue.worktreePath);
  if (sync === 'in-sync') return;
  if (sync === 'ahead') {
    log.info('branch.push', { branch: issue.branch });
    await pushBranch(issue.branch, issue.worktreePath);
    return;
  }
  if (sync === 'behind' || sync === 'diverged') {
    throw new Error(
      `Branch ${issue.branch} is ${sync} from origin; refusing to push.`
    );
  }
}

async function hasUnpushedCommits(issue: IssueState): Promise<boolean> {
  const sync = await remoteSyncStatus(issue.branch, issue.worktreePath).catch(
    () => 'in-sync' as const
  );
  return sync === 'ahead';
}

async function openPr(
  issue: IssueState,
  repo: Repo,
  log: Logger,
  summary: string
): Promise<number> {
  const meta = await ghIssueView(issue.issue, repo);
  const title = formatPrTitle(meta.title, issue.issue);
  const body = formatPrBody({
    issue: issue.issue,
    summary,
    isStacked: issue.baseRef !== 'main',
    baseRef: issue.baseRef,
  });
  const commits = await commitsSince(issue.baseRef, issue.worktreePath);
  if (commits === 0) {
    throw new Error('Cannot open PR: no commits on branch yet.');
  }
  const pr = await ghPrCreate({
    cwd: issue.worktreePath,
    base: issue.baseRef,
    head: issue.branch,
    title,
    body,
    draft: false,
  });
  log.info('pr.created', { pr });
  await ghPrAddLabel(pr, HARNESS_LABEL, repo);
  return pr;
}

function persistAt(
  state: HarnessState,
  statePath: string,
  index: number,
  next: IssueState
): HarnessState {
  const updated: HarnessState = {
    ...state,
    chain: state.chain.map((s, i) => (i === index ? next : s)),
  };
  saveState(statePath, updated);
  return updated;
}

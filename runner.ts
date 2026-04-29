import type { CiCheck, Repo } from './lib/git';
import type { Logger } from './lib/log';
import { pollCi } from './phases/ci';
import { runFixPhase } from './phases/fix';
import { runImplementPhase } from './phases/implement';
import { runReviewPhase } from './phases/review';
import {
  recordError,
  saveState,
  transition,
  type HarnessState,
  type IssueState,
} from './lib/state';

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
    throw new Error(`Index ${i} out of bounds (length ${arr.length})`);
  }
  return v;
}

function requirePr(issue: IssueState): number {
  if (issue.prNumber === undefined) {
    throw new Error(`Issue #${issue.issue} is missing a PR number`);
  }
  return issue.prNumber;
}

export async function runChain(args: RunnerArgs): Promise<HarnessState> {
  let state = args.state;

  for (let i = 0; i < state.chain.length; i++) {
    let issue = at(state.chain, i);
    args.log.info('issue.start', {
      issue: issue.issue,
      phase: issue.phase,
      base: issue.baseRef,
      branch: issue.branch,
    });

    if (issue.phase === 'DONE') {
      args.log.info('issue.skip-done', { issue: issue.issue });
      continue;
    }

    const issueDeadline = Date.now() + state.config.budgets.issueHardCapMs;
    const update = (next: IssueState): void => {
      issue = next;
      state = persist(state, args.statePath, i, next);
    };

    try {
      // ----- Implement -----
      if (
        issue.phase === 'PENDING' ||
        issue.phase === 'PREPARING_BRANCH' ||
        issue.phase === 'IMPLEMENTING'
      ) {
        update(transition(issue, 'IMPLEMENTING'));
        update({
          ...issue,
          attempts: {
            ...issue.attempts,
            implement: issue.attempts.implement + 1,
          },
        });
        const prevSummary =
          i > 0
            ? buildPrevSummary(at(state.chain, i - 1))
            : 'None — first PR in chain.';
        const result = await runImplementPhase({
          issue,
          repo: args.repo,
          repoRoot: args.repoRoot,
          runDir: args.runDir,
          prevPrSummary: prevSummary,
          budgetMs: state.config.budgets.implementMs,
          log: args.log,
        });
        if (!result.ok) {
          update(
            recordError(
              transition(issue, 'IMPL_FAILED', result.error),
              result.error ?? 'unknown error',
              result.transcriptPath
            )
          );
          return finishOrContinue(state, args, i, 'implement failed');
        }
        update({ ...issue, prNumber: result.prNumber });
        update(transition(issue, 'PR_OPEN'));
      }

      // ----- CI gate (after implement, before review) -----
      if (issue.phase === 'PR_OPEN' || issue.phase === 'CI_PENDING') {
        update(transition(issue, 'CI_PENDING'));
        const ci = await pollCi({
          pr: requirePr(issue),
          repo: args.repo,
          budgetMs: state.config.budgets.ciMs,
          log: args.log,
        });
        if (ci.status === 'green') {
          update(transition(issue, 'CI_GREEN'));
        } else if (ci.status === 'red') {
          update(transition(issue, 'CI_RED', ci.failureSummary));
          state = await runFixCycle(state, args, i, issue, ci.checks);
          issue = at(state.chain, i);
          if (
            issue.phase === 'IMPL_FAILED' ||
            issue.phase === 'MAX_ROUNDS_EXCEEDED'
          ) {
            return finishOrContinue(
              state,
              args,
              i,
              'CI failures unrecoverable'
            );
          }
        } else {
          update(transition(issue, 'CI_RED', 'CI poll timeout'));
          return finishOrContinue(state, args, i, 'CI timed out');
        }
      }

      // ----- Review loop -----
      if (
        issue.phase === 'CI_GREEN' ||
        issue.phase === 'REVIEWING' ||
        issue.phase === 'HAS_FEEDBACK' ||
        issue.phase === 'FIXING'
      ) {
        let round = issue.attempts.review;
        while (round < state.config.maxRounds) {
          if (Date.now() > issueDeadline) {
            update(
              transition(issue, 'REVIEW_FAILED', 'issue hard cap exceeded')
            );
            return finishOrContinue(state, args, i, 'issue hard cap');
          }
          round++;
          update({
            ...issue,
            attempts: { ...issue.attempts, review: round },
          });
          update(transition(issue, 'REVIEWING'));
          const verdict = await runReviewPhase({
            issue,
            repo: args.repo,
            repoRoot: args.repoRoot,
            runDir: args.runDir,
            round,
            maxRounds: state.config.maxRounds,
            budgetMs: state.config.budgets.reviewMs,
            log: args.log,
          });
          if (verdict.verdict === 'clean') {
            update(transition(issue, 'CLEAN', verdict.summary));
            break;
          }
          update(transition(issue, 'HAS_FEEDBACK', verdict.summary));

          // Run a fix round.
          update({
            ...issue,
            attempts: { ...issue.attempts, fix: issue.attempts.fix + 1 },
          });
          update(transition(issue, 'FIXING'));
          const fixResult = await runFixPhase({
            issue,
            repo: args.repo,
            runDir: args.runDir,
            round,
            maxRounds: state.config.maxRounds,
            budgetMs: state.config.budgets.fixMs,
            ciFailures: null,
            log: args.log,
          });
          if (!fixResult.ok) {
            update(
              recordError(
                transition(issue, 'REVIEW_FAILED', fixResult.error),
                fixResult.error ?? 'unknown',
                fixResult.transcriptPath
              )
            );
            return finishOrContinue(state, args, i, 'fix phase failed');
          }

          // After fix: poll CI again.
          update(transition(issue, 'CI_PENDING'));
          const ci2 = await pollCi({
            pr: requirePr(issue),
            repo: args.repo,
            budgetMs: state.config.budgets.ciMs,
            log: args.log,
          });
          if (ci2.status === 'green') {
            update(transition(issue, 'CI_GREEN'));
          } else {
            const reason =
              ci2.status === 'red' ? ci2.failureSummary : 'timeout';
            update(transition(issue, 'CI_RED', reason));
            const ciChecks = ci2.status === 'red' ? ci2.checks : [];
            state = await runFixCycle(state, args, i, issue, ciChecks);
            issue = at(state.chain, i);
            if (
              issue.phase === 'IMPL_FAILED' ||
              issue.phase === 'MAX_ROUNDS_EXCEEDED'
            ) {
              return finishOrContinue(state, args, i, 'fix CI failed');
            }
          }
        }

        if (issue.phase !== 'CLEAN') {
          update(
            transition(
              issue,
              'MAX_ROUNDS_EXCEEDED',
              `hit ${String(state.config.maxRounds)} rounds`
            )
          );
          return finishOrContinue(state, args, i, 'max rounds exceeded');
        }
      }

      // ----- Done -----
      update(transition(issue, 'DONE'));
      args.log.info('issue.done', {
        issue: issue.issue,
        pr: issue.prNumber ?? null,
      });

      // Set the next issue's baseRef to this branch.
      if (i + 1 < state.chain.length) {
        const next = at(state.chain, i + 1);
        const updated = { ...next, baseRef: issue.branch };
        state = {
          ...state,
          chain: state.chain.map((s, idx) => (idx === i + 1 ? updated : s)),
        };
        saveState(args.statePath, state);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      args.log.error('issue.exception', { issue: issue.issue, msg });
      update(recordError(transition(issue, 'IMPL_FAILED', msg), msg));
      return finishOrContinue(state, args, i, 'exception');
    }
  }

  return state;
}

function persist(
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

async function runFixCycle(
  state: HarnessState,
  args: RunnerArgs,
  index: number,
  issue: IssueState,
  initialFailures: CiCheck[]
): Promise<HarnessState> {
  let working = state;
  let current = issue;
  let failures = initialFailures;

  while (current.attempts.fix < state.config.maxRounds) {
    const round = current.attempts.fix + 1;
    working = persist(working, args.statePath, index, {
      ...transition(current, 'FIXING_CI'),
      attempts: { ...current.attempts, fix: round },
    });
    current = at(working.chain, index);

    const fixResult = await runFixPhase({
      issue: current,
      repo: args.repo,
      runDir: args.runDir,
      round,
      maxRounds: state.config.maxRounds,
      budgetMs: state.config.budgets.fixMs,
      ciFailures: failures,
      log: args.log,
    });

    if (!fixResult.ok) {
      working = persist(
        working,
        args.statePath,
        index,
        recordError(
          transition(current, 'IMPL_FAILED', fixResult.error),
          fixResult.error ?? 'unknown',
          fixResult.transcriptPath
        )
      );
      return working;
    }

    const ci = await pollCi({
      pr: requirePr(at(working.chain, index)),
      repo: args.repo,
      budgetMs: state.config.budgets.ciMs,
      log: args.log,
    });
    current = at(working.chain, index);

    if (ci.status === 'green') {
      working = persist(
        working,
        args.statePath,
        index,
        transition(current, 'CI_GREEN')
      );
      return working;
    }
    const reason = ci.status === 'red' ? ci.failureSummary : 'CI poll timeout';
    working = persist(
      working,
      args.statePath,
      index,
      transition(current, 'CI_RED', reason)
    );
    current = at(working.chain, index);
    failures = ci.status === 'red' ? ci.checks : [];
  }

  // Exhausted the budget.
  working = persist(
    working,
    args.statePath,
    index,
    transition(
      current,
      'MAX_ROUNDS_EXCEEDED',
      `CI still red after ${String(state.config.maxRounds)} fix rounds`
    )
  );
  return working;
}

function finishOrContinue(
  state: HarnessState,
  args: RunnerArgs,
  index: number,
  reason: string
): HarnessState {
  args.log.warn('issue.terminal-failure', { index, reason });
  if (state.config.onFailure === 'stop') {
    args.log.warn('chain.stop', { reason });
    return state;
  }
  if (state.config.onFailure === 'skip') {
    args.log.warn('chain.skip', { reason });
    return state;
  }
  args.log.warn('chain.stop-on-prompt', { reason });
  return state;
}

function buildPrevSummary(prev: IssueState): string {
  const prLine =
    prev.prNumber === undefined
      ? 'No PR yet.'
      : `PR: #${String(prev.prNumber)}`;
  return [
    `Issue #${String(prev.issue)}: ${prev.title}`,
    `Branch: ${prev.branch}`,
    prLine,
    `Status: ${prev.phase}`,
  ].join('\n');
}

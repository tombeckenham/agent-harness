import { ghPrChecks, type CiCheck, type Repo } from './git';
import type { Logger } from './log';

export type CiResult =
  | { status: 'green'; checks: CiCheck[] }
  | { status: 'red'; checks: CiCheck[]; failureSummary: string }
  | { status: 'pending'; checks: CiCheck[] }
  | { status: 'none'; checks: [] }
  | { status: 'timeout'; checks: CiCheck[] };

const POLL_INTERVAL_MS = 30_000;

/**
 * Polls CI until checks are all completed (green/red) or the budget runs out.
 * Returns 'pending' if you want a non-blocking peek (budgetMs <= 0).
 */
export async function pollCi(args: {
  pr: number;
  repo: Repo;
  budgetMs: number;
  log: Logger;
  signal?: AbortSignal;
}): Promise<CiResult> {
  const { pr, repo, budgetMs, log } = args;
  const phaseLog = log.child({ phase: 'ci' });
  const deadline = Date.now() + budgetMs;
  let lastSummary = '';
  let latestChecks: CiCheck[] = [];

  while (Date.now() < deadline) {
    if (args.signal?.aborted) break;
    const checks = await ghPrChecks(pr, repo);
    latestChecks = checks;

    if (checks.length === 0) {
      phaseLog.debug('ci.empty');
    } else {
      const summary = summarize(checks);
      if (summary !== lastSummary) {
        phaseLog.info('ci.update', { summary });
        lastSummary = summary;
      }

      const allDone = checks.every((c) => c.status === 'completed');
      if (allDone) {
        const failed = checks.filter((c) => c.conclusion === 'failure');
        if (failed.length === 0) {
          return { status: 'green', checks };
        }
        return {
          status: 'red',
          checks,
          failureSummary: failed
            .map((c) => `- ${c.name}: ${c.conclusion}`)
            .join('\n'),
        };
      }
    }

    await sleep(POLL_INTERVAL_MS, args.signal);
  }

  return { status: 'timeout', checks: latestChecks };
}

/**
 * Non-blocking single check; useful for the ralphy loop's state-gathering.
 */
export async function peekCi(pr: number, repo: Repo): Promise<CiResult> {
  const checks = await ghPrChecks(pr, repo);
  if (checks.length === 0) return { status: 'none', checks: [] };
  const allDone = checks.every((c) => c.status === 'completed');
  if (!allDone) return { status: 'pending', checks };
  const failed = checks.filter((c) => c.conclusion === 'failure');
  if (failed.length === 0) return { status: 'green', checks };
  return {
    status: 'red',
    checks,
    failureSummary: failed
      .map((c) => `- ${c.name}: ${c.conclusion}`)
      .join('\n'),
  };
}

function summarize(checks: CiCheck[]): string {
  const counts = new Map<string, number>();
  for (const c of checks) {
    const key =
      c.status === 'completed' ? (c.conclusion ?? 'unknown') : c.status;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join(' ');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

import { ghPrChecks, type CiCheck, type Repo } from '../lib/git';
import type { Logger } from '../lib/log';

export type CiResult =
  | { status: 'green'; checks: CiCheck[] }
  | { status: 'red'; checks: CiCheck[]; failureSummary: string }
  | { status: 'timeout'; checks: CiCheck[] };

const POLL_INTERVAL_MS = 30_000;

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

  while (Date.now() < deadline) {
    if (args.signal?.aborted) break;
    const checks = await ghPrChecks(pr, repo);

    if (checks.length === 0) {
      // No checks yet — keep waiting.
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

  return { status: 'timeout', checks: [] };
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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export type Phase =
  | 'PENDING'
  | 'PREPARING_BRANCH'
  | 'IMPLEMENTING'
  | 'IMPL_FAILED'
  | 'PUSHED'
  | 'PR_OPEN'
  | 'CI_PENDING'
  | 'CI_GREEN'
  | 'CI_RED'
  | 'FIXING_CI'
  | 'REVIEWING'
  | 'HAS_FEEDBACK'
  | 'FIXING'
  | 'CLEAN'
  | 'REVIEW_FAILED'
  | 'MAX_ROUNDS_EXCEEDED'
  | 'DONE';

export type FailureMode = 'stop' | 'skip' | 'prompt';

export type IssueState = {
  issue: number;
  title: string;
  slug: string;
  branch: string;
  baseRef: string;
  prNumber?: number;
  worktreePath: string;
  phase: Phase;
  attempts: { implement: number; fix: number; review: number };
  lastError?: {
    phase: Phase;
    message: string;
    transcriptPath?: string;
    at: string;
  };
  events: Array<{ at: string; from: Phase; to: Phase; note?: string }>;
};

export type HarnessState = {
  runId: string;
  startedAt: string;
  config: {
    maxRounds: number;
    onFailure: FailureMode;
    budgets: {
      implementMs: number;
      ciMs: number;
      reviewMs: number;
      fixMs: number;
      issueHardCapMs: number;
    };
  };
  chain: IssueState[];
};

export const DEFAULT_BUDGETS = {
  implementMs: 45 * 60 * 1000,
  ciMs: 15 * 60 * 1000,
  reviewMs: 15 * 60 * 1000,
  fixMs: 30 * 60 * 1000,
  issueHardCapMs: 3 * 60 * 60 * 1000,
} as const;

export function loadState(path: string): HarnessState | null {
  if (!existsSync(path)) return null;
  // Trusted file: it was written by saveState in a prior run of this same
  // harness. We deliberately skip schema validation to keep the state file
  // forward-compatible across small additions to IssueState.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- harness-owned state file
  return JSON.parse(readFileSync(path, 'utf-8')) as HarnessState;
}

export function saveState(path: string, state: HarnessState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

export function transition(
  issue: IssueState,
  to: Phase,
  note?: string
): IssueState {
  const from = issue.phase;
  if (from === to) return issue;
  return {
    ...issue,
    phase: to,
    events: [...issue.events, { at: new Date().toISOString(), from, to, note }],
  };
}

export function recordError(
  issue: IssueState,
  message: string,
  transcriptPath?: string
): IssueState {
  return {
    ...issue,
    lastError: {
      phase: issue.phase,
      message,
      transcriptPath,
      at: new Date().toISOString(),
    },
  };
}

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export type IssueStatus = 'pending' | 'in-progress' | 'done' | 'failed';

export type FailureMode = 'stop' | 'skip' | 'prompt';

export type IssueState = {
  issue: number;
  title: string;
  slug: string;
  branch: string;
  baseRef: string;
  prNumber?: number;
  worktreePath: string;
  status: IssueStatus;
  rounds: number;
  reviewRounds: number;
  lastError?: {
    message: string;
    transcriptPath?: string;
    at: string;
  };
};

export type HarnessState = {
  runId: string;
  startedAt: string;
  config: {
    maxRounds: number;
    onFailure: FailureMode;
    budgets: {
      engineerMs: number;
      ciMs: number;
      reviewMs: number;
      issueHardCapMs: number;
    };
  };
  chain: IssueState[];
};

export const DEFAULT_BUDGETS = {
  engineerMs: 45 * 60 * 1000,
  ciMs: 15 * 60 * 1000,
  reviewMs: 15 * 60 * 1000,
  issueHardCapMs: 3 * 60 * 60 * 1000,
} as const;

export function loadState(path: string): HarnessState | null {
  if (!existsSync(path)) return null;
  // Trusted file written by saveState in a prior run. Skip schema validation
  // to keep the file forward-compatible across small additions to IssueState.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- harness-owned state file
  return JSON.parse(readFileSync(path, 'utf-8')) as HarnessState;
}

export function saveState(path: string, state: HarnessState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

export function recordError(
  issue: IssueState,
  message: string,
  transcriptPath?: string
): IssueState {
  return {
    ...issue,
    status: 'failed',
    lastError: {
      message,
      transcriptPath,
      at: new Date().toISOString(),
    },
  };
}

#!/usr/bin/env bun
/**
 * Agent harness — overnight runner for chains of dependent GitHub issues.
 *
 * Usage:
 *   agent-harness --issues 504,505,506
 *   agent-harness --issues 504,505,506 --max-rounds 3
 *   agent-harness --resume
 *   agent-harness --issues 504 --dry-run
 *
 * See README.md for design.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { claudeAvailable } from './lib/claude';
import {
  detectRepo,
  fetchAll,
  ghAuthOk,
  ghIssueView,
  gitStatusClean,
  type Repo,
} from './lib/git';
import { createLogger } from './lib/log';
import { runChain } from './runner';
import { ensureSession, tmuxAvailable } from './lib/tmux';
import { worktreePathForIssue } from './lib/worktree-setup';
import {
  DEFAULT_BUDGETS,
  loadState,
  saveState,
  type FailureMode,
  type HarnessState,
  type IssueState,
} from './lib/state';

type Args = {
  issues: number[];
  maxRounds: number;
  onFailure: FailureMode;
  dryRun: boolean;
  resume: boolean;
  baseRef: string;
  tmux: boolean;
};

const STATE_DIR = '.claude-harness';
const STATE_FILE = join(STATE_DIR, 'state.json');

function parseArgs(argv: string[]): Args {
  const issues: number[] = [];
  let maxRounds = 3;
  let onFailure: FailureMode = 'stop';
  let dryRun = false;
  let resume = false;
  let baseRef = process.env.CLAUDE_HARNESS_DEFAULT_BASE ?? 'main';
  let tmux = false;

  const requireValue = (flag: string, idx: number): string => {
    if (idx >= argv.length) {
      throw new Error(`${flag} requires a value`);
    }
    return argv[idx];
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--issues') {
      const list = requireValue('--issues', ++i);
      for (const part of list.split(',')) {
        const n = Number.parseInt(part.trim(), 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`Invalid issue number: ${part}`);
        }
        issues.push(n);
      }
    } else if (a === '--max-rounds') {
      maxRounds = Number.parseInt(requireValue('--max-rounds', ++i), 10);
    } else if (a === '--on-failure') {
      const v = requireValue('--on-failure', ++i);
      if (v !== 'stop' && v !== 'skip' && v !== 'prompt') {
        throw new Error(`--on-failure must be stop|skip|prompt, got: ${v}`);
      }
      onFailure = v;
    } else if (a === '--base') {
      baseRef = requireValue('--base', ++i);
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--resume') {
      resume = true;
    } else if (a === '--tmux') {
      tmux = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (!resume && issues.length === 0) {
    throw new Error('Provide --issues N,N,N or --resume');
  }
  return { issues, maxRounds, onFailure, dryRun, resume, baseRef, tmux };
}

function printHelp(): void {
  console.log(`agent-harness — overnight chain runner for dependent issues

Usage:
  agent-harness --issues 504,505,506
  agent-harness --resume
  agent-harness --issues 504 --dry-run

Options:
  --issues 504,505,506   Ordered list of issue numbers (required unless --resume)
  --resume               Resume the run recorded in .claude-harness/state.json
  --max-rounds N         Max review/fix rounds per PR (default: 3)
  --on-failure MODE      stop | skip | prompt (default: stop)
  --base REF             Base ref for the first issue's branch (default: main)
  --dry-run              Print the chain plan without spawning Claude
  --tmux                 Open a tmux session with one window per Claude run.
                         Attach from another terminal: tmux attach -t harness-<runId>
  --help                 Show this message
`);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function makeRunId(): string {
  // Compact sortable id; ULID would be nicer but adds a dep.
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rnd}`;
}

async function buildChainState(args: {
  issues: number[];
  repo: Repo;
  baseRef: string;
  maxRounds: number;
  onFailure: FailureMode;
  runId: string;
  runDir: string;
  cwd: string;
}): Promise<HarnessState> {
  const chain: IssueState[] = [];
  for (const [i, n] of args.issues.entries()) {
    const meta = await ghIssueView(n, args.repo);
    const slug = slugify(meta.title);
    const branch = `${String(n)}-${slug}`;
    const worktreePath = worktreePathForIssue(args.cwd, n);
    chain.push({
      issue: n,
      title: meta.title,
      slug,
      branch,
      baseRef: i === 0 ? args.baseRef : '__placeholder__',
      worktreePath,
      status: 'pending',
      rounds: 0,
      reviewRounds: 0,
    });
  }
  // Wire up baseRefs in a second pass so each points at the prior branch.
  for (let i = 1; i < chain.length; i++) {
    const cur = chain[i];
    const prev = chain[i - 1];
    if (cur && prev) cur.baseRef = prev.branch;
  }
  return {
    runId: args.runId,
    startedAt: new Date().toISOString(),
    config: {
      maxRounds: args.maxRounds,
      onFailure: args.onFailure,
      budgets: { ...DEFAULT_BUDGETS },
    },
    chain,
  };
}

async function preflight(repoRoot: string): Promise<void> {
  if (!(await claudeAvailable())) {
    throw new Error('`claude --version` failed. Install Claude Code CLI.');
  }
  if (!(await ghAuthOk())) {
    throw new Error('`gh auth status` failed. Run `gh auth login`.');
  }
  if (!(await gitStatusClean(repoRoot))) {
    throw new Error(
      'Working tree has uncommitted changes. Commit or stash before running.'
    );
  }
}

function summarizePlan(state: HarnessState): string {
  const lines: string[] = [
    `Run ID: ${state.runId}`,
    `Issues: ${state.chain.length}`,
    `Max rounds: ${state.config.maxRounds}`,
    `On failure: ${state.config.onFailure}`,
    '',
    'Chain plan:',
  ];
  for (const [i, s] of state.chain.entries()) {
    lines.push(`  ${String(i + 1)}. #${String(s.issue)} "${s.title}"`);
    lines.push(`       branch: ${s.branch}`);
    lines.push(`       base:   ${s.baseRef}`);
    lines.push(`       wt:     ${s.worktreePath}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = cwd;

  await preflight(repoRoot);
  const repo = await detectRepo(repoRoot);
  await fetchAll(repoRoot);

  const statePath = join(repoRoot, STATE_FILE);
  let state: HarnessState | null = null;

  if (args.resume) {
    state = loadState(statePath);
    if (!state) {
      throw new Error(
        `--resume specified but no state at ${statePath}. Run without --resume first.`
      );
    }
    // Failed issues are reset to pending with rounds=0. Otherwise resume sees
    // `rounds === maxRounds` and short-circuits straight to "max rounds
    // exhausted" without ever spawning the engineer.
    let resetCount = 0;
    for (const issue of state.chain) {
      if (issue.status === 'failed') {
        issue.status = 'pending';
        issue.rounds = 0;
        delete issue.lastError;
        resetCount++;
      }
    }
    if (resetCount > 0) {
      saveState(statePath, state);
    }
    console.log(
      `Resuming run ${state.runId} (${state.chain.length} issues${resetCount > 0 ? `, reset ${resetCount} failed` : ''})`
    );
  } else {
    if (existsSync(statePath)) {
      throw new Error(
        `State already exists at ${statePath}. Pass --resume to continue, or remove it to start fresh.`
      );
    }
    const runId = makeRunId();
    const runDir = join(repoRoot, STATE_DIR, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    state = await buildChainState({
      issues: args.issues,
      repo,
      baseRef: args.baseRef,
      maxRounds: args.maxRounds,
      onFailure: args.onFailure,
      runId,
      runDir,
      cwd: repoRoot,
    });
    saveState(statePath, state);
  }

  console.log('\n' + summarizePlan(state) + '\n');

  if (args.dryRun) {
    console.log('Dry run — exiting without spawning Claude.');
    return;
  }

  if (args.tmux) {
    if (!(await tmuxAvailable())) {
      throw new Error('--tmux requested but `tmux -V` failed. Install tmux.');
    }
    const session = `harness-${state.runId}`;
    await ensureSession(session);
    process.env.HARNESS_TMUX_SESSION = session;
    console.log(
      `tmux session ready. Attach from another terminal:\n  tmux attach -t ${session}\n`
    );
  }

  const runDir = join(repoRoot, STATE_DIR, 'runs', state.runId);
  const log = createLogger(join(runDir, 'events.jsonl'), {
    runId: state.runId,
  });

  log.info('chain.start', {
    issues: state.chain.map((s) => s.issue),
    repo: `${repo.owner}/${repo.name}`,
  });

  const final = await runChain({
    state,
    statePath,
    repo,
    repoRoot,
    runDir,
    log,
  });

  // Print final summary.
  console.log('\n=== Final ===');
  for (const s of final.chain) {
    const pr = s.prNumber ? `PR #${String(s.prNumber)}` : 'no PR';
    console.log(`  #${String(s.issue)} → ${s.status} (${pr})`);
    if (s.lastError) {
      console.log(`     error: ${s.lastError.message}`);
    }
  }

  const allDone = final.chain.every((s) => s.status === 'done');
  process.exit(allDone ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});

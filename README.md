# agent-harness

Overnight runner for chains of dependent GitHub issues. Spawns Claude Code to drive each issue from "no work done" to "PR is merge-ready" via stacked PRs, gating on CI and an independent reviewer pass.

Built on the [Ralph Wiggum](https://ghuntley.com/ralph/) loop pattern: per issue, the harness runs a single tight loop where Claude reads the world (branch state, PR status, CI checks, unaddressed review comments) each iteration and decides what to do next — implement, fix CI, address review feedback, or declare done. State lives in git/GitHub, not in a 12-state machine.

## Usage

```bash
# Run a chain of dependent issues
bunx github:tombeckenham/agent-harness --issues 504,505,506

# Preview the chain plan without spawning Claude
bunx github:tombeckenham/agent-harness --issues 504,505,506 --dry-run

# Resume a crashed run
bunx github:tombeckenham/agent-harness --resume

# Tweak knobs
bunx github:tombeckenham/agent-harness --issues 504,505 --max-rounds 2 --on-failure stop

# Open a tmux session that streams each Claude run live
bunx github:tombeckenham/agent-harness --issues 504 --tmux
# Then attach: tmux attach -t harness-<runId>
```

Or clone and link:

```bash
git clone https://github.com/tombeckenham/agent-harness ~/code/agent-harness
cd ~/code/agent-harness && bun install && bun link
# Then in any GitHub repo:
agent-harness --issues 504,505
```

## Pre-requisites

Run from the root of any GitHub repo with these tools installed:

- [`claude`](https://docs.claude.com/en/docs/claude-code/cli-reference) CLI installed and logged in (`claude --version` works). The harness uses your existing OAuth session — no `ANTHROPIC_API_KEY` needed.
- [`gh`](https://cli.github.com/) CLI authenticated (`gh auth status` clean).
- `git`, `bun`, and (optionally) `tmux`.
- Working tree clean and on `main` (or pass `--base <ref>`).

## How it works

For each issue in the chain:

1. **Prepare branch.** Creates `<issue>-<slug>` in a dedicated git worktree off the previous PR's branch (or `main` for the first).
2. **Engineer loop (ralphy).** Up to `--max-rounds` iterations of:
   - **Snapshot** the world: commits since base, PR existence, CI status, unaddressed review comments.
   - **Engineer step.** Spawn one Claude session with the unified `engineer.md` prompt and the snapshot. The agent reads it and decides what to do (implement, fix CI, address review). Commits land on the worktree branch.
   - **Push + open PR** if commits exist and there's no PR yet.
   - **Verdict.** The agent ends with `{status: "continue"|"done"|"blocked"}`. `continue` loops back; `done` triggers a reviewer pass; `blocked` aborts the issue.
3. **Reviewer pass** (separate Claude in clean read-only worktree at the PR head): runs the `/review` skill, posts a consolidated review, emits a `clean`/`needs_changes` verdict.
   - `clean` → issue is `done`.
   - `needs_changes` → next engineer iteration sees the new comments in its snapshot and addresses them.
4. **Done.** Sets the next issue's `baseRef` to this PR's branch and continues the chain.

Stacked-PR mechanic: each PR's base is the previous PR's branch. Squash-merging the parent (with "delete branch on merge" enabled) auto-retargets the child to `main`.

## State

Everything lives under `.claude-harness/` in the repo where you ran the harness (gitignore it):

- `runs/<runId>/state.json` — chain state for that run; pass `--resume <runId>` to continue.
- `runs/<runId>/events.jsonl` — structured event log.
- `runs/<runId>/issue-<N>/transcripts/{engineer-N,review-N}.jsonl` — full Claude stream-JSON transcripts for debugging.
- `runs/<runId>/worktrees/issue-<N>/` — git worktree dedicated to the issue.

Multiple runs can coexist — kick off a new harness on a different set of issues and it gets its own `runId`. (Worktrees are keyed per-issue, so don't run two concurrent harnesses on the same issue number.)

## Failure modes

- `--on-failure stop` (default) — chain halts on the first failed issue.
- `--on-failure skip` — continue with the next issue (rarely useful for true dependency chains).
- `--on-failure prompt` — same as `stop` for unattended runs (no TTY to prompt).

Time budgets per phase (configurable in `lib/state.ts` `DEFAULT_BUDGETS`):

- Engineer step: 45 min
- CI poll: 15 min
- Reviewer pass: 15 min
- Issue hard cap: 3 hours

## Risks worth knowing

- **OAuth token expiry mid-run** — pre-flight check + transcript will surface auth errors; rerun with `--resume`.
- **Concurrent commits to `main`** by other contributors break the stacked chain's mergeability — harness pins `baseRef` at branch creation only.
- **Reviewer ↔ engineer ping-pong** is hard-capped by `--max-rounds`. If the reviewer fails to emit verdict JSON, the round is treated as `clean`.
- **`@claude` workflow collision** — harness adds a `harness-active` label and the engineer prompt forbids `@`-mentioning Claude; teammates should avoid driving the same PR overnight.

## Development

```bash
bun install
bun typecheck     # tsgo --noEmit
bun test          # bun test (unit tests for git utilities)
```

## License

MIT — see `LICENSE`.

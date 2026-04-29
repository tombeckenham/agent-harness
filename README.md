# Agent Harness

Overnight runner for chains of dependent GitHub issues. Spawns Claude Code to implement each issue in order, opens a stacked PR, gates on CI, runs a `/review` reviewer pass, and loops review→fix until clean or `--max-rounds` is reached.

## Usage

```bash
# Start a fresh run
bun agent-harness --issues 504,505,506

# Preview the chain plan without spawning Claude
bun agent-harness --issues 504,505,506 --dry-run

# Resume a crashed run
bun agent-harness --resume

# Tweak knobs
bun agent-harness --issues 504,505 --max-rounds 2 --on-failure stop
```

## Pre-requisites

- `claude` CLI installed and logged in (`claude --version` works).
- `gh` CLI authenticated (`gh auth status` clean).
- Working tree clean and on `main` (or pass `--base <ref>`).
- `lefthook.yml` present at repo root.

No `ANTHROPIC_API_KEY` needed — the CLI uses your existing OAuth session.

## What it does, per issue

1. **Implement** — creates `<issue>-<slug>` branch in a dedicated worktree off the previous PR's branch (or `main` for the first), spawns Claude with the implement prompt, verifies commits, pushes, opens a stacked PR.
2. **CI gate** — polls `gh pr checks` until green/red. CI failures feed the fix loop.
3. **Review** — spawns a second Claude in a clean read-only worktree at the PR head, runs the `/review` skill, parses a verdict JSON.
4. **Fix** — if `needs_changes`, spawns Claude with review comments + CI failures, commits a `fix:` commit, pushes.
5. **Loop** — repeats review→fix up to `--max-rounds` (default 3).
6. **Done** — sets the next issue's `baseRef` to this PR's branch and continues.

## State

Everything lives under `.claude-harness/` (gitignored):

- `state.json` — chain state, idempotent on `--resume`.
- `runs/<runId>/events.jsonl` — structured event log.
- `runs/<runId>/issue-<N>/transcripts/{implement,review-N,fix-N}.jsonl` — full Claude stream-JSON transcripts for debugging.
- `runs/<runId>/worktrees/issue-<N>/` — git worktree dedicated to the issue.

## Stacked PR mechanics

- Each PR's base = previous PR's branch.
- Squash-merging the first PR (with "delete branch on merge" enabled) auto-retargets the next PR's base to `main` — no manual rebase needed.
- If you don't squash-merge, the chain may need rebases. Document this with your reviewers.

## Failure modes

- `--on-failure stop` (default) — chain halts on the first failed issue.
- `--on-failure skip` — continue with the next issue (rarely useful for true dependency chains).
- `--on-failure prompt` — same as `stop` for unattended runs (no TTY to prompt).

Time budgets per phase (configurable in `lib/state.ts` `DEFAULT_BUDGETS`):

- Implement: 45 min
- CI poll: 15 min
- Review: 15 min
- Fix per round: 30 min
- Issue hard cap: 3 hours

## Risks worth knowing

- **OAuth token expiry mid-run** — pre-flight check + transcript will surface auth errors; rerun with `--resume`.
- **Concurrent commits to `main`** by other contributors break the stacked chain's mergeability — harness pins `baseRef` at branch creation only.
- **Reviewer ↔ fixer ping-pong** is hard-capped by `--max-rounds`. If the reviewer fails to emit verdict JSON, the round is treated as `clean`.
- **`@claude` workflow collision** — harness adds a `harness-active` label and the reviewer prompt forbids `@`-mentioning Claude; teammates should avoid driving the same PR overnight.

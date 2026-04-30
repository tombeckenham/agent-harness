import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { run } from './git';
import type { Logger } from './log';
import { openWindow, sanitizeWindowName } from './tmux';

export type ClaudeRunOpts = {
  prompt: string;
  cwd: string;
  transcriptPath: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  model?: string;
  signal?: AbortSignal;
  log: Logger;
};

export type ClaudeRunResult = {
  exitCode: number;
  durationMs: number;
  lastAssistantText: string;
  resultEvent: ClaudeStreamEvent | null;
  toolUseCount: number;
  abortedForTimeout: boolean;
};

type ClaudeContentPart = {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
};

type ClaudeStreamEvent =
  | { type: 'system'; subtype?: string }
  | {
      type: 'assistant';
      message: { content: ClaudeContentPart[] };
    }
  | { type: 'user'; message: { content: unknown } }
  | { type: 'result'; subtype?: string; is_error?: boolean; result?: string };

function isClaudeStreamEvent(value: unknown): value is ClaudeStreamEvent {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === 'system' || t === 'assistant' || t === 'user' || t === 'result';
}

function lastTextFromAssistant(event: ClaudeStreamEvent): string | null {
  if (event.type !== 'assistant') return null;
  const parts = event.message.content;
  const texts: string[] = [];
  for (const p of parts) {
    if (p.type === 'text' && typeof p.text === 'string') texts.push(p.text);
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

function snippet(text: string, max = 140): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function summarizeToolInput(part: ClaudeContentPart): string {
  const input = part.input;
  if (!input) return '';
  // Pick the most informative single field per tool, fall back to the first key.
  const preferred = ['command', 'file_path', 'path', 'pattern', 'description'];
  for (const key of preferred) {
    const v = input[key];
    if (typeof v === 'string' && v.length > 0) return snippet(v, 100);
  }
  const firstKey = Object.keys(input)[0];
  if (firstKey === undefined) return '';
  const v = input[firstKey];
  return typeof v === 'string' ? snippet(v, 100) : `${firstKey}=…`;
}

type StreamState = {
  lastAssistantText: string;
  resultEvent: ClaudeStreamEvent | null;
  toolUseCount: number;
};

function processLine(line: string, state: StreamState, log: Logger): void {
  if (line.trim().length === 0) return;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  if (!isClaudeStreamEvent(raw)) return;
  const evt = raw;
  if (evt.type === 'assistant') {
    const text = lastTextFromAssistant(evt);
    if (text) {
      state.lastAssistantText = text;
      log.info('claude.text', { snippet: snippet(text) });
    }
    for (const part of evt.message.content) {
      if (part.type === 'tool_use') {
        state.toolUseCount++;
        log.info('claude.tool', {
          tool: part.name ?? '(unknown)',
          arg: summarizeToolInput(part),
        });
      }
    }
  } else if (evt.type === 'result') {
    state.resultEvent = evt;
  }
}

function shellQuote(s: string): string {
  // Single-quote-safe shell escape for paths and inline strings.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildClaudeArgs(opts: ClaudeRunOpts): string[] {
  const args = [
    'claude',
    '-p',
    opts.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    opts.permissionMode ?? 'acceptEdits',
  ];
  if (opts.allowedTools?.length) {
    args.push('--allowedTools', opts.allowedTools.join(','));
  }
  if (opts.disallowedTools?.length) {
    args.push('--disallowedTools', opts.disallowedTools.join(','));
  }
  if (opts.model) {
    args.push('--model', opts.model);
  }
  return args;
}

function logSpawn(log: Logger, args: string[], cwd: string, mode: string): void {
  // Skip the prompt body (args[2]) so logs stay readable.
  log.info('claude.spawn', {
    mode,
    cmd: [args[0], ...args.slice(3)],
    cwd,
  });
}

export async function runClaude(opts: ClaudeRunOpts): Promise<ClaudeRunResult> {
  mkdirSync(dirname(opts.transcriptPath), { recursive: true });
  const args = buildClaudeArgs(opts);
  const session = process.env.HARNESS_TMUX_SESSION;
  return session
    ? runClaudeInTmux(opts, args, session)
    : runClaudeDirect(opts, args);
}

async function runClaudeDirect(
  opts: ClaudeRunOpts,
  args: string[]
): Promise<ClaudeRunResult> {
  logSpawn(opts.log, args, opts.cwd, 'direct');

  const startedAt = Date.now();
  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    signal: opts.signal,
  });

  const state: StreamState = {
    lastAssistantText: '',
    resultEvent: null,
    toolUseCount: 0,
  };
  let buf = '';

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();

  try {
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- exits via break on stream done
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length > 0) {
          appendFileSync(opts.transcriptPath, `${line}\n`);
          processLine(line, state, opts.log);
        }
        nl = buf.indexOf('\n');
      }
    }
  } catch (err) {
    opts.log.warn('claude.stream.error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Flush stderr to transcript for debugging.
  const stderr = await new Response(proc.stderr).text();
  if (stderr.trim().length > 0) {
    appendFileSync(opts.transcriptPath, `--- stderr ---\n${stderr}\n`);
  }

  const exitCode = await proc.exited;
  const durationMs = Date.now() - startedAt;
  const abortedForTimeout = opts.signal?.aborted ?? false;

  opts.log.info('claude.exit', {
    exitCode,
    durationMs,
    toolUseCount: state.toolUseCount,
    abortedForTimeout,
  });

  return {
    exitCode,
    durationMs,
    lastAssistantText: state.lastAssistantText,
    resultEvent: state.resultEvent,
    toolUseCount: state.toolUseCount,
    abortedForTimeout,
  };
}

const TAIL_POLL_MS = 200;

async function runClaudeInTmux(
  opts: ClaudeRunOpts,
  args: string[],
  session: string
): Promise<ClaudeRunResult> {
  const absTranscript = resolve(opts.transcriptPath);
  const exitPath = `${absTranscript}.exit`;
  const promptPath = `${absTranscript}.prompt`;

  // Clear any leftover artifacts from a prior run with the same path.
  for (const p of [absTranscript, exitPath]) {
    if (existsSync(p)) unlinkSync(p);
  }
  // Touch transcript so the tail loop can open it immediately.
  writeFileSync(absTranscript, '');
  writeFileSync(promptPath, opts.prompt);

  // Window name from `<issueDir>-<phaseN>` so each run gets a distinct window.
  const issueDir = basename(dirname(dirname(absTranscript)));
  const file = basename(absTranscript, '.jsonl');
  const window = sanitizeWindowName(`${issueDir}-${file}`);
  const viewerScript = resolve(join(import.meta.dir, '..', 'lib', 'viewer.ts'));

  // Build the claude argv with the prompt sourced from the temp file at run
  // time. argv[2] in the harness's `args` array is the prompt body — replace
  // it with a shell substitution so we never quote the entire prompt inline.
  const claudeArgv = args
    .map((a, i) =>
      i === 2 ? `"$PROMPT"` : i === 0 ? a : shellQuote(a)
    )
    .join(' ');

  const script = [
    `set -u`,
    `cd ${shellQuote(opts.cwd)}`,
    `PROMPT="$(cat ${shellQuote(promptPath)})"`,
    // Run claude detached, tee its output to the transcript so the viewer can
    // render it. `${claudeArgv}` writes stream-json to stdout; tee fans it
    // into the file. Capture exit via the pipefail trick.
    `(`,
    `  set -o pipefail`,
    `  ${claudeArgv} 2>>${shellQuote(`${absTranscript}.stderr`)} | tee -a ${shellQuote(absTranscript)} >/dev/null`,
    `  echo "$?" > ${shellQuote(exitPath)}`,
    `) &`,
    `claude_pid=$!`,
    // Foreground: the prettified viewer is what the user sees when attached.
    // It exits when killed; we kill it once claude finishes so the window can
    // print a final banner before idling for keypress.
    `bun ${shellQuote(viewerScript)} ${shellQuote(absTranscript)} &`,
    `viewer_pid=$!`,
    `wait "$claude_pid"`,
    `kill "$viewer_pid" 2>/dev/null || true`,
    `ec="$(cat ${shellQuote(exitPath)} 2>/dev/null || echo unknown)"`,
    `printf '\\n[claude exited %s — press any key to close]' "$ec"`,
    `read _`,
  ].join('\n');

  logSpawn(opts.log, args, opts.cwd, 'tmux');
  opts.log.info('claude.tmux-window', {
    session,
    window,
    transcript: absTranscript,
  });

  const startedAt = Date.now();
  await openWindow({ session, window, command: `bash -c ${shellQuote(script)}` });

  const tailResult = await tailTranscriptForExit({
    transcriptPath: absTranscript,
    exitPath,
    session,
    window,
    log: opts.log,
    signal: opts.signal,
  });

  const durationMs = Date.now() - startedAt;
  const abortedForTimeout = opts.signal?.aborted ?? false;

  // Append captured stderr to the transcript for debugging parity with the
  // direct path. Best-effort; missing file is fine.
  const stderrPath = `${absTranscript}.stderr`;
  if (existsSync(stderrPath)) {
    const stderr = readFileSync(stderrPath, 'utf8');
    if (stderr.trim().length > 0) {
      appendFileSync(absTranscript, `--- stderr ---\n${stderr}\n`);
    }
    try {
      unlinkSync(stderrPath);
    } catch {
      // best-effort cleanup
    }
  }
  try {
    unlinkSync(promptPath);
  } catch {
    // best-effort cleanup
  }

  opts.log.info('claude.exit', {
    exitCode: tailResult.exitCode,
    durationMs,
    toolUseCount: tailResult.state.toolUseCount,
    abortedForTimeout,
  });

  return {
    exitCode: tailResult.exitCode,
    durationMs,
    lastAssistantText: tailResult.state.lastAssistantText,
    resultEvent: tailResult.state.resultEvent,
    toolUseCount: tailResult.state.toolUseCount,
    abortedForTimeout,
  };
}

async function tailTranscriptForExit(args: {
  transcriptPath: string;
  exitPath: string;
  session: string;
  window: string;
  log: Logger;
  signal?: AbortSignal;
}): Promise<{ exitCode: number; state: StreamState }> {
  const state: StreamState = {
    lastAssistantText: '',
    resultEvent: null,
    toolUseCount: 0,
  };
  let pos = 0;
  let buf = '';

  const drainNew = async (): Promise<void> => {
    let size: number;
    try {
      size = statSync(args.transcriptPath).size;
    } catch {
      return;
    }
    if (size <= pos) return;
    const fh = await open(args.transcriptPath, 'r');
    try {
      const chunk = Buffer.alloc(size - pos);
      await fh.read(chunk, 0, chunk.length, pos);
      buf += chunk.toString('utf8');
      pos = size;
    } finally {
      await fh.close();
    }
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      processLine(buf.slice(0, nl), state, args.log);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
  };

  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
  };
  args.signal?.addEventListener('abort', onAbort);

  try {
    for (;;) {
      await drainNew();
      if (existsSync(args.exitPath)) {
        await drainNew();
        const raw = readFileSync(args.exitPath, 'utf8').trim();
        const exitCode = /^\d+$/.test(raw) ? Number(raw) : 1;
        return { exitCode, state };
      }
      if (aborted) {
        // Tear down the tmux window so the abandoned claude process stops.
        await run(['tmux', 'kill-window', '-t', `${args.session}:${args.window}`]);
        await drainNew();
        return { exitCode: 130, state };
      }
      await new Promise<void>((res) => setTimeout(res, TAIL_POLL_MS));
    }
  } finally {
    args.signal?.removeEventListener('abort', onAbort);
  }
}

export function extractFencedJson<T>(
  text: string,
  validate: (value: unknown) => value is T
): T | null {
  // Match the LAST ```json ... ``` block in the text.
  const re = /```json\s*([\s\S]*?)```/g;
  let last: string | null = null;
  for (const m of text.matchAll(re)) {
    last = m[1];
  }
  if (last === null) return null;
  try {
    const parsed: unknown = JSON.parse(last.trim());
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export type ReviewVerdictJson = {
  verdict: 'clean' | 'needs_changes';
  blockingCount?: number;
  summary?: string;
};

export function isReviewVerdict(v: unknown): v is ReviewVerdictJson {
  if (typeof v !== 'object' || v === null) return false;
  const verdict = (v as { verdict?: unknown }).verdict;
  return verdict === 'clean' || verdict === 'needs_changes';
}

export async function claudeAvailable(): Promise<boolean> {
  const proc = Bun.spawn(['claude', '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return (await proc.exited) === 0;
}

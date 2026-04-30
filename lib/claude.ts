import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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

async function maybeOpenTmuxViewer(
  transcriptPath: string,
  log: Logger
): Promise<void> {
  const session = process.env.HARNESS_TMUX_SESSION;
  if (!session) return;
  const absTranscript = resolve(transcriptPath);
  // Window name from `<issueDir>-<phaseN>` so each run gets a distinct window.
  // e.g. transcripts/implement-1.jsonl in issue-615/ → "issue-615-implement-1"
  const issueDir = basename(dirname(dirname(absTranscript)));
  const file = basename(absTranscript, '.jsonl');
  const window = sanitizeWindowName(`${issueDir}-${file}`);
  const viewerScript = resolve(join(import.meta.dir, '..', 'lib', 'viewer.ts'));
  // Quote both args defensively in case the run dir contains spaces.
  const command = `bun ${shellQuote(viewerScript)} ${shellQuote(absTranscript)}`;
  try {
    await openWindow({ session, window, command });
    log.info('tmux.window-opened', { session, window });
  } catch (err) {
    // tmux is a viewer convenience — never let a tmux failure abort a Claude run.
    log.warn('tmux.window-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function shellQuote(s: string): string {
  // Single-quote-safe shell escape for paths.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function runClaude(opts: ClaudeRunOpts): Promise<ClaudeRunResult> {
  mkdirSync(dirname(opts.transcriptPath), { recursive: true });
  await maybeOpenTmuxViewer(opts.transcriptPath, opts.log);

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

  opts.log.info('claude.spawn', {
    cmd: args
      .slice(0, 1)
      .concat(args.slice(2).filter((a) => a !== opts.prompt)),
    cwd: opts.cwd,
  });

  const startedAt = Date.now();
  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    signal: opts.signal,
  });

  let lastAssistantText = '';
  let resultEvent: ClaudeStreamEvent | null = null;
  let toolUseCount = 0;
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
          try {
            const raw: unknown = JSON.parse(line);
            if (!isClaudeStreamEvent(raw)) continue;
            const evt = raw;
            if (evt.type === 'assistant') {
              const text = lastTextFromAssistant(evt);
              if (text) {
                lastAssistantText = text;
                opts.log.info('claude.text', { snippet: snippet(text) });
              }
              for (const part of evt.message.content) {
                if (part.type === 'tool_use') {
                  toolUseCount++;
                  opts.log.info('claude.tool', {
                    tool: part.name ?? '(unknown)',
                    arg: summarizeToolInput(part),
                  });
                }
              }
            } else if (evt.type === 'result') {
              resultEvent = evt;
            }
          } catch {
            // Non-JSON line; already persisted to transcript.
          }
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
    toolUseCount,
    abortedForTimeout,
  });

  return {
    exitCode,
    durationMs,
    lastAssistantText,
    resultEvent,
    toolUseCount,
    abortedForTimeout,
  };
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

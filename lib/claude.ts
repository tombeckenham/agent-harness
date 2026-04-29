import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from './log';

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

type ClaudeStreamEvent =
  | { type: 'system'; subtype?: string }
  | {
      type: 'assistant';
      message: { content: Array<{ type: string; text?: string }> };
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

export async function runClaude(opts: ClaudeRunOpts): Promise<ClaudeRunResult> {
  mkdirSync(dirname(opts.transcriptPath), { recursive: true });

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
              if (text) lastAssistantText = text;
              for (const part of evt.message.content) {
                if (part.type === 'tool_use') toolUseCount++;
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

export type ImplementVerdict = {
  status: 'done' | 'blocked';
  reason?: string;
  summary?: string;
};

export function isImplementVerdict(v: unknown): v is ImplementVerdict {
  if (typeof v !== 'object' || v === null) return false;
  const status = (v as { status?: unknown }).status;
  return status === 'done' || status === 'blocked';
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

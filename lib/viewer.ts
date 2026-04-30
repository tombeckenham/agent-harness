/**
 * Live viewer for a Claude stream-json transcript. Designed to be run inside
 * a tmux window the harness opens for each Claude subprocess:
 *
 *   bun /path/to/agent-harness/lib/viewer.ts <transcript-path>
 *
 * Polls the file (works even before it's been created), parses each new line
 * as a stream-json event, and prints a colorized human-readable summary.
 */

import { existsSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';

const POLL_MS = 250;

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
} as const;

type ContentPart = {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
};

type StreamEvent =
  | { type: 'system'; subtype?: string }
  | { type: 'assistant'; message: { content: ContentPart[] } }
  | { type: 'user'; message: { content: unknown } }
  | { type: 'result'; subtype?: string; is_error?: boolean; result?: string };

function isStreamEvent(v: unknown): v is StreamEvent {
  if (typeof v !== 'object' || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return t === 'system' || t === 'assistant' || t === 'user' || t === 'result';
}

function snippet(s: string, max = 200): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function summarizeInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const preferred = ['command', 'file_path', 'path', 'pattern', 'description'];
  for (const k of preferred) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) return snippet(v, 160);
  }
  const k = Object.keys(input)[0];
  if (k === undefined) return '';
  const v = input[k];
  return typeof v === 'string' ? snippet(v, 160) : `${k}=…`;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function renderLine(raw: string): void {
  if (raw.length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stdout.write(`${C.dim}${raw}${C.reset}\n`);
    return;
  }
  if (!isStreamEvent(parsed)) return;
  const ts = `${C.dim}[${timestamp()}]${C.reset}`;

  if (parsed.type === 'system') {
    const sub = parsed.subtype ? `:${parsed.subtype}` : '';
    process.stdout.write(`${ts} ${C.dim}system${sub}${C.reset}\n`);
    return;
  }

  if (parsed.type === 'assistant') {
    for (const part of parsed.message.content) {
      if (part.type === 'text' && typeof part.text === 'string') {
        const text = snippet(part.text, 240);
        process.stdout.write(`${ts} ${C.green}claude${C.reset} ${text}\n`);
      } else if (part.type === 'tool_use') {
        const name = part.name ?? '(unknown)';
        const arg = summarizeInput(part.input);
        process.stdout.write(
          `${ts} ${C.yellow}tool${C.reset}   ${C.bold}${name}${C.reset} ${C.dim}${arg}${C.reset}\n`
        );
      }
    }
    return;
  }

  if (parsed.type === 'user') {
    // Tool results — usually noisy. Show a tiny marker.
    process.stdout.write(`${ts} ${C.cyan}↩ tool-result${C.reset}\n`);
    return;
  }

  if (parsed.type === 'result') {
    const ok = parsed.is_error !== true;
    const color = ok ? C.green : C.red;
    const label = ok ? 'DONE' : 'ERROR';
    const detail = parsed.result ? ` ${snippet(parsed.result, 200)}` : '';
    process.stdout.write(
      `${ts} ${C.bold}${color}${label}${C.reset}${detail}\n`
    );
  }
}

async function tailFile(path: string): Promise<void> {
  process.stdout.write(`${C.dim}viewer: waiting for ${path}…${C.reset}\n`);
  while (!existsSync(path)) {
    await Bun.sleep(POLL_MS);
  }
  process.stdout.write(`${C.dim}viewer: streaming ${path}${C.reset}\n`);

  let pos = 0;
  let buf = '';
  for (;;) {
    const size = statSync(path).size;
    if (size < pos) {
      // File truncated/replaced — restart from top.
      pos = 0;
      buf = '';
    }
    if (size > pos) {
      const fh = await open(path, 'r');
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
        renderLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    }
    await Bun.sleep(POLL_MS);
  }
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write('usage: viewer.ts <transcript-path>\n');
    process.exit(2);
  }
  await tailFile(path);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`viewer error: ${msg}\n`);
  process.exit(1);
});

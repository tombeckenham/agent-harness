import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

type LogContext = Record<string, unknown> & {
  issue?: number;
  phase?: string;
  runId?: string;
};

export type Logger = {
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
  debug: (msg: string, data?: Record<string, unknown>) => void;
  child: (extra: LogContext) => Logger;
};

function format(prefix: string, msg: string): string {
  const t = new Date().toISOString().slice(11, 19);
  return `[${t}] ${prefix} ${msg}`;
}

export function createLogger(
  jsonlPath: string,
  context: LogContext = {}
): Logger {
  mkdirSync(dirname(jsonlPath), { recursive: true });

  const write = (
    level: LogLevel,
    msg: string,
    data?: Record<string, unknown>
  ): void => {
    const entry = {
      at: new Date().toISOString(),
      level,
      msg,
      ...context,
      ...data,
    };
    appendFileSync(jsonlPath, `${JSON.stringify(entry)}\n`);

    const issue =
      typeof context.issue === 'number' ? `#${String(context.issue)}` : '';
    const phase = typeof context.phase === 'string' ? `[${context.phase}]` : '';
    const prefix = [phase, issue].filter(Boolean).join(' ');
    const line = format(prefix, msg);

    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else if (level === 'debug') {
      if (process.env.HARNESS_DEBUG) console.log(line);
    } else console.log(line);
  };

  return {
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
    debug: (msg, data) => write('debug', msg, data),
    child: (extra) => createLogger(jsonlPath, { ...context, ...extra }),
  };
}

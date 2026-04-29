import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATE_DIR = join(import.meta.dir, '..', 'prompts');

function load(name: string): string {
  return readFileSync(join(TEMPLATE_DIR, name), 'utf-8');
}

function render(
  template: string,
  vars: Record<string, string | number>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) {
      throw new Error(`Missing template variable: ${key}`);
    }
    return String(vars[key]);
  });
}

export type ImplementVars = {
  issue: number;
  title: string;
  body: string;
  repo: string;
  cwd: string;
  branch: string;
  baseRef: string;
  prevPrSummary: string;
  budgetMinutes: number;
};

export function buildImplementPrompt(vars: ImplementVars): string {
  return render(load('implement.md'), vars);
}

export type ReviewVars = {
  repo: string;
  pr: number;
  branch: string;
  baseRef: string;
  issue: number;
  title: string;
  cwd: string;
  round: number;
  maxRounds: number;
};

export function buildReviewPrompt(vars: ReviewVars): string {
  return render(load('review.md'), vars);
}

export type FixVars = {
  repo: string;
  pr: number;
  issue: number;
  title: string;
  branch: string;
  cwd: string;
  round: number;
  maxRounds: number;
  reviewBlock: string;
  ciBlock: string;
  ciLogPath: string;
  budgetMinutes: number;
};

export function buildFixPrompt(vars: FixVars): string {
  return render(load('fix.md'), vars);
}

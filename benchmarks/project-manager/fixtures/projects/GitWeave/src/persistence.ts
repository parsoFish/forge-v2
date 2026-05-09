import { writeFileSync } from 'node:fs';

export function persistResult(pr: number, status: string): void {
  writeFileSync(`./results/PR-${pr}.json`, JSON.stringify({ pr, status }));
}

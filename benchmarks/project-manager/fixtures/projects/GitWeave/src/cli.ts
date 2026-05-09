import { runStages } from './runner.ts';

const args = process.argv.slice(2);
const prNumbers = args
  .filter((a) => /^\d+$/.test(a))
  .map((a) => Number(a));

await runStages({ prNumbers, retryLimit: 3 });

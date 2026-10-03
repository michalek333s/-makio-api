/**
 * Tréninkové kolo: warm → eval → feedback z failů.
 * node scripts/train-round.mjs
 */
import '../src/loadEnv.js';
import { storeAiFeedback } from '../src/services/aiFeedback.js';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function run(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      out += s;
      process.stderr.write(s);
    });
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function main() {
  console.log('=== TRAIN ROUND: seed ===\n');
  await run('scripts/seed-locality-profiles.mjs');

  console.log('\n=== TRAIN ROUND: warm ===\n');
  const warm = await run('scripts/warm-geopas-cache.mjs');

  console.log('\n=== TRAIN ROUND: eval ===\n');
  const ev = await run('scripts/eval-makio-accuracy.mjs');

  const failLines = [...warm.out.split('\n'), ...ev.out.split('\n')].filter((l) =>
    l.includes('❌'),
  );

  for (const line of failLines.slice(0, 20)) {
    await storeAiFeedback({
      input: line.slice(0, 500),
      aiOutput: 'train-round failure',
      feedbackType: 'property',
      meta: { rating: 'down', source: 'train-round' },
    });
  }

  const score = (ev.out.match(/SCORE\s+(\d+)\/(\d+)/) || [])[0] || 'n/a';
  console.log(`\n=== TRAIN ROUND DONE — ${score} | fails logged: ${failLines.length} ===`);
  process.exit(ev.code === 0 && warm.code === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

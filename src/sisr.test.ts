/**
 * Self-check for the incremental bookkeeping.
 *
 * The search maintains per-route cost, per-route load and a customer→route index by
 * hand, and rolls all three back from an undo log. Every one of those is a silent
 * corruption when it goes wrong — the solver keeps running and reports a cost for a
 * solution that does not exist. This runs the real search on a real instance with
 * checking switched on, so a drift fails here instead of in a benchmark table.
 *
 * Run: node --experimental-strip-types src/sisr.test.ts <instance.vrp>
 */
import { readFileSync } from 'node:fs';
import { solve, type Problem } from './sisr.ts';

function parse(path: string): Problem {
  const text = readFileSync(path, 'utf8');
  const dimension = Number(/DIMENSION\s*:\s*(\d+)/.exec(text)![1]);
  const capacity = Number(/CAPACITY\s*:\s*(\d+)/.exec(text)![1]);
  const xs = new Float64Array(dimension);
  const ys = new Float64Array(dimension);
  const demands = new Int32Array(dimension);
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.split(/\s+/)[0].toUpperCase().replace(/:$/, '');
    if (head === 'NODE_COORD_SECTION' || head === 'DEMAND_SECTION' || head === 'DEPOT_SECTION') {
      section = head;
      continue;
    }
    if (head === 'EOF') break;
    const parts = line.split(/\s+/);
    if (section === 'NODE_COORD_SECTION') {
      xs[Number(parts[0]) - 1] = Number(parts[1]);
      ys[Number(parts[0]) - 1] = Number(parts[2]);
    } else if (section === 'DEMAND_SECTION') {
      demands[Number(parts[0]) - 1] = Number(parts[1]);
    }
  }
  const dist = new Int32Array(dimension * dimension);
  for (let i = 0; i < dimension; i++) {
    for (let j = i + 1; j < dimension; j++) {
      const dx = xs[i] - xs[j];
      const dy = ys[i] - ys[j];
      const d = Math.round(Math.sqrt(dx * dx + dy * dy));
      dist[i * dimension + j] = d;
      dist[j * dimension + i] = d;
    }
  }
  return { n: dimension, capacity, demands, dist, depot: 0 };
}

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const instancePath = process.argv[2] ?? 'instances/cvrp/X-n101-k25.vrp';
const p = parse(instancePath);

console.log(`sisr self-check on ${instancePath} (n=${p.n}, capacity=${p.capacity})`);

// The search itself asserts its invariants every `checkEvery` iterations when `debug`
// is on; anything inconsistent throws with the iteration number attached.
let threw: Error | null = null;
let result: ReturnType<typeof solve> | null = null;
try {
  result = solve(p, { seconds: 4, seed: 7, debug: true, checkEvery: 32 });
} catch (err) {
  threw = err as Error;
}

check('search completes with internal invariants holding', threw === null, threw?.message);

if (result) {
  // Independent scoring: recompute everything from the routes alone.
  const seen = new Set<number>();
  let recomputed = 0;
  let overloaded = 0;
  for (const route of result.routes) {
    let load = 0;
    let prev = p.depot;
    for (const c of route) {
      if (seen.has(c)) check('every customer visited at most once', false, `customer ${c} twice`);
      seen.add(c);
      load += p.demands[c];
      recomputed += p.dist[prev * p.n + c];
      prev = c;
    }
    recomputed += p.dist[prev * p.n + p.depot];
    if (load > p.capacity) overloaded++;
  }

  check('every customer visited exactly once', seen.size === p.n - 1, `${seen.size} of ${p.n - 1}`);
  check('no route exceeds capacity', overloaded === 0, `${overloaded} route(s) over`);
  check(
    'reported cost equals cost recomputed from the routes',
    recomputed === result.cost,
    `reported ${result.cost}, recomputed ${recomputed}`
  );
  check('the depot never appears inside a route', !result.routes.some((r) => r.includes(p.depot)));
  check('search actually iterated', result.iterations > 1000, `${result.iterations} iterations`);
  console.log(`  cost ${result.cost} over ${result.iterations.toLocaleString()} iterations`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

/**
 * CLI around the SISR solver. Reads a CVRPLIB .vrp, solves under a wall-clock budget and
 * prints one JSON line including the routes, so the Python validator can score it with
 * the same cost function every other solver is scored by.
 */
import { readFileSync } from 'node:fs';
import { solve, type Problem } from './sisr.ts';

function parse(path: string): Problem {
  const text = readFileSync(path, 'utf8');
  const dimension = Number(/DIMENSION\s*:\s*(\d+)/.exec(text)![1]);
  const capacity = Number(/CAPACITY\s*:\s*(\d+)/.exec(text)![1]);
  const edgeType = /EDGE_WEIGHT_TYPE\s*:\s*(\S+)/.exec(text);
  if (edgeType && edgeType[1] !== 'EUC_2D') {
    throw new Error(`only EUC_2D is supported, got ${edgeType[1]}`);
  }

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
    if (head === 'EOF') {
      section = '';
      continue;
    }
    const parts = line.split(/\s+/);
    if (section === 'NODE_COORD_SECTION') {
      const i = Number(parts[0]) - 1;
      xs[i] = Number(parts[1]);
      ys[i] = Number(parts[2]);
    } else if (section === 'DEMAND_SECTION') {
      demands[Number(parts[0]) - 1] = Number(parts[1]);
    }
  }

  // Same rounding rule as CVRPLIB EUC_2D, so costs are comparable to the published optima.
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

const args = process.argv.slice(2);
const instancePath = args[0];
const seconds = Number(args[args.indexOf('--seconds') + 1] ?? 10);
const seed = args.includes('--seed') ? Number(args[args.indexOf('--seed') + 1]) : 1;

function numArg(name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
}

const problem = parse(instancePath);
const result = solve(problem, {
  seconds,
  seed,
  initialTemperature: numArg('t0', 100),
  finalTemperature: numArg('t1', 1),
  avgRemoval: numArg('avg-removal', 10),
  maxStringLength: numArg('max-string', 10),
  blinkRate: numArg('blink', 0.01),
  neighbours: numArg('neighbours', 100),
});

process.stdout.write(
  JSON.stringify({
    solver: 'sisr-ts',
    instance: instancePath.split('/').pop()!.replace('.vrp', ''),
    n: problem.n,
    budget_s: seconds,
    seed,
    threads: 1,
    elapsed_s: Number((result.elapsedMs / 1000).toFixed(3)),
    reported_cost: result.cost,
    iterations: result.iterations,
    routes: result.routes.map((r) => Array.from(r)),
  }) + '\n'
);

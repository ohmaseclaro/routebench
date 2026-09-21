/**
 * CVRP solver: ruin-and-recreate by string removals (SISR), written from scratch.
 *
 * Follows Christiaens & Vanden Berghe, "Slack Induction by String Removals for Vehicle
 * Routing Problems" (Transportation Science, 2020). Three ideas do the work:
 *
 *   - ruin by removing short *strings* of consecutive customers from nearby routes,
 *     rather than scattered individual customers, so the destroyed part is spatially
 *     coherent and the repair has room to find a genuinely different shape;
 *   - repair by greedy cheapest insertion with "blinks" — each candidate position is
 *     skipped with small probability, which costs almost nothing and stops the repair
 *     from being deterministic enough to cycle;
 *   - accept worse solutions against a cooling threshold.
 *
 * Everything is incremental. A route carries its own cost, only ruined routes are
 * touched, and a rejected candidate is rolled back from a snapshot of just those routes
 * — so an iteration costs what was actually disturbed rather than O(n). The distance
 * matrix is a flat Int32Array (4 MB at n = 1000) and the neighbour lists are a flat
 * Int32Array of fixed width; neither is touched by the garbage collector during search.
 * Distances are integers because CVRPLIB's EUC_2D rounds to nearest, and the published
 * optima are integers under that rule.
 */

export interface Problem {
  n: number;
  capacity: number;
  demands: Int32Array;
  dist: Int32Array; // n * n, row-major
  depot: number;
}

export interface Options {
  seconds: number;
  seed?: number;
  /** Mean number of customers removed per iteration (paper: 10). */
  avgRemoval?: number;
  /** Longest string removed from one route (paper: 10). */
  maxStringLength?: number;
  /** Probability of skipping a candidate insertion position (paper: 0.01). */
  blinkRate?: number;
  initialTemperature?: number;
  finalTemperature?: number;
  neighbours?: number;
  /** Assert the incremental bookkeeping against a from-scratch recomputation. */
  debug?: boolean;
  /** How often to assert, in iterations, when `debug` is on. */
  checkEvery?: number;
}

export interface Result {
  routes: number[][];
  cost: number;
  iterations: number;
  elapsedMs: number;
}

/** xorshift128+, so a run is reproducible from its seed and costs no allocation. */
class Rng {
  private s0: number;
  private s1: number;

  constructor(seed: number) {
    // splitmix-style spreading: a small seed must not leave the state nearly zero.
    this.s0 = (seed ^ 0x9e3779b9) >>> 0 || 1;
    this.s1 = (Math.imul(seed, 0x85ebca6b) ^ 0xc2b2ae35) >>> 0 || 2;
    for (let i = 0; i < 16; i++) this.next();
  }

  next(): number {
    let x = this.s0;
    const y = this.s1;
    this.s0 = y;
    x ^= x << 23;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= y ^ (y >>> 26);
    this.s1 = x >>> 0;
    return (this.s0 + this.s1) >>> 0;
  }

  float(): number {
    return this.next() / 4294967296;
  }

  int(bound: number): number {
    return this.next() % bound;
  }
}

/** For each customer, its `width` nearest other customers, flat and sorted by distance. */
function buildNeighbours(p: Problem, width: number): Int32Array {
  const { n, dist } = p;
  const out = new Int32Array(n * width);
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) {
    candidates.length = 0;
    for (let j = 0; j < n; j++) if (j !== i) candidates.push(j);
    const row = i * n;
    candidates.sort((a, b) => dist[row + a] - dist[row + b]);
    for (let w = 0; w < width; w++) out[i * width + w] = candidates[w];
  }
  return out;
}

/**
 * One solution, kept incrementally consistent.
 *
 * `cost` and `loads` are maintained by every mutation rather than recomputed, and
 * `routeOf` is the customer→route index the ruin step needs. `verify()` exists to prove
 * in tests that the incremental bookkeeping still matches a from-scratch computation.
 */
class Solution {
  routes: number[][] = [];
  loads: number[] = [];
  costs: number[] = [];
  cost = 0;
  routeOf: Int32Array;
  private p: Problem;

  constructor(p: Problem) {
    this.p = p;
    this.routeOf = new Int32Array(p.n).fill(-1);
  }

  routeCost(route: number[]): number {
    if (route.length === 0) return 0;
    const { dist, n, depot } = this.p;
    let c = dist[depot * n + route[0]];
    for (let i = 0; i + 1 < route.length; i++) c += dist[route[i] * n + route[i + 1]];
    return c + dist[route[route.length - 1] * n + depot];
  }

  /** Recompute everything from the routes — the oracle `verify()` checks against. */
  recompute(): void {
    this.cost = 0;
    this.loads.length = 0;
    this.costs.length = 0;
    this.routeOf.fill(-1);
    for (let r = 0; r < this.routes.length; r++) {
      let load = 0;
      for (const c of this.routes[r]) {
        load += this.p.demands[c];
        this.routeOf[c] = r;
      }
      const rc = this.routeCost(this.routes[r]);
      this.loads.push(load);
      this.costs.push(rc);
      this.cost += rc;
    }
  }

  /**
   * Throw unless the incrementally maintained cost, loads and routeOf agree with a
   * from-scratch recomputation. Only ever called from the test harness: it is O(n) and
   * the whole point of the bookkeeping is to avoid paying that per iteration.
   */
  verify(where: string): void {
    let cost = 0;
    for (let r = 0; r < this.routes.length; r++) {
      let load = 0;
      for (const c of this.routes[r]) {
        load += this.p.demands[c];
        if (this.routeOf[c] !== r) {
          throw new Error(`${where}: routeOf[${c}] is ${this.routeOf[c]}, expected ${r}`);
        }
      }
      const rc = this.routeCost(this.routes[r]);
      if (rc !== this.costs[r]) {
        throw new Error(`${where}: route ${r} cost is ${this.costs[r]}, recomputed ${rc}`);
      }
      if (load !== this.loads[r]) {
        throw new Error(`${where}: route ${r} load is ${this.loads[r]}, recomputed ${load}`);
      }
      if (load > this.p.capacity) {
        throw new Error(`${where}: route ${r} load ${load} over capacity ${this.p.capacity}`);
      }
      cost += rc;
    }
    if (cost !== this.cost) {
      throw new Error(`${where}: total cost is ${this.cost}, recomputed ${cost}`);
    }
    const placed = new Set<number>();
    for (const route of this.routes) for (const c of route) {
      if (placed.has(c)) throw new Error(`${where}: customer ${c} appears twice`);
      placed.add(c);
    }
    if (placed.size !== this.p.n - 1) {
      throw new Error(`${where}: ${placed.size} customers placed, expected ${this.p.n - 1}`);
    }
  }

  clone(): Solution {
    const copy = new Solution(this.p);
    copy.routes = this.routes.map((r) => r.slice());
    copy.loads = this.loads.slice();
    copy.costs = this.costs.slice();
    copy.cost = this.cost;
    copy.routeOf = this.routeOf.slice();
    return copy;
  }
}

/**
 * Cheapest feasible insertion of `customer`, with blinks.
 *
 * Only routes holding one of the customer's nearest neighbours are considered. A route
 * whose customers are all far away cannot host a cheap insertion, so scanning it is
 * wasted work — this is what keeps an insertion sub-linear in n on large instances.
 * Falls back to scanning everything when the neighbour scan found nothing feasible.
 */
function bestInsertion(
  p: Problem,
  sol: Solution,
  neighbours: Int32Array,
  width: number,
  customer: number,
  blinkRate: number,
  rng: Rng,
  candidateRoutes: StampSet
): { route: number; pos: number; delta: number } | null {
  const { dist, n, depot, demands, capacity } = p;
  const demand = demands[customer];

  candidateRoutes.clear();
  const base = customer * width;
  for (let w = 0; w < width; w++) {
    const r = sol.routeOf[neighbours[base + w]];
    if (r >= 0) candidateRoutes.add(r);
  }

  let bestRoute = -1;
  let bestPos = -1;
  let bestDelta = Infinity;

  const scan = (r: number): void => {
    if (sol.loads[r] + demand > capacity) return;
    const route = sol.routes[r];
    for (let pos = 0; pos <= route.length; pos++) {
      if (blinkRate > 0 && rng.float() < blinkRate) continue;
      const prev = pos === 0 ? depot : route[pos - 1];
      const next = pos === route.length ? depot : route[pos];
      const delta =
        dist[prev * n + customer] + dist[customer * n + next] - dist[prev * n + next];
      if (delta < bestDelta) {
        bestDelta = delta;
        bestRoute = r;
        bestPos = pos;
      }
    }
  };

  for (const r of candidateRoutes.list()) scan(r);
  if (bestRoute < 0) {
    for (let r = 0; r < sol.routes.length; r++) if (!candidateRoutes.has(r)) scan(r);
  }
  return bestRoute < 0 ? null : { route: bestRoute, pos: bestPos, delta: bestDelta };
}

/**
 * A set of route indices with O(1) clear and no hashing.
 *
 * `Set<number>` was the obvious spelling and was the single biggest cost in the search:
 * collecting candidate routes touches one entry per neighbour, so a 100-wide neighbour
 * list meant ~100 `Set.add` calls for every customer reinserted, millions of times over.
 * Marking a slot with the current epoch and bumping the epoch to clear is the same
 * membership test against a flat Int32Array.
 */
class StampSet {
  private stamp: Int32Array;
  private epoch = 0;
  private members: number[] = [];

  constructor(capacity: number) {
    this.stamp = new Int32Array(capacity);
  }

  clear(): void {
    this.epoch++;
    this.members.length = 0;
  }

  /** Grows to fit: the route count changes as the search opens and empties routes. */
  private fit(i: number): void {
    if (i < this.stamp.length) return;
    const grown = new Int32Array(Math.max(i + 1, this.stamp.length * 2));
    grown.set(this.stamp);
    this.stamp = grown;
  }

  has(i: number): boolean {
    return i < this.stamp.length && this.stamp[i] === this.epoch;
  }

  /** True when `i` was not already present. */
  add(i: number): boolean {
    this.fit(i);
    if (this.stamp[i] === this.epoch) return false;
    this.stamp[i] = this.epoch;
    this.members.push(i);
    return true;
  }

  get size(): number {
    return this.members.length;
  }

  list(): number[] {
    return this.members;
  }
}

/**
 * Undo log for one iteration.
 *
 * Every route is snapshotted the first time it is about to change — by the ruin OR by
 * the repair. Snapshotting only the ruined routes is not enough and is a silent
 * corruption rather than a crash: the repair routinely inserts a removed customer into
 * a route that was never ruined, and rolling back without that route's snapshot leaves
 * the customer both in the restored route and in the one it was inserted into.
 */
class Journal {
  private indices: number[] = [];
  private routes: number[][] = [];
  private loads: number[] = [];
  private costs: number[] = [];
  private seen: StampSet;

  constructor(routeCapacity: number) {
    this.seen = new StampSet(routeCapacity);
  }

  reset(): void {
    this.indices.length = 0;
    this.routes.length = 0;
    this.loads.length = 0;
    this.costs.length = 0;
    this.seen.clear();
  }

  /** The routes this iteration changed — what the local search has to revisit. */
  touchedRoutes(): number[] {
    return this.indices;
  }

  capture(sol: Solution, r: number): void {
    if (this.seen.has(r)) return;
    this.seen.add(r);
    this.indices.push(r);
    this.routes.push(sol.routes[r].slice());
    this.loads.push(sol.loads[r]);
    this.costs.push(sol.costs[r]);
  }

  restore(sol: Solution, routeCountBefore: number, costBefore: number): void {
    // Routes the repair appended never existed before, so they are dropped outright.
    if (sol.routes.length > routeCountBefore) {
      sol.routes.length = routeCountBefore;
      sol.loads.length = routeCountBefore;
      sol.costs.length = routeCountBefore;
    }
    // routeOf is repaired from the snapshots alone, not rebuilt over all n: every
    // customer the iteration moved came out of a ruined route, a ruined route is always
    // journalled, so each moved customer sits in some snapshot that names where it
    // belongs. A snapshot of a route the repair had appended is skipped in BOTH loops —
    // that route is gone now, and writing its members' routeOf would point them at an
    // index past the end of the array.
    for (let i = 0; i < this.indices.length; i++) {
      const r = this.indices[i];
      if (r >= sol.routes.length) continue;
      sol.routes[r] = this.routes[i];
      sol.loads[r] = this.loads[i];
      sol.costs[r] = this.costs[i];
      for (const c of this.routes[i]) sol.routeOf[c] = r;
    }
    sol.cost = costBefore;
  }
}

/**
 * 2-opt within one route, run to a local optimum.
 *
 * Greedy insertion places a customer well relative to the route as it stood, and never
 * revisits that choice — so the *order inside* a route is only ever as good as the order
 * the insertions happened to build. That is invisible when routes hold three or four
 * customers and dominant when they hold twenty: on this benchmark the gap tracks
 * customers-per-route almost perfectly, not instance size.
 *
 * Returns the improvement (>= 0) so the caller can update its running cost, and reverses
 * segments in place. First-improvement rather than best-improvement: it converges in
 * fewer passes over the array, and the search around it is stochastic anyway.
 */
function twoOpt(p: Problem, route: number[]): number {
  const { dist, n, depot } = p;
  const len = route.length;
  if (len < 4) return 0;

  let gained = 0;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < len - 1; i++) {
      const a = i === 0 ? depot : route[i - 1];
      const b = route[i];
      const dab = dist[a * n + b];
      for (let j = i + 1; j < len; j++) {
        const c = route[j];
        const d = j === len - 1 ? depot : route[j + 1];
        // Reversing route[i..j] swaps edges (a,b) and (c,d) for (a,c) and (b,d).
        const delta = dist[a * n + c] + dist[b * n + d] - dab - dist[c * n + d];
        if (delta < 0) {
          for (let lo = i, hi = j; lo < hi; lo++, hi--) {
            const t = route[lo];
            route[lo] = route[hi];
            route[hi] = t;
          }
          gained -= delta;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  return gained;
}

/** Greedy repair: heaviest customers first, which is what leaves the awkward ones room. */
function repair(
  p: Problem,
  sol: Solution,
  neighbours: Int32Array,
  width: number,
  removed: number[],
  blinkRate: number,
  rng: Rng,
  scratch: StampSet,
  journal: Journal | null
): void {
  removed.sort((a, b) => p.demands[b] - p.demands[a]);
  for (const customer of removed) {
    const spot = bestInsertion(p, sol, neighbours, width, customer, blinkRate, rng, scratch);
    if (spot) {
      journal?.capture(sol, spot.route);
      sol.routes[spot.route].splice(spot.pos, 0, customer);
      sol.loads[spot.route] += p.demands[customer];
      sol.costs[spot.route] += spot.delta;
      sol.cost += spot.delta;
      sol.routeOf[customer] = spot.route;
    } else {
      // A single customer always fits an empty route, so this cannot fail.
      const cost = 2 * p.dist[p.depot * p.n + customer];
      sol.routes.push([customer]);
      sol.loads.push(p.demands[customer]);
      sol.costs.push(cost);
      sol.cost += cost;
      sol.routeOf[customer] = sol.routes.length - 1;
    }
  }
}

function initialSolution(
  p: Problem,
  neighbours: Int32Array,
  width: number,
  rng: Rng,
  blinkRate: number
): Solution {
  const customers: number[] = [];
  for (let i = 0; i < p.n; i++) if (i !== p.depot) customers.push(i);
  for (let i = customers.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [customers[i], customers[j]] = [customers[j], customers[i]];
  }
  const sol = new Solution(p);
  repair(p, sol, neighbours, width, customers, blinkRate, rng, new StampSet(p.n), null);
  return sol;
}

export function solve(p: Problem, options: Options): Result {
  const {
    seconds,
    seed = 1,
    avgRemoval = 10,
    maxStringLength = 10,
    blinkRate = 0.01,
    initialTemperature = 100,
    finalTemperature = 1,
    neighbours: neighbourWidth = 100,
    debug = false,
    checkEvery = 64,
  } = options;

  const rng = new Rng(seed);
  const width = Math.min(neighbourWidth, p.n - 1);
  const neighbours = buildNeighbours(p, width);

  const sol = initialSolution(p, neighbours, width, rng, blinkRate);
  if (debug) sol.verify('initial solution');
  let best = sol.clone();

  const startedAt = Date.now();
  const deadline = startedAt + seconds * 1000;
  const coolingBase = finalTemperature / initialTemperature;
  let temperature = initialTemperature;

  // Scratch reused across iterations: the loop runs millions of times, and allocating per
  // iteration would put the garbage collector in the middle of the measurement.
  const removed: number[] = [];
  const insertionScratch = new StampSet(p.n);
  const ruined = new StampSet(p.n);
  const journal = new Journal(p.n);

  let iterations = 0;

  while (Date.now() < deadline) {
    iterations++;
    if ((iterations & 0xff) === 0) {
      const progress = (Date.now() - startedAt) / (seconds * 1000);
      temperature = initialTemperature * Math.pow(coolingBase, Math.min(progress, 1));
    }

    if (debug && iterations % checkEvery === 0) sol.verify(`iteration ${iterations} entry`);

    const costBefore = sol.cost;
    const routeCountBefore = sol.routes.length;

    // ---- ruin: strings of customers, from routes near a random seed customer --------
    const avgRouteLength = p.n / Math.max(sol.routes.length, 1);
    const lsMax = Math.min(maxStringLength, avgRouteLength);
    const ksMax = (4 * avgRemoval) / (1 + lsMax) - 1;
    const ks = Math.max(1, Math.floor(rng.float() * Math.max(ksMax, 1)) + 1);

    const seedCustomer = 1 + rng.int(p.n - 1);

    removed.length = 0;
    ruined.clear();
    journal.reset();

    const base = seedCustomer * width;
    for (let w = 0; w < width && ruined.size < ks; w++) {
      const r = sol.routeOf[neighbours[base + w]];
      if (r < 0 || ruined.has(r)) continue;
      const route = sol.routes[r];
      const idx = route.indexOf(neighbours[base + w]);
      if (idx < 0) continue;

      // Snapshot before the first change to this route, so a rejected candidate is
      // rolled back by restoring only what was disturbed.
      ruined.add(r);
      journal.capture(sol, r);

      const maxCard = Math.max(1, Math.floor(Math.min(lsMax, route.length)));
      const cardinality = Math.min(route.length, 1 + rng.int(maxCard));
      const start = Math.max(0, Math.min(route.length - cardinality, idx - rng.int(cardinality)));

      const cut = route.splice(start, cardinality);
      for (const c of cut) {
        removed.push(c);
        sol.routeOf[c] = -1;
        sol.loads[r] -= p.demands[c];
      }
      const newCost = sol.routeCost(route);
      sol.cost += newCost - sol.costs[r];
      sol.costs[r] = newCost;
    }

    if (removed.length === 0) continue;

    // ---- recreate ---------------------------------------------------------------
    repair(p, sol, neighbours, width, removed, blinkRate, rng, insertionScratch, journal);

    // Only the disturbed routes are re-optimised; the rest are already at a 2-opt local
    // optimum from the iteration that last touched them.
    for (const r of journal.touchedRoutes()) {
      if (r >= sol.routes.length) continue;
      const gained = twoOpt(p, sol.routes[r]);
      if (gained > 0) {
        sol.costs[r] -= gained;
        sol.cost -= gained;
      }
    }

    // ---- accept or roll back ----------------------------------------------------
    const delta = sol.cost - costBefore;
    const accept = delta < 0 || rng.float() < Math.exp(-delta / temperature);

    if (accept) {
      // Empty routes are left in place rather than spliced out: removing one shifts
      // every later index, and routeOf/journal are index-based. They cost nothing to
      // carry and are filtered out of the returned solution.
      if (sol.cost < best.cost) best = sol.clone();
    } else {
      journal.restore(sol, routeCountBefore, costBefore);
    }

    if (debug && iterations % checkEvery === 0) {
      sol.verify(`iteration ${iterations} (${accept ? 'accepted' : 'rolled back'})`);
    }
  }

  return {
    routes: best.routes.filter((r) => r.length > 0),
    cost: best.cost,
    iterations,
    elapsedMs: Date.now() - startedAt,
  };
}

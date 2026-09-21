"""OR-Tools CVRP baseline.

Configured the way the OR-Tools routing guide recommends for CVRP: cheapest-arc style
first solution, then guided local search until the wall-clock budget runs out. The
returned routes are scored by cvrplib.evaluate, not by OR-Tools' own objective.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from ortools.constraint_solver import pywrapcp, routing_enums_pb2  # noqa: E402

from cvrplib import InvalidSolution, evaluate, read_instance  # noqa: E402


def fleet_size(inst) -> int:
    """Minimum vehicles by capacity, plus slack so feasibility is never the binding limit."""
    return math.ceil(sum(inst.demands) / inst.capacity) + 2


def solve(inst, seconds: float, threads: int = 1):
    n_vehicles = fleet_size(inst)
    manager = pywrapcp.RoutingIndexManager(inst.n, n_vehicles, inst.depot)
    routing = pywrapcp.RoutingModel(manager)

    matrix = inst.matrix()

    def distance_cb(i, j):
        return matrix[manager.IndexToNode(i)][manager.IndexToNode(j)]

    transit = routing.RegisterTransitCallback(distance_cb)
    routing.SetArcCostEvaluatorOfAllVehicles(transit)

    def demand_cb(i):
        return inst.demands[manager.IndexToNode(i)]

    demand = routing.RegisterUnaryTransitCallback(demand_cb)
    routing.AddDimensionWithVehicleCapacity(
        demand, 0, [inst.capacity] * n_vehicles, True, "Capacity"
    )

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.FromMilliseconds(int(seconds * 1000))
    params.number_of_solutions_to_collect = 1
    if threads > 1:
        params.number_of_workers = threads

    started = time.perf_counter()
    solution = routing.SolveWithParameters(params)
    elapsed = time.perf_counter() - started
    if solution is None:
        return None, elapsed

    routes = []
    for v in range(n_vehicles):
        index = routing.Start(v)
        route = []
        while not routing.IsEnd(index):
            node = manager.IndexToNode(index)
            if node != inst.depot:
                route.append(node)
            index = solution.Value(routing.NextVar(index))
        if route:
            routes.append(route)
    return routes, elapsed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("instance")
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--threads", type=int, default=1)
    args = ap.parse_args()

    inst = read_instance(args.instance)
    routes, elapsed = solve(inst, args.seconds, args.threads)

    result = {
        "solver": "or-tools",
        "instance": inst.name,
        "n": inst.n,
        "budget_s": args.seconds,
        "threads": args.threads,
        "elapsed_s": round(elapsed, 3),
    }
    if routes is None:
        result["status"] = "no solution"
    else:
        try:
            result["cost"] = evaluate(inst, routes)
            result["vehicles"] = len(routes)
            result["status"] = "ok"
        except InvalidSolution as err:
            result["status"] = f"INFEASIBLE: {err}"
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

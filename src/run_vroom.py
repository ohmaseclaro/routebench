"""VROOM CVRP baseline, driven through the official docker image.

VROOM has no time limit: it runs its heuristic to completion, so the honest comparison
is to record how long it took and give the other solvers that same wall clock. Vehicle
fixed costs are zeroed so the objective is pure travelled distance, matching CVRPLIB.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from cvrplib import InvalidSolution, evaluate, read_instance  # noqa: E402

IMAGE = "ghcr.io/vroom-project/vroom-docker:v1.14.0"


def build_input(inst) -> dict:
    n_vehicles = math.ceil(sum(inst.demands) / inst.capacity) + 2
    return {
        "vehicles": [
            {
                "id": v,
                "start_index": inst.depot,
                "end_index": inst.depot,
                "capacity": [inst.capacity],
                "costs": {"fixed": 0},
            }
            for v in range(n_vehicles)
        ],
        # job id is the 0-indexed node, so the reply maps straight back.
        "jobs": [
            {"id": i, "location_index": i, "delivery": [inst.demands[i]]}
            for i in range(inst.n)
            if i != inst.depot
        ],
        "matrices": {"car": {"durations": inst.matrix()}},
    }


def solve(inst, threads: int = 1, exploration: int = 5):
    payload = build_input(inst)
    with tempfile.TemporaryDirectory() as tmp:
        in_path = Path(tmp) / "in.json"
        in_path.write_text(json.dumps(payload))

        cmd = [
            "docker", "run", "--rm",
            "-v", f"{tmp}:/data",
            "--entrypoint", "vroom",
            IMAGE,
            "-i", "/data/in.json",
            "-t", str(threads),
            "-x", str(exploration),
        ]
        started = time.perf_counter()
        proc = subprocess.run(cmd, capture_output=True, text=True)
        elapsed = time.perf_counter() - started

    if proc.returncode != 0:
        return None, elapsed, proc.stderr.strip()[:300]

    reply = json.loads(proc.stdout)
    if reply.get("code", 0) != 0:
        return None, elapsed, reply.get("error", "unknown vroom error")
    if reply.get("unassigned"):
        return None, elapsed, f"{len(reply['unassigned'])} job(s) unassigned"

    routes = []
    for route in reply.get("routes", []):
        stops = [s["id"] for s in route["steps"] if s["type"] == "job"]
        if stops:
            routes.append(stops)
    return routes, elapsed, None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("instance")
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--exploration", type=int, default=5)
    args = ap.parse_args()

    inst = read_instance(args.instance)
    routes, elapsed, err = solve(inst, args.threads, args.exploration)

    result = {
        "solver": "vroom",
        "instance": inst.name,
        "n": inst.n,
        "threads": args.threads,
        "exploration": args.exploration,
        "elapsed_s": round(elapsed, 3),
    }
    if routes is None:
        result["status"] = f"FAILED: {err}"
    else:
        try:
            result["cost"] = evaluate(inst, routes)
            result["vehicles"] = len(routes)
            result["status"] = "ok"
        except InvalidSolution as e:
            result["status"] = f"INFEASIBLE: {e}"
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

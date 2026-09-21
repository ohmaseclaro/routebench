"""Score a solver's routes with the one shared cost function.

Reads the JSON a runner printed (with a `routes` key) on stdin, recomputes the cost from
the instance, and reports whether the solver's self-reported number was honest.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from cvrplib import InvalidSolution, evaluate, read_bks, read_instance  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("instance")
    args = ap.parse_args()

    payload = json.loads(sys.stdin.read())
    inst = read_instance(args.instance)
    routes = payload.pop("routes")

    try:
        payload["cost"] = evaluate(inst, routes)
        payload["vehicles"] = len(routes)
        payload["status"] = "ok"
    except InvalidSolution as err:
        payload["status"] = f"INFEASIBLE: {err}"

    reported = payload.pop("reported_cost", None)
    if reported is not None and payload.get("cost") is not None:
        payload["self_report_matches"] = reported == payload["cost"]

    bks = read_bks(str(args.instance).replace(".vrp", ".sol"))
    if bks and payload.get("cost"):
        payload["bks"] = bks
        payload["gap_pct"] = round(100 * (payload["cost"] - bks) / bks, 2)

    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

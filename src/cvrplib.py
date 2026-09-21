"""TSPLIB/CVRPLIB reading, one shared distance function, and an independent validator.

Every solver in this benchmark is scored by `evaluate()` on the routes it returns, never
by the objective it reports about itself. Solvers round differently and some report a
relaxed bound; the only fair comparison is one cost function applied to all of them.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Instance:
    name: str
    n: int                      # node count, depot included
    capacity: int
    coords: list[tuple[int, int]]   # index 0 is the depot
    demands: list[int]
    depot: int = 0

    def distance(self, a: int, b: int) -> int:
        """CVRPLIB EUC_2D: euclidean, rounded to nearest integer.

        The rounding is part of the problem definition, not a display choice — the
        published best-known solutions are integers under exactly this rule.
        """
        dx = self.coords[a][0] - self.coords[b][0]
        dy = self.coords[a][1] - self.coords[b][1]
        return int(round(math.sqrt(dx * dx + dy * dy)))

    def matrix(self) -> list[list[int]]:
        return [[self.distance(i, j) for j in range(self.n)] for i in range(self.n)]


def read_instance(path: str | Path) -> Instance:
    text = Path(path).read_text()
    name = re.search(r"NAME\s*:\s*(\S+)", text).group(1)
    dimension = int(re.search(r"DIMENSION\s*:\s*(\d+)", text).group(1))
    capacity = int(re.search(r"CAPACITY\s*:\s*(\d+)", text).group(1))

    edge_type = re.search(r"EDGE_WEIGHT_TYPE\s*:\s*(\S+)", text)
    if edge_type and edge_type.group(1) != "EUC_2D":
        raise ValueError(f"{name}: only EUC_2D is supported, got {edge_type.group(1)}")

    coords: dict[int, tuple[int, int]] = {}
    demands: dict[int, int] = {}
    section = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        head = line.split()[0].upper().rstrip(":")
        if head in ("NODE_COORD_SECTION", "DEMAND_SECTION", "DEPOT_SECTION"):
            section = head
            continue
        if head in ("EOF",):
            section = None
            continue
        if section == "NODE_COORD_SECTION":
            idx, x, y = line.split()[:3]
            coords[int(idx)] = (int(float(x)), int(float(y)))
        elif section == "DEMAND_SECTION":
            idx, d = line.split()[:2]
            demands[int(idx)] = int(d)

    if len(coords) != dimension:
        raise ValueError(f"{name}: expected {dimension} coords, parsed {len(coords)}")

    # CVRPLIB is 1-indexed with the depot at node 1; everything below is 0-indexed.
    ordered = sorted(coords)
    return Instance(
        name=name,
        n=dimension,
        capacity=capacity,
        coords=[coords[i] for i in ordered],
        demands=[demands[i] for i in ordered],
    )


def read_bks(path: str | Path) -> int | None:
    """The published cost from a .sol file, for calibration against the literature."""
    p = Path(path)
    if not p.exists():
        return None
    m = re.search(r"Cost\s+(\d+)", p.read_text())
    return int(m.group(1)) if m else None


class InvalidSolution(Exception):
    pass


def evaluate(inst: Instance, routes: list[list[int]]) -> int:
    """Recompute cost, and refuse anything that is not a feasible CVRP solution.

    Checks every constraint rather than trusting the solver: each customer visited
    exactly once, no route over capacity, no depot in the middle of a route. A solver
    that cheats on feasibility would otherwise look fastest.
    """
    seen: set[int] = set()
    total = 0
    for route in routes:
        if not route:
            continue
        load = 0
        for node in route:
            if node == inst.depot:
                raise InvalidSolution("depot appears inside a route")
            if node in seen:
                raise InvalidSolution(f"customer {node} visited more than once")
            seen.add(node)
            load += inst.demands[node]
        if load > inst.capacity:
            raise InvalidSolution(f"route load {load} over capacity {inst.capacity}")
        path = [inst.depot] + route + [inst.depot]
        total += sum(inst.distance(path[i], path[i + 1]) for i in range(len(path) - 1))

    expected = {i for i in range(inst.n) if i != inst.depot}
    if seen != expected:
        missing = expected - seen
        raise InvalidSolution(f"{len(missing)} customer(s) never visited")
    return total

#!/usr/bin/env bash
# The benchmark: every solver on every instance, all scored by src/validate.py.
#
# VROOM has no time limit, so it is run first and its wall clock becomes the budget the
# other two are given on that instance. Comparing quality at equal wall clock is the
# only comparison that means anything commercially.
#
# Usage: scripts/bench.sh <out.jsonl> <instance.vrp>...
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
OUT="$1"; shift
SEEDS="${SEEDS:-1 2 3}"
MIN_BUDGET="${MIN_BUDGET:-10}"

: > "$OUT"

for instance in "$@"; do
  name=$(basename "$instance" .vrp)
  echo "=== $name" >&2

  # --- VROOM sets the clock -----------------------------------------------------
  vroom_line=$("$PY" "$ROOT/src/run_vroom.py" "$instance" --threads 1)
  echo "$vroom_line" | "$PY" -c "
import json,sys,pathlib
d=json.load(sys.stdin)
sol=pathlib.Path('$instance'.replace('.vrp','.sol'))
import re
bks=None
if sol.exists():
    m=re.search(r'Cost\s+(\d+)', sol.read_text())
    bks=int(m.group(1)) if m else None
if bks and d.get('cost'): d['bks']=bks; d['gap_pct']=round(100*(d['cost']-bks)/bks,2)
print(json.dumps(d))" >> "$OUT"

  budget=$(echo "$vroom_line" | "$PY" -c "
import json,sys
print(max(json.load(sys.stdin)['elapsed_s'], $MIN_BUDGET))")
  echo "    vroom done, budget for the others: ${budget}s" >&2

  # --- OR-Tools at the same wall clock -------------------------------------------
  "$PY" "$ROOT/src/run_ortools.py" "$instance" --seconds "$budget" --threads 1 \
    | "$PY" -c "
import json,sys,re,pathlib
d=json.load(sys.stdin)
sol=pathlib.Path('$instance'.replace('.vrp','.sol'))
if sol.exists():
    m=re.search(r'Cost\s+(\d+)', sol.read_text())
    if m and d.get('cost'): d['bks']=int(m.group(1)); d['gap_pct']=round(100*(d['cost']-d['bks'])/d['bks'],2)
print(json.dumps(d))" >> "$OUT"
  echo "    or-tools done" >&2

  # --- ours, once per seed --------------------------------------------------------
  for seed in $SEEDS; do
    node --experimental-strip-types "$ROOT/src/run_sisr.ts" "$instance" \
      --seconds "$budget" --seed "$seed" --t0 300 2>/dev/null \
      | grep '^{' | "$PY" "$ROOT/src/validate.py" "$instance" >> "$OUT"
  done
  echo "    sisr-ts done" >&2
done

echo "wrote $OUT" >&2

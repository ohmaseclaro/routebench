#!/usr/bin/env bash
# Parameter sweep for the SISR solver, scored by the shared validator.
#
# Usage: scripts/sweep.sh <instance.vrp> <seconds> <param-name> <value...>
# Prints one line per (value, seed) plus the mean gap per value.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTANCE="$1"; SECONDS_BUDGET="$2"; PARAM="$3"; shift 3
SEEDS="${SEEDS:-1 2 3}"

for value in "$@"; do
  for seed in $SEEDS; do
    node --experimental-strip-types "$ROOT/src/run_sisr.ts" "$INSTANCE" \
      --seconds "$SECONDS_BUDGET" --seed "$seed" --"$PARAM" "$value" 2>/dev/null \
      | grep '^{' \
      | "$ROOT/.venv/bin/python" "$ROOT/src/validate.py" "$INSTANCE" \
      | "$ROOT/.venv/bin/python" -c "
import json, sys
d = json.load(sys.stdin)
print(f\"$PARAM=$value seed={d['seed']} gap={d.get('gap_pct')} cost={d.get('cost')} iters={d.get('iterations')} {d['status']}\")
"
  done
done

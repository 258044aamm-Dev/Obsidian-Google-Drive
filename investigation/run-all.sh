#!/bin/bash
# Replays the same scenarios against upstream 3.1.1 (what your phone runs) and this fork (3.3.0).
# One-time setup:  git remote add upstream https://github.com/RichardX366/Obsidian-Google-Drive && git fetch upstream
#                  git worktree add ../upstream upstream/master && ln -s "$PWD/node_modules" ../upstream/node_modules
set -e
FORK=$(cd "$(dirname "$0")/.." && pwd)
UP=$(cd "$FORK/../upstream" && pwd)
rm -f /tmp/sim-results-*.json
rm -rf "$UP/investigation" "$UP/tests/sim" && mkdir -p "$UP/tests" && cp -r "$FORK/investigation" "$UP/investigation" && cp -r "$FORK/tests/sim" "$UP/tests/sim"
run() { (cd "$2" && SIM_LABEL=$1 SIM_ROOT=$2 SIM_VERSION=$3 npx vitest run --config investigation/vitest.sim.config.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "✓|×|FAIL" || true); }
run upstream "$UP" 3.1.1
run fork "$FORK" 3.3.0
echo "results: /tmp/sim-results-upstream.json  /tmp/sim-results-fork.json"

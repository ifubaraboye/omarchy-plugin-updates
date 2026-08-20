#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
node --test "$DIR/tests/UpdateCheckerTest.js"

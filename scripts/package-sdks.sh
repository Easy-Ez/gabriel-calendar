#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$repo"
mkdir -p dist
out=$(mktemp -d "$repo/dist/sdk-packages.XXXXXXXX")
smoke=$(mktemp -d "${TMPDIR:-/tmp}/gabriel-calendar-packages.XXXXXXXX")
trap 'rm -rf -- "$smoke"' EXIT

npm run build --workspace gabriel-calendar
npm pack --workspace gabriel-calendar --pack-destination "$out"
uv build --no-sources --default-index https://pypi.org/simple --out-dir "$out" sdks/python

node_packages=("$out"/gabriel-calendar-*.tgz)
wheels=("$out"/gabriel_calendar-*-py3-none-any.whl)
source_packages=("$out"/gabriel_calendar-*.tar.gz)
if [[ ${#node_packages[@]} != 1 || ${#wheels[@]} != 1 || ${#source_packages[@]} != 1 ]]; then
  echo "Expected one npm package, one Python wheel, and one Python source distribution" >&2
  exit 1
fi

mkdir -p "$smoke/spec/fixtures" "$smoke/sdks/node/test" "$smoke/sdks/python/tests"
cp spec/fixtures/mvp.json "$smoke/spec/fixtures/"
cp sdks/node/test/conformance.test.mjs "$smoke/sdks/node/test/"
cp sdks/python/tests/test_conformance.py "$smoke/sdks/python/tests/"

(
  cd -- "$smoke/sdks/node"
  npm install --ignore-scripts --no-package-lock --no-audit --no-fund \
    --registry=https://registry.npmjs.org/ "${node_packages[0]}"
  node --test test/conformance.test.mjs
)

for distribution in "${wheels[0]}" "${source_packages[0]}"; do
  environment=$(mktemp -d "$smoke/venv.XXXXXXXX")
  uv venv --python 3.11 "$environment"
  uv pip install --default-index https://pypi.org/simple --python "$environment/bin/python" "$distribution"
  (
    cd -- "$smoke"
    "$environment/bin/python" -I -m unittest discover -s sdks/python/tests
  )
done

printf '\nVerified SDK distributions in %s\n' "$out"
if [[ -n ${GITHUB_OUTPUT:-} ]]; then
  printf 'package-dir=%s\n' "$out" >> "$GITHUB_OUTPUT"
fi

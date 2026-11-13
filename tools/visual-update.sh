#!/bin/sh
# Regenerate the component catalog baselines in the same Playwright image CI uses.
# Needs Docker. Run from the repository root; review the changed PNGs before committing.
set -eu
IMAGE="mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f"
# Inside the checkout so Docker VMs (Colima, Docker Desktop) can mount it.
out="$PWD/.visual-out"
rm -rf "$out" && mkdir "$out"
container="rada-ui-visual-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$out"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
status=0
docker run --name "$container" --rm --ipc=host -v "$PWD":/src:ro -v "$out":/out "$IMAGE" bash -c '
  set -e
  mkdir /work && cd /src
  tar --exclude=node_modules --exclude=.git --exclude=test-results --exclude=apps/miniapp/dist --exclude=.visual-out -cf - . | tar -xf - -C /work
  cd /work && npm ci --ignore-scripts >/dev/null
  result=0
  CI=true npx playwright test --config apps/miniapp/playwright.visual.config.ts --update-snapshots || result=$?
  if [ -d test-results ]; then cp -r test-results /out/results; fi
  if [ "$result" -eq 0 ]; then cp -r apps/miniapp/visual/__screenshots__ /out/; fi
  exit "$result"' || status=$?
if [ -d "$out/results" ]; then
  mkdir -p test-results/visual-update
  cp -r "$out/results/." test-results/visual-update/
fi
if [ "$status" -ne 0 ]; then exit "$status"; fi
rm -rf apps/miniapp/visual/__screenshots__
cp -r "$out/__screenshots__" apps/miniapp/visual/__screenshots__
echo "Baselines updated in apps/miniapp/visual/__screenshots__"

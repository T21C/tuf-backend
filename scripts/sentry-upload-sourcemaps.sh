#!/usr/bin/env bash
# Upload server sourcemaps to the Node Sentry project.
# Intended for Docker build (after tsc). Requires token+release by default;
# set SENTRY_REQUIRE_UPLOAD=0 (or false) to skip when either is missing.
set -euo pipefail

REQUIRE="${SENTRY_REQUIRE_UPLOAD:-1}"
TOKEN_FILE="${SENTRY_AUTH_TOKEN_FILE:-/run/secrets/sentry_auth_token}"
TOKEN="${SENTRY_AUTH_TOKEN:-}"

if [[ -z "$TOKEN" && -f "$TOKEN_FILE" ]]; then
  TOKEN="$(tr -d '\n\r' <"$TOKEN_FILE")"
fi

RELEASE="${SENTRY_RELEASE:-${GIT_SHA:-}}"
ORG="${SENTRY_ORG:-}"
if [[ -z "$ORG" ]]; then
  ORG="the-universal-forums"
fi
PROJECT="${SENTRY_PROJECT:-main-server}"
URL_ARGS=()
if [[ -n "${SENTRY_URL:-}" ]]; then
  URL_ARGS+=(--url "$SENTRY_URL")
fi

require_upload() {
  case "${REQUIRE,,}" in
    0|false|no|off) return 1 ;;
    *) return 0 ;;
  esac
}

if [[ -z "$TOKEN" || -z "$RELEASE" ]]; then
  if require_upload; then
    echo "[sentry] SENTRY_REQUIRE_UPLOAD set but token or release missing" >&2
    exit 1
  fi
  echo "[sentry] Skipping sourcemap upload (token or release missing)"
  exit 0
fi

if [[ ! -d dist ]]; then
  echo "[sentry] dist/ missing; cannot upload sourcemaps" >&2
  exit 1
fi

export SENTRY_AUTH_TOKEN="$TOKEN"

CLI=(npx --no-install sentry-cli)
if [[ -x node_modules/.bin/sentry-cli ]]; then
  CLI=(node_modules/.bin/sentry-cli)
fi

echo "[sentry] Injecting and uploading sourcemaps for release=$RELEASE org=$ORG project=$PROJECT"

"${CLI[@]}" "${URL_ARGS[@]}" sourcemaps inject ./dist

"${CLI[@]}" "${URL_ARGS[@]}" sourcemaps upload ./dist \
  --org "$ORG" \
  --project "$PROJECT" \
  --release "$RELEASE"

echo "[sentry] Sourcemap upload complete"

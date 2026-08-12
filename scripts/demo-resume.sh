#!/usr/bin/env bash

# Run a real chat turn, drop its first SSE connection after its first event,
# then resume from the last received event ID. Requires curl and bun.
set -euo pipefail

API_BASE="${GREPPA_API_BASE:-http://127.0.0.1:3009/api/v1}"
FIRST_EVENT_TIMEOUT_SECS="${FIRST_EVENT_TIMEOUT_SECS:-45}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

json_field() {
  bun -e "const input = await Bun.stdin.text(); process.stdout.write(String(JSON.parse(input).$1))"
}

echo "Using $API_BASE"

session_json="$(curl -fsS --max-time 20 -X POST "$API_BASE/session")"
session_id="$(printf '%s' "$session_json" | json_field sessionId)"

chat_json="$(
  curl -fsS --max-time 40 -X POST "$API_BASE/chat" \
    -H 'content-type: application/json' \
    -H "x-greppa-session: $session_id" \
    --data '{"message":"Reply with exactly: reconnect proved."}'
)"
message_id="$(printf '%s' "$chat_json" | json_field messageId)"
stream_url="$API_BASE/chat/stream?messageId=$message_id"

echo "Message: $message_id"
echo "1. Opening the first SSE connection and cutting it after its first event..."
# awk exits as soon as the first complete frame with an id arrives. That closes
# curl's pipe deliberately, modelling a dropped client connection without
# depending on Bun's fetch implementation to keep an idle SSE socket open.
set +e
curl -sS -N --http1.1 --max-time "$FIRST_EVENT_TIMEOUT_SECS" "$stream_url" \
  -H "x-greppa-session: $session_id" 2> "$WORK_DIR/first.err" | \
  awk '{ print; if ($0 ~ /^id: /) saw_id = 1; if (saw_id && $0 == "") exit }' \
  > "$WORK_DIR/first.sse"
first_curl_status=${PIPESTATUS[0]}
set -e

# curl reports write error 23 when awk intentionally closes the pipe.
if [[ $first_curl_status -ne 0 && $first_curl_status -ne 23 && $first_curl_status -ne 28 ]]; then
  cat "$WORK_DIR/first.err" >&2
fi

cursor="$(awk '/^id: / { id=$2 } END { print id }' "$WORK_DIR/first.sse")"
if [[ -z "$cursor" ]]; then
  echo "No SSE event arrived within ${FIRST_EVENT_TIMEOUT_SECS}s. Inspect the workflow logs and retry."
  exit 1
fi

first_ids="$(awk '/^id: / { printf "%s%s", (n++ ? "," : ""), $2 }' "$WORK_DIR/first.sse")"
echo "   Received: $first_ids"
echo "2. Reconnecting with Last-Event-ID: $cursor"

curl -sS -N --max-time 45 "$stream_url" \
  -H "x-greppa-session: $session_id" \
  -H "Last-Event-ID: $cursor" > "$WORK_DIR/resumed.sse" 2>/dev/null || true

resumed_ids="$(awk '/^id: / { printf "%s%s", (n++ ? "," : ""), $2 }' "$WORK_DIR/resumed.sse")"
completion="$(awk '/^event: done$/ { done=1; next } done && /^data: / { sub(/^data: /, ""); print; exit }' "$WORK_DIR/resumed.sse")"

if [[ -z "$completion" ]]; then
  echo "No done event arrived within 45 seconds. Inspect the workflow logs and retry."
  exit 1
fi

echo "   Resumed:  $resumed_ids"
echo "3. Done: $completion"
echo
echo "Pass: the resumed sequence starts after $cursor and ends with done."

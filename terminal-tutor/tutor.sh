#!/bin/bash
TUTOR_URL="http://localhost:3737"
_C='\033[0;35m'; _G='\033[0;32m'; _R='\033[0;31m'; _X='\033[0m'

if curl -s --max-time 1 "$TUTOR_URL/health" > /dev/null 2>&1; then
  echo -e "${_G}⚡ Terminal Tutor connected. Open ${TUTOR_URL} in your browser.${_X}"
else
  echo -e "${_R}⚠  Start the server first: node server.js${_X}"
fi

_TUTOR_SKIP='ls|ll|la|pwd|clear|history|exit|cd|man|source|tutor|ask|explain'

# Commands whose output is worth capturing for security/teaching context
_TUTOR_CAPTURE='npm|npx|node|git|supabase|terraform|kubectl|docker|python|python3|pip|aws|psql|curl|wget'

_tutor_send() {
  local CMD="$1" OUTPUT="$2" CODE="$3"
  echo "$CMD" | grep -qE "^(${_TUTOR_SKIP})(\s|$)" && return
  [ -z "$CMD" ] && return
  (curl -s --max-time 5 -X POST "$TUTOR_URL/explain" \
    -H 'Content-Type: application/json' \
    -d "{
      \"command\": $(printf '%s' "$CMD"    | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
      \"output\":  $(printf '%s' "$OUTPUT" | head -c 1500 | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
      \"exitCode\": ${CODE:-0}
    }" > /dev/null 2>&1) &
}

# Capture output for important commands by wrapping them
_tutor_run_and_capture() {
  local CMD="$1"
  local TMPFILE
  TMPFILE=$(mktemp /tmp/tutor_out.XXXXXX)
  eval "$CMD" 2>&1 | tee "$TMPFILE"
  local CODE="${PIPESTATUS[0]}"
  local OUTPUT
  OUTPUT=$(cat "$TMPFILE")
  rm -f "$TMPFILE"
  _tutor_send "$CMD" "$OUTPUT" "$CODE"
}

if [ -n "$ZSH_VERSION" ]; then
  autoload -U add-zsh-hook

  _tutor_preexec() {
    _TUTOR_CMD="$1"
    _TUTOR_TMPFILE=$(mktemp /tmp/tutor_out.XXXXXX 2>/dev/null)
    # For important commands, tee output to temp file
    if echo "$_TUTOR_CMD" | grep -qE "^(${_TUTOR_CAPTURE})(\s|$)"; then
      _TUTOR_CAPTURE_OUTPUT=1
    else
      _TUTOR_CAPTURE_OUTPUT=0
    fi
  }

  _tutor_precmd() {
    local CODE=$?
    [ -z "$_TUTOR_CMD" ] && return
    local OUTPUT=""
    if [ -n "$_TUTOR_TMPFILE" ] && [ -f "$_TUTOR_TMPFILE" ]; then
      OUTPUT=$(cat "$_TUTOR_TMPFILE" 2>/dev/null)
      rm -f "$_TUTOR_TMPFILE"
    fi
    _tutor_send "$_TUTOR_CMD" "$OUTPUT" "$CODE"
    _TUTOR_CMD=""
    _TUTOR_TMPFILE=""
  }

  add-zsh-hook preexec _tutor_preexec
  add-zsh-hook precmd  _tutor_precmd
  echo -e "${_C}✓ Zsh hooked — every command will be explained in the panel${_X}"
fi

if [ -n "$BASH_VERSION" ]; then
  _tutor_bash_hook() {
    local CODE=$?
    local CMD
    CMD=$(history 1 | sed 's/^[ ]*[0-9]*[ ]*//')
    [ "$CMD" = "$_TUTOR_LAST_CMD" ] && return
    _TUTOR_LAST_CMD="$CMD"
    _tutor_send "$CMD" "" "$CODE"
  }
  PROMPT_COMMAND="_tutor_bash_hook${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  echo -e "${_C}✓ Bash hooked — every command will be explained in the panel${_X}"
fi

# ── MANUAL COMMANDS ───────────────────────────────────────────────────────────

tutor() {
  local CMD
  CMD=$(fc -ln -1 2>/dev/null || history 1 | sed 's/^[ ]*[0-9]*[ ]*//')
  _tutor_send "${1:-$CMD}" "" "0"
  echo -e "${_C}📖 Sent to panel…${_X}"
}

ask() {
  [ -z "$1" ] && echo "Usage: ask what does npm install do?" && return
  _tutor_send "ask" "$*" "0"
  echo -e "${_C}💬 Question sent to panel…${_X}"
}

explain() {
  [ -z "$1" ] && echo "Usage: explain git rebase" && return
  _tutor_send "$*" "(explain only — not run)" "0"
  echo -e "${_C}🔍 Explanation incoming…${_X}"
}

# Run RLS scan against Supabase project
scan-rls() {
  local URL="${SUPABASE_URL:-$1}"
  local KEY="${SUPABASE_SERVICE_KEY:-$2}"
  if [ -z "$URL" ] || [ -z "$KEY" ]; then
    echo -e "${_R}Usage: scan-rls <supabase-url> <service-key>${_X}"
    echo -e "${_C}Or set SUPABASE_URL and SUPABASE_SERVICE_KEY in your .env${_X}"
    return 1
  fi
  echo -e "${_C}🔐 Scanning RLS policies…${_X}"
  curl -s -X POST "$TUTOR_URL/scan-rls" \
    -H 'Content-Type: application/json' \
    -d "{\"supabaseUrl\":\"$URL\",\"serviceKey\":\"$KEY\"}" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'error' in d:
  print('❌', d['error'])
else:
  print(f'Tables: {d[\"tables\"]} | Policies: {d[\"policies\"]} | Issues: {len(d[\"issues\"])}')
  for i in d['issues']:
    prefix = '🚨' if i['severity']=='critical' else '⚠️'
    print(f'{prefix} [{i[\"table\"]}] {i[\"issue\"]}')
"
  echo -e "${_C}Full results sent to panel.${_X}"
}

# Scan project files for leaked secrets
scan-secrets() {
  local PATH_ARG="${1:-$PWD}"
  echo -e "${_C}🔍 Scanning for secrets in ${PATH_ARG}…${_X}"
  curl -s -X POST "$TUTOR_URL/scan-secrets" \
    -H 'Content-Type: application/json' \
    -d "{\"path\":\"$(printf '%s' "$PATH_ARG" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))[1:-1]')\"}" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if not d['findings']:
  print('✅ No secrets found in tracked files')
else:
  print(f'🚨 {len(d[\"findings\"])} potential secret(s) found:')
  for f in d['findings']:
    print(f'  {f[\"label\"]} → {f[\"file\"]}')
"
  echo -e "${_C}Full results sent to panel.${_X}"
}

# Start watching auth files for changes
watch-auth() {
  local WATCH_PATH="${1:-$PWD}"
  echo -e "${_C}👁  Watching auth files in ${WATCH_PATH}…${_X}"
  curl -s -X POST "$TUTOR_URL/watch/start" \
    -H 'Content-Type: application/json' \
    -d "{\"path\":\"$WATCH_PATH\"}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('message') or d.get('error') or 'Watching')"
}

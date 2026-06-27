#!/bin/bash
TUTOR_URL="http://localhost:3737"
_C='\033[0;35m'; _G='\033[0;32m'; _R='\033[0;31m'; _X='\033[0m'

if curl -s --max-time 1 "$TUTOR_URL/health" > /dev/null 2>&1; then
  echo -e "${_G}⚡ Terminal Tutor connected. Open ${TUTOR_URL} in your browser.${_X}"
else
  echo -e "${_R}⚠  Start the server first: node server.js${_X}"
fi

_TUTOR_SKIP='ls|ll|la|pwd|clear|history|exit|cd|man|echo|cat|head|tail|source|tutor|ask'

_tutor_send() {
  local CMD="$1" OUTPUT="$2" CODE="$3"
  echo "$CMD" | grep -qE "^(${_TUTOR_SKIP})(\s|$)" && return
  [ -z "$CMD" ] && return
  (curl -s --max-time 3 -X POST "$TUTOR_URL/explain" \
    -H 'Content-Type: application/json' \
    -d "{
      \"command\": $(printf '%s' "$CMD" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
      \"output\":  $(printf '%s' "$OUTPUT" | head -c 600 | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
      \"exitCode\": ${CODE:-0}
    }" > /dev/null 2>&1) &
}

if [ -n "$ZSH_VERSION" ]; then
  autoload -U add-zsh-hook
  _tutor_preexec() { _TUTOR_CMD="$1"; }
  _tutor_precmd() {
    local CODE=$?
    [ -z "$_TUTOR_CMD" ] && return
    _tutor_send "$_TUTOR_CMD" "" "$CODE"
    _TUTOR_CMD=""
  }
  add-zsh-hook preexec _tutor_preexec
  add-zsh-hook precmd  _tutor_precmd
  echo -e "${_C}✓ Zsh hooked — every command will be explained in the panel${_X}"
fi

if [ -n "$BASH_VERSION" ]; then
  _tutor_bash_hook() {
    local CODE=$?
    local CMD=$(history 1 | sed 's/^[ ]*[0-9]*[ ]*//')
    [ "$CMD" = "$_TUTOR_LAST_CMD" ] && return
    _TUTOR_LAST_CMD="$CMD"
    _tutor_send "$CMD" "" "$CODE"
  }
  PROMPT_COMMAND="_tutor_bash_hook${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  echo -e "${_C}✓ Bash hooked — every command will be explained in the panel${_X}"
fi

tutor() {
  local CMD=$(fc -ln -1 2>/dev/null || history 1 | sed 's/^[ ]*[0-9]*[ ]*//')
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

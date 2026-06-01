#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ -z "${CODEX_HOME:-}" ]; then
  case "$PLUGIN_ROOT" in
    */plugins/cache/*/*/*)
      CODEX_HOME=${PLUGIN_ROOT%%/plugins/cache/*}
      export CODEX_HOME
      ;;
  esac
fi

find_node() {
  if [ -n "${CODEX_NODE_PATH:-}" ] && [ -x "$CODEX_NODE_PATH" ]; then
    printf '%s\n' "$CODEX_NODE_PATH"
    return 0
  fi

  if [ -n "${NODE_REPL_NODE_PATH:-}" ] && [ -x "$NODE_REPL_NODE_PATH" ]; then
    printf '%s\n' "$NODE_REPL_NODE_PATH"
    return 0
  fi

  if [ -n "${CODEX_CLI_PATH:-}" ]; then
    candidate=$(dirname -- "$CODEX_CLI_PATH")/node
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  for candidate in \
    "/Applications/Codex zemaj.app/Contents/Resources/node" \
    "/Applications/Codex.app/Contents/Resources/node"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  return 1
}

NODE_BIN=$(find_node) || {
  echo "Ultracode could not find a Node.js runtime." >&2
  exit 127
}

if [ -z "${CODEX_CLI_PATH:-}" ]; then
  candidate=$(dirname -- "$NODE_BIN")/codex
  if [ -x "$candidate" ]; then
    CODEX_CLI_PATH=$candidate
    export CODEX_CLI_PATH
  fi
fi

case "${1:-}" in
  mcp)
    exec "$NODE_BIN" "$PLUGIN_ROOT/mcp/server.js"
    ;;
  prompt-hook)
    exec "$NODE_BIN" "$PLUGIN_ROOT/hooks/ultracode_prompt_context.js"
    ;;
  *)
    echo "Usage: run-node-tool.sh {mcp|prompt-hook}" >&2
    exit 64
    ;;
esac

#!/bin/zsh
cd /Users/johnhausman/source/immich || exit 1
mkdir -p assistant-agent-logs
exec /opt/homebrew/bin/node tools/assistant-cli-bridge.mjs >> assistant-agent-logs/bridge.command.log 2>&1

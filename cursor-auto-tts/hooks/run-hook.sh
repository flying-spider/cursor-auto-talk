#!/bin/sh
# macOS / Linux 用的 hook 启动器。
#
# 为什么需要它：从 Dock 启动的 Cursor 继承的是极简 PATH（通常只有
# /usr/bin:/bin:/usr/sbin:/sbin），Homebrew 或 nvm 装的 node 不在里面，
# 直接写 `node script.js` 会报 command not found。这里先把 node 找出来再执行。
#
# 用法（~/.cursor/hooks.json，注意用 /bin/sh 显式调用，避免依赖可执行位）：
#   "command": "/bin/sh \"/Users/你的用户名/Desktop/自动朗读/cursor-auto-tts/hooks/run-hook.sh\""

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

NODE=$(command -v node 2>/dev/null)
if [ -z "$NODE" ]; then
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.volta/bin/node \
    "$HOME"/.fnm/aliases/default/bin/node
  do
    if [ -x "$candidate" ]; then
      NODE=$candidate
      break
    fi
  done
fi

if [ -z "$NODE" ]; then
  echo "[cursor-auto-tts] 找不到 node，请在 run-hook.sh 里写死 node 的绝对路径" >&2
  exit 0
fi

exec "$NODE" "$DIR/after-agent-response.js"

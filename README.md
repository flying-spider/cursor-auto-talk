# Cursor Auto Talk

让 Cursor 里 AI 的回复自动朗读出来：微软 Edge 神经网络语音（免费、无需 Key、不依赖 Cursor 后端），
断网或合成失败时回退系统语音。Windows / macOS 可用（Linux 尽力支持）。

朗读不消耗模型 token —— 触发源完全在模型之外，内容不进入对话上下文。

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| [`cursor-auto-tts/`](cursor-auto-tts/README.md) | Cursor 扩展本体：接收文本 → 合成语音 → 播放音频。详细配置、排错见该目录的 README |
| [`mcp/`](mcp/server.js) | 零依赖 MCP 服务器，提供 `speak(text)` 工具，让模型自己朗读（可选，会产生 token 成本） |

## 安装

### 方式一：安装仓库里打包好的扩展（推荐，不需要 Node.js）

仓库自带打包好的 `cursor-auto-tts/cursor-auto-tts-0.1.0.vsix`，下载后直接安装：

下载地址：<https://github.com/flying-spider/cursor-auto-talk/raw/main/cursor-auto-tts/cursor-auto-tts-0.1.0.vsix>
（浏览器里打开会直接下载；也可以用 `git clone` 后从本地文件安装）

**Windows**

1. 下载 `cursor-auto-tts-0.1.0.vsix`，例如保存到 `D:\下载\cursor-auto-tts-0.1.0.vsix`
2. 打开 Cursor，按 `Ctrl+Shift+P` 调出命令面板，输入并选择 `Extensions: Install from VSIX...`，选中刚才的文件
3. 再按 `Ctrl+Shift+P`，执行 `Developer: Reload Window` 让扩展生效
4. 状态栏右侧出现「自动朗读:开」，点一下可以关闭；`Alt+R` 朗读选中或剪贴板文本，`Ctrl+Alt+S` 停止

**macOS**

1. 下载同一个 `cursor-auto-tts-0.1.0.vsix`，例如保存到「下载」文件夹
2. 打开 Cursor，按 `⇧⌘P` 调出命令面板，输入并选择 `Extensions: Install from VSIX...`，选中该文件
3. 再按 `⇧⌘P`，执行 `Developer: Reload Window`
4. 快捷键相应换成 macOS 的写法：`⌥R` 朗读，`⌃⌥S` 停止；`Ctrl+Shift+P` 一律是 `⇧⌘P`
5. 配置 hooks 时请用仓库自带的 `run-hook.sh` 启动器，原因见下一节

### 方式二：从源码构建

```bash
git clone https://github.com/flying-spider/cursor-auto-talk.git
cd cursor-auto-talk/cursor-auto-tts
npm install
npm test             # 可选：自测，不发网络请求、不发声
npm run package      # 重新生成 cursor-auto-tts-0.1.0.vsix
```

生成后按方式一安装该 vsix。也可以不打包，直接在 Cursor 里执行
`Developer: Install Extension from Location...` 并选中 `cursor-auto-tts` 目录。

## 配置自动朗读（hooks，零 token）

扩展装好后还只是「能朗读」。要让 AI 每产出一条回复自动念出来，在 `~/.cursor/hooks.json` 里挂一个
`afterAgentResponse` hook：Windows 是 `%USERPROFILE%\.cursor\hooks.json`，macOS 是 `~/.cursor/hooks.json`。

**Windows**

```json
{
  "version": 1,
  "hooks": {
    "afterAgentResponse": [
      {
        "command": "node \"C:\\Users\\你的用户名\\Desktop\\自动朗读\\cursor-auto-tts\\hooks\\after-agent-response.js\"",
        "timeout": 5
      }
    ]
  }
}
```

**macOS**

```json
{
  "version": 1,
  "hooks": {
    "afterAgentResponse": [
      {
        "command": "/bin/sh \"/Users/你的用户名/Desktop/自动朗读/cursor-auto-tts/hooks/run-hook.sh\"",
        "timeout": 5
      }
    ]
  }
}
```

两个要点：

- 上面的路径指向**克隆下来的仓库目录**，这个路径稳定、扩展升级也不会变。如果只用 vsix 安装、没有克隆仓库，
  也可以指向扩展自己的安装目录：Windows 是
  `%USERPROFILE%\.cursor\extensions\local.cursor-auto-tts-0.1.0\hooks\after-agent-response.js`，
  macOS 是 `~/.cursor/extensions/local.cursor-auto-tts-0.1.0/hooks/run-hook.sh`。
- macOS 请用 `run-hook.sh` 而不是直接写 `node`：从 Dock 启动的 Cursor 继承的是极简 PATH
  （通常只有 `/usr/bin:/bin:/usr/sbin:/sbin`），找不到 Homebrew / nvm 安装的 node。
  启动器会依次尝试 PATH、`/opt/homebrew/bin/node`、`/usr/local/bin/node` 和 nvm/volta/fnm 的默认路径。

改完 `hooks.json` 后重启 Cursor（或在 `Customize → Hooks` 面板确认已加载），状态栏保持「自动朗读:开」即可。
听不到声音时，先访问 `http://127.0.0.1:51730/status` 确认扩展在跑，再看 `~/.cursor/cursor-tts-play.log`。

## 工作方式

三种触发源（hooks / DOM 观察器 / MCP 工具）都把文本投递到本机 `127.0.0.1:51730/speak`，
扩展负责：

1. **切段**：按句末标点切成小段（每段最多 `segmentChars` 字，默认 60），第一段合成完立刻出声；
2. **并行合成**：同时合成 `synthesisConcurrency` 段（默认 3）。edge-tts 合成速度约为实时的 4 倍，
   后面的句子在前一句还在播时就已准备好；
3. **成批播放**：把已经合成好的连续段落拼成一条 mp3，交给常驻播放进程一次播完，
   避免「每念一句都要重启播放器」造成的段间空档；句子自带的尾音留白保留，语义停顿不变；
4. **失败回退**：合成连续失败时退回系统语音，不会整条哑掉。

## 自测

```bash
cd cursor-auto-tts && npm test
```

覆盖队列去重/增量、代码块剥离、并行合成与成批播放、mp3 拼接、观察器切句（不发网络请求、不发声）。

## 许可

MIT，见 [`cursor-auto-tts/LICENSE`](cursor-auto-tts/LICENSE)。

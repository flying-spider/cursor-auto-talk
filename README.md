# Cursor Auto Talk

让 Cursor 里 AI 的回复自动朗读出来：微软 Edge 神经网络语音（免费、无需 Key、不依赖 Cursor 后端），
断网或合成失败时回退系统语音。Windows / macOS 可用（Linux 尽力支持）。

朗读不消耗模型 token —— 触发源完全在模型之外，内容不进入对话上下文。

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| [`cursor-auto-tts/`](cursor-auto-tts/README.md) | Cursor 扩展本体：接收文本 → 合成语音 → 播放音频。详细安装、配置、排错见该目录的 README |
| [`mcp/`](mcp/server.js) | 零依赖 MCP 服务器，提供 `speak(text)` 工具，让模型自己朗读（可选，会产生 token 成本） |

## 工作方式

三种触发源（hooks / DOM 观察器 / MCP 工具）都把文本投递到本机 `127.0.0.1:51730/speak`，
扩展负责：

1. **切段**：按句末标点切成小段（每段最多 `segmentChars` 字，默认 60），第一段合成完立刻出声；
2. **并行合成**：同时合成 `synthesisConcurrency` 段（默认 3）。edge-tts 合成速度约为实时的 4 倍，
   后面的句子在前一句还在播时就已准备好；
3. **成批播放**：把已经合成好的连续段落拼成一条 mp3，交给常驻播放进程一次播完，
   避免「每念一句都要重启播放器」造成的段间空档；句子自带的尾音留白保留，语义停顿不变；
4. **失败回退**：合成连续失败时退回系统语音，不会整条哑掉。

## 快速开始

```bash
cd cursor-auto-tts
npm install
npm run package          # 生成 cursor-auto-tts-0.1.0.vsix
```

Cursor 中 `Ctrl+Shift+P` → `Extensions: Install from VSIX...` → 选择生成的 vsix →
`Developer: Reload Window`。之后在 `~/.cursor/hooks.json` 里挂上 `afterAgentResponse`
hook，就能零 token 自动朗读（配置样例见 [`cursor-auto-tts/hooks.json.example`](cursor-auto-tts/hooks.json.example)）。

## 自测

```bash
cd cursor-auto-tts && npm test
```

覆盖队列去重/增量、代码块剥离、并行合成与成批播放、mp3 拼接、观察器切句（不发网络请求、不发声）。

## 许可

MIT，见 [`cursor-auto-tts/LICENSE`](cursor-auto-tts/LICENSE)。

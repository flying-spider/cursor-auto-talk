# Cursor Auto TTS 朗读

让 Cursor 里 AI 的回复自动朗读出来。音色来自微软 Edge 神经网络语音（免费、无需 Key、不依赖 Cursor 后端），
断网或合成失败时回退到系统语音。Windows / macOS 都可用（Linux 尽力支持）。

最重要的一点：**朗读不消耗模型 token**。触发源完全在模型之外，内容不进入对话上下文。

## 三种触发方式

| 方式 | 触发时机 | 是否要手动操作 | token 成本 | 平台 |
| --- | --- | --- | --- | --- |
| **hooks（推荐）** | Agent 每完成**一条消息** | 不需要，配一次长期有效 | 0 | Win / mac |
| DOM 观察器（可选增强） | 正文**每出一句** | 每次重启 Cursor 要粘贴脚本 | 0 | Win / mac |
| MCP `speak` 工具 | 模型自己调用 | 不需要 | **有成本**，会重复一遍回复 | Win / mac |

三者都往本机 `127.0.0.1:51730/speak` 投递文本，扩展负责合成与播放。
DOM 观察器和 hooks 可以同时开，扩展侧有去重逻辑，同一段内容不会被念两遍。

> 想彻底零成本，就把「每轮回复前调用 speak 工具」那条规则删掉，只留 hooks。
> 那条规则会让模型把回复内容再生成一遍作为工具入参，等于每条回复多花一份输出 token，
> 并且会永久留在上下文里被反复重发。

## 安装扩展

任选其一：

### 方式 A：安装 VSIX（推荐）
1. `npm install` 然后 `npm run package`，生成 `cursor-auto-tts-0.1.0.vsix`
2. Cursor 中 `Ctrl+Shift+P` → `Extensions: Install from VSIX...` → 选择该文件
3. `Ctrl+Shift+P` → `Developer: Reload Window`

### 方式 B：从源码加载
1. 本目录执行 `npm install`
2. Cursor 中 `Ctrl+Shift+P` → `Developer: Install Extension from Location...` → 选择本目录

## 配置 hooks（零 token 自动朗读）

1. 在 `~/.cursor/hooks.json` 写入（macOS 路径换成你的实际路径）：

```json
{
  "version": 1,
  "hooks": {
    "afterAgentResponse": [
      {
        "command": "node \"C:\\Users\\flyingpig\\Desktop\\自动朗读\\cursor-auto-tts\\hooks\\after-agent-response.js\"",
        "timeout": 5
      }
    ]
  }
}
```

macOS 上不要直接写 `node`——从 Dock 启动的 Cursor 继承的是极简 PATH
（通常只有 `/usr/bin:/bin:/usr/sbin:/sbin`），Homebrew 或 nvm 装的 node 找不到。
用仓库自带的启动器，它会自己去找 node：

```json
"command": "/bin/sh \"/Users/你的用户名/Desktop/自动朗读/cursor-auto-tts/hooks/run-hook.sh\""
```

也可以参考 `hooks.json.macos.example`。启动器会依次尝试 PATH、
`/opt/homebrew/bin/node`、`/usr/local/bin/node`、nvm/volta/fnm 的默认路径；
如果你的 node 在别处，直接把绝对路径写进 `run-hook.sh`。

2. 重启 Cursor（或等它自动重载 hooks），状态栏点成「自动朗读:开」。

就这样。AI 每产出一条消息就会念一条，长任务中途的中间回复也会念，不用等整个任务跑完。

**为什么不用注册 `afterAgentThought`**：思考过程由那个 hook 投递，不注册它就永远不会被朗读。
代码块和 markdown 符号在扩展的 `cleanForSpeech` 里剥掉（可用 `cursorAutoTts.skipCodeBlocks` 关闭）。

### 分段合成 + 连续播放（缩短首字等待，段间不空档）

整条回复不会被一次性合成，也不会一段一段地「合成一段、播一段、等下一段」。现在的做法是：

- **切段**：按句末标点切成小段（每段最多 `segmentChars` 字，默认 60），第一段合成完就立刻出声。
- **并行合成**：同时在合成 `synthesisConcurrency` 段（默认 3）。edge-tts 的合成速度约是实时的 4 倍，
  3 路并行下来，后面的句子永远在你听前一句的时候就准备好了，不必停下来等合成。
- **成批播放**：把「已经合成好的连续几段」拼成一条 mp3 一次播完。这样播放器只启停一次到几次，
  而不是每句一次 —— 播放器的启停（Windows 上每次约 0.2 秒）正是以前那种「每句之间顿一下」的来源。
- **常驻播放进程**：Windows 上第一次朗读时会起一个后台 PowerShell 常驻进程，MCI 只初始化一次；
  以前每句都新开一个 PowerShell，冷启动要 1.2 秒以上，这才是段间长时间静默的主因。
- **语义停顿照旧**：拼接的是音频本身，每句自带的句尾留白仍然在，只去掉了多余的等待。

实测（一条 8 句、约 52 秒的回复）：首段出声约 2.5 秒，整条回复被合成 8 段、只播放了 **2 批**，
批与批之间没有可感知的空档。把 `segmentChars` 调小首段会更快出声；把 `synthesisConcurrency`
调到 1 则退化成「边合成边播」，网络较差时更容易出现空档。

### 验证 hooks 是否生效

- 日志：`~/.cursor/cursor-tts-hook.log`，每次触发会记一行 `speak chars=... enc#N`
- **实际朗读文本**：`~/.cursor/cursor-tts-spoken.log`，记录每一段真正送去合成的话，带来源标签
  （`[hook/stream]` hooks 或观察器、`[mcp]` MCP 工具、`[manual]` 手动）。想确认「念的和界面是否一致」就看这个文件。
- 解析异常：`~/.cursor/cursor-tts-hook-raw.log` 会保存原始 payload，用来定位编码/截断问题。
- 状态探测：浏览器或 PowerShell 访问 `http://127.0.0.1:51730/status`，应返回 `{"ok":true,"autoRead":true,...}`
- 想确认「工具调用之间的中间消息是否也触发」，把 `afterAgentResponse` 临时换成
  `hooks/debug-log.js`，跑一个长任务后看 `~/.cursor/cursor-tts-hook-debug.log` 有几条记录。

> Windows 上 Cursor 用 PowerShell 把 hook 的 JSON 管道喂进来，而 PowerShell 对原生进程的默认编码
> 是本地代码页（中文系统即 GBK），不是 UTF-8。GBK 的尾字节可能恰好是 `\`，按 UTF-8 解码会让 JSON
> 变成非法转义。hook 脚本因此会依次尝试 UTF-8 / UTF-16 / GBK 解码，取「能解析且没有替换字符」的那个。

## 可选：句级流式（DOM 观察器）

hooks 的粒度是「一条消息写完」。想要边出字边念，再叠加 DOM 观察器：

1. `Ctrl+Shift+P` → `Toggle Developer Tools`（**主窗口**的，不是扩展开发窗口）
2. Console 标签粘贴 `inject/observer.js` 全文，回车
3. 状态栏保持「自动朗读:开」

观察器的行为：按消息节点记已读偏移，凑够一句（`。！？；`）就投递；停顿 450ms 把半句也投递；
注入时把已有的历史全部标记为已读，不会把旧对话重念一遍。

**代价**：每次重启 Cursor 要重新粘贴一次；Cursor 升级若改动 DOM 结构，需要维护
`SELECTORS` / `STRIP_SELECTOR`。所以推荐以 hooks 为主，观察器按需开。

## 设置

`Ctrl+,` 搜索 `cursorAutoTts`：

- `voice`：音色，默认 `zh-CN-XiaoxiaoNeural`（晓晓）。可用 `npx edge-tts --list-voices` 查看全部。
- `rate`：语速，如 `+10%` / `-10%`。
- `skipCodeBlocks`：是否跳过代码块（默认开）。
- `codeBlockHint`：代码块替换成的朗读文本，设成空字符串就完全不出声。
- `segmentChars`：分段合成的最大字数（默认 60）。调小首段更快出声，但往返次数变多。
- `synthesisConcurrency`：并行合成的段数（默认 3，可设 1~8）。多段回复里靠它保证后面的句子提前合成好；
  设成 1 就退回「边合成边播」，网络慢时更容易出现段间空档。
- `fallbackToSystem`：edge-tts 连续两次失败时是否回退系统语音（默认开）。系统语音缺少抑扬顿挫，
  不想要就关掉，失败时静默跳过。
- `autoRead`：自动朗读总开关（默认开）。
- `minChunkChars`：流式分片的最小长度，太短的分片丢弃。
- `dedupe`：hooks 与观察器同时投递时只念没念过的部分（默认开）。

快捷键：`Alt+R` 朗读选中/剪贴板，`Ctrl+Alt+S` 停止。

## 跨平台说明

- **合成**：`msedge-tts` 是纯 Node 实现，Windows / macOS 行为一致。合成器会复用同一个
  WebSocket 连接并在失败时自动重连重试，所以正常情况不会掉到系统语音（这是「音色变难听」的常见原因）。
- **播放**：Windows 用常驻 PowerShell 进程 + `winmm.dll` 的 MCI 接口（无窗口、无 message pump），
  进程起不来或卡住时自动回退到「每次新开一个 powershell」；macOS 用系统自带的 `afplay`；
  Linux 依次尝试 `ffplay` / `mpg123`。
- **系统语音回退**：Windows SAPI / macOS `say` / Linux `espeak-ng`、`spd-say`。
- **hook 命令**：Windows 上 Cursor 用 PowerShell 执行 hook 并把 JSON 管道喂进来，
  macOS 是普通进程 stdin。脚本用 `node` 写，两端都能直接工作。

## 常见问题

- **没有声音**：确认系统音量；访问 `http://127.0.0.1:51730/status` 看扩展是否在跑；
  看 `~/.cursor/cursor-tts-play.log`。
- **hook 不触发**：确认 `~/.cursor/hooks.json` 路径正确、`node` 在 PATH 里；
  Cursor 的 `Customize → Hooks` 面板能看到已加载的 hooks 和错误。
- **念了两遍**：同时开了 MCP `speak` 规则和 hooks。删掉那条规则即可（去重只兜底明显重复）。
- **念的内容和界面不一样**：先看 `~/.cursor/cursor-tts-spoken.log` 的来源标签。
  `[mcp]` 说明是模型自己调 speak 工具写的复述，不是原文——删掉那条规则即可；
  `[hook/stream]` 则是原文经过清洗（代码块、markdown 符号、链接），属于预期差异，
  可用 `cursorAutoTts.codeBlockHint` 调整代码块提示语。
- **想换音色**：`voice` 可设为 `zh-CN-XiaoyiNeural`、`zh-CN-YunxiNeural`、`en-US-AriaNeural` 等。

## 自测

```bash
npm test
```

覆盖队列去重/增量、代码块剥离、并行合成与成批播放（`test/pipeline.test.js`）、
mp3 拼接、观察器切句与半句收尾（不发网络请求、不发声）。

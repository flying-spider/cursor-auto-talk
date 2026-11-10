// cursor-tts MCP server（零依赖，标准输入输出 stdio 协议）
//
// 提供一个工具 speak(text)：把文本朗读出来。
// 优先把文本 POST 给本机 Cursor Auto TTS 扩展（edge-tts 自然中文 + 网页音频播放）；
// 扩展未运行时，回退到 Windows SAPI 系统语音。
//
// 在 Cursor 里注册（~/.cursor/mcp.json）：
//   { "mcpServers": { "cursor-tts": {
//       "command": "node",
//       "args": ["C:\\Users\\flyingpig\\Desktop\\自动朗读\\mcp\\server.js"]
//   } } }

const readline = require('readline');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 51730;

const TOOLS = [
  {
    name: 'speak',
    description:
      '朗读一段文本给用户听。在结束回复之前，把你要回复的最终内容（去掉代码块和 Markdown 符号）作为 text 调用一次本工具，让用户能听到你的回复。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要朗读的文本（可含中文和英文）' },
      },
      required: ['text'],
    },
  },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function postToExtension(text) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ text, force: true });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/speak',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 2000,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(data);
    req.end();
  });
}

function speakSystem(text) {
  try {
    const s = String(text || '');
    let cmd;
    let args;
    if (process.platform === 'darwin') {
      cmd = 'say';
      args = [];
    } else if (process.platform === 'win32') {
      cmd = 'powershell';
      args = [
        '-NoProfile',
        '-Command',
        'Add-Type -AssemblyName System.Speech; $sp = New-Object System.Speech.Synthesis.SpeechSynthesizer; $sp.Speak([Console]::In.ReadToEnd())',
      ];
    } else {
      cmd = 'espeak-ng';
      args = ['-v', 'cmn'];
    }
    const ps = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    ps.stdin.write(s);
    ps.stdin.end();
  } catch (e) {
    /* ignore */
  }
}

async function doSpeak(text) {
  const ok = await postToExtension(text);
  if (!ok) speakSystem(text);
  return ok ? 'extension' : 'system';
}

function handle(method, params) {
  if (method === 'initialize') {
    return {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cursor-tts', version: '0.1.0' },
    };
  }
  if (method === 'tools/list') {
    return { tools: TOOLS };
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === 'speak') {
      const text = String(args.text || '');
      doSpeak(text); // fire-and-forget
      return { content: [{ type: 'text', text: 'ok' }] };
    }
    return { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true };
  }
  return null;
}

const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (!msg || typeof msg.method !== 'string') return;
  if (msg.method.startsWith('notifications/')) return; // 通知无需响应
  const result = handle(msg.method, msg.params);
  if (result !== null && result !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result });
  }
});

process.stdin.on('end', () => process.exit(0));

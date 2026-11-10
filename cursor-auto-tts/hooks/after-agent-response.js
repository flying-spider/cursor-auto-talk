// Cursor hook：afterAgentResponse -> 本机朗读桥接
//
// 作用：Agent 每完成一条助手消息，就把正文 POST 给扩展的 127.0.0.1:51730。
// 关键点：
//   - 进程外触发，不进入模型上下文，所以零 token；
//   - 只注册 afterAgentResponse（不注册 afterAgentThought），思考过程不会被念；
//   - 代码块、markdown 符号由扩展的 cleanForSpeech 剥掉；
//   - 只发 stream 分片、不带 force，所以状态栏「自动朗读」关掉时就真的不念。
//
// 注册方式（~/.cursor/hooks.json）：
//   { "version": 1, "hooks": { "afterAgentResponse": [
//       { "command": "node <绝对路径>/cursor-auto-tts/hooks/after-agent-response.js" } ] } }
//
// 排错：
//   ~/.cursor/cursor-tts-hook.log       每次触发的摘要 / 解析失败原因
//   ~/.cursor/cursor-tts-hook-raw.log   解析失败时保存的原始 payload（抓一次就能定位）

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 51730;
const LOG = path.join(os.homedir(), '.cursor', 'cursor-tts-hook.log');
const RAW_LOG = path.join(os.homedir(), '.cursor', 'cursor-tts-hook-raw.log');
const TIMEOUT_MS = 1200;
const RAW_KEEP = 40000;

function log(msg) {
  try {
    fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + msg + '\n');
  } catch (e) { /* ignore */ }
}

function dumpRaw(raw, reason) {
  try {
    const head = '[' + new Date().toISOString() + '] reason=' + reason + ' length=' + raw.length + '\n';
    fs.writeFileSync(RAW_LOG, head + raw.slice(0, RAW_KEEP) + '\n');
  } catch (e) { /* ignore */ }
}

/** 读取 stdin 原始字节。Windows 上 hook 由 PowerShell 管道喂入。 */
function readStdinBuffer() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', () => resolve(Buffer.alloc(0)));
  });
}

/**
 * 生成候选解码结果。
 *
 * 为什么需要这个：Windows 上 Cursor 用 PowerShell 把 JSON 管道喂进来，而
 * PowerShell 5.1 对原生进程的默认输出编码是本地代码页（中文 Windows 即 GBK），
 * 不是 UTF-8。GBK 的双字节尾字节可能恰好是 0x5C（反斜杠），按 UTF-8 解码后
 * 会在 JSON 字符串里凭空多出一个 `\`，导致 JSON.parse 失败并报 “Bad escaped
 * character”。所以这里把常见编码都试一遍，谁能解析成功就用谁。
 */
function decodeCandidates(buf) {
  const list = [];
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    list.push(buf.slice(2).toString('utf16le'));
  }
  if (buf.length >= 2 && buf[0] !== 0 && buf[1] === 0) {
    list.push(buf.toString('utf16le'));
  }
  list.push(buf.toString('utf8').replace(/^\uFEFF/, ''));
  for (const enc of ['gbk', 'gb18030', 'big5']) {
    try { list.push(new TextDecoder(enc).decode(buf)); } catch (e) { /* 该编码不可用 */ }
  }
  return list;
}

/** 从 raw 里取出第一个括号平衡的 JSON 对象（会跳过字符串内的括号）。 */
function firstBalancedObject(raw) {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 宽容解析：真实 hook payload 在 Windows 上可能带尾部杂质或被截断，
 * 依次尝试原始串、修剪串、最后一个 } 截断、首个平衡对象。
 */
function parsePayload(raw) {
  const attempts = [raw];
  const trimmed = raw.trim();
  if (trimmed !== raw) attempts.push(trimmed);
  const last = raw.lastIndexOf('}');
  if (last > 0 && last < raw.length - 1) attempts.push(raw.slice(0, last + 1));
  const balanced = firstBalancedObject(raw);
  if (balanced && balanced !== raw) attempts.push(balanced);

  let err = null;
  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === 'object') return { ok: true, value: v };
    } catch (e) { err = e; }
  }
  return { ok: false, error: err, balanced };
}

/** 兜底：直接从文本里抠出 "text":"..." 字段。 */
function fallbackText(raw) {
  const m = raw.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return '';
  try {
    return JSON.parse('"' + m[1] + '"');
  } catch (e) {
    return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

function post(body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: PORT,
          path: '/speak',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
          timeout: TIMEOUT_MS,
        },
        (res) => { res.resume(); res.on('end', finish); }
      );
      req.on('error', finish);
      req.on('timeout', () => { req.destroy(); finish(); });
      req.write(data);
      req.end();
    } catch (e) {
      finish();
    }
    // 兜底：无论如何不让 hook 挂住 agent 循环
    setTimeout(finish, TIMEOUT_MS + 200).unref();
  });
}

/** 统计替换字符数量：用来判断某个解码结果是不是「能解析但乱码」。 */
function countBad(s) {
  let bad = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0xfffd) bad++;
  }
  return bad;
}

async function main() {
  const buf = await readStdinBuffer();
  if (!buf.length) return;

  const candidates = decodeCandidates(buf);
  let best = null;      // { index, payload, text, bad }
  let text = '';
  let lastErr = null;

  for (let i = 0; i < candidates.length; i++) {
    const raw = candidates[i];
    const parsed = parsePayload(raw);
    if (!parsed.ok) {
      lastErr = parsed.error;
      if (!text) text = fallbackText(raw);   // 解析失败时也留一条兜底路径
      continue;
    }
    const t = String(parsed.value.text || '');
    const bad = countBad(t);
    if (!best || bad < best.bad) best = { index: i, payload: parsed.value, text: t, bad };
    if (bad === 0) break;                    // 无乱码，直接用
  }

  if (!best) {
    const raw = candidates[0] || '';
    const truncated = !raw.trimEnd().endsWith('}');
    const reason = [
      lastErr ? lastErr.message : 'unknown',
      'len=' + buf.length,
      truncated ? 'truncated' : 'tail-ok',
      'tail=' + JSON.stringify(raw.slice(-60)),
    ].join(' ');
    log('bad json: ' + reason);
    dumpRaw(raw, reason);
    if (!text) return;
    log('fallback text extracted chars=' + text.length);
  } else {
    text = best.text;
    if (best.bad > 0) {
      log('warn: 文本里有 ' + best.bad + ' 个替换字符，可能是编码不匹配');
    }
  }

  if (!text.trim()) return;

  log('speak chars=' + text.length
    + ' enc#' + (best ? best.index : -1)
    + ' conv=' + (best ? (best.payload.conversation_id || '-') : '-'));
  await post({ text, stream: true });
}

main()
  .catch((e) => log('fatal: ' + (e && e.message)))
  .then(() => process.exit(0));

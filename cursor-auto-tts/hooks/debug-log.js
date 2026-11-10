// 调试用 hook：把收到的 payload 原样写进日志，不做任何朗读。
//
// 用途：确认 afterAgentResponse 的实际触发时机与 input 结构
// （尤其是「工具调用之间的中间消息是否也触发」这个关键问题）。
//
// 用法：把 hooks.json 里的 afterAgentResponse 临时换成这个脚本，跑一个长任务，
// 然后看 ~/.cursor/cursor-tts-hook-debug.log 里有没有多条记录。

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = path.join(os.homedir(), '.cursor', 'cursor-tts-hook-debug.log');

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve('');
      if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return resolve(buf.slice(2).toString('utf16le'));
      }
      if (buf.length >= 2 && buf[0] !== 0 && buf[1] === 0) {
        return resolve(buf.toString('utf16le'));
      }
      resolve(buf.toString('utf8').replace(/^\uFEFF/, ''));
    });
    process.stdin.on('error', () => resolve(''));
  });
}

(async () => {
  const raw = await readStdin();
  let entry = { at: new Date().toISOString(), rawLength: raw.length };
  try {
    const j = JSON.parse(raw || '{}');
    entry.event = j.hook_event_name;
    entry.conversation_id = j.conversation_id;
    entry.generation_id = j.generation_id;
    entry.textLength = String(j.text || '').length;
    entry.textHead = String(j.text || '').slice(0, 300);
  } catch (e) {
    entry.parseError = String(e && e.message);
    entry.rawHead = raw.slice(0, 500);
  }
  try {
    fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
  } catch (e) { /* ignore */ }
  process.exit(0);
})();

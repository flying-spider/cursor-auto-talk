const http = require('http');

const PORT = 51730;

/**
 * 本机 HTTP 桥接服务。两个来源都往这里发：
 *   1. inject/observer.js —— DevTools 注入的 DOM 观察器，句级流式分片
 *   2. hooks/after-agent-response.js —— Cursor 原生 hook，消息级
 *
 * POST /speak   { text, force?, stream? }
 *   text   要朗读的文本
 *   force  true = 忽略「自动朗读」开关（MCP speak 工具用）
 *   stream true = 作为流式分片排进队列，不打断正在念的内容
 *
 * GET  /status  返回 { ok, autoRead }，方便排查 hook 是否打通
 */
class HttpBridge {
  constructor(onText, getStatus) {
    this.onText = onText;
    this.getStatus = getStatus || (() => ({}));
    this.server = null;
  }

  start() {
    if (this.server) return Promise.resolve();
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        if (req.method === 'OPTIONS') {
          res.writeHead(204); res.end(); return;
        }

        if (req.method === 'GET' && req.url === '/status') {
          let extra = {};
          try { extra = this.getStatus() || {}; } catch (e) { /* ignore */ }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(Object.assign({ ok: true }, extra)));
          return;
        }

        if (req.method === 'POST' && req.url === '/speak') {
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', () => {
            try {
              const j = JSON.parse(body);
              if (j && typeof j.text === 'string' && this.onText) {
                this.onText(j.text, { force: !!j.force, stream: !!j.stream });
              }
            } catch (e) { /* ignore malformed */ }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          });
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('cursor-auto-tts bridge ok');
      });

      this.server.on('error', (e) => {
        console.error('[cursor-auto-tts] bridge error:', e && e.message);
      });
      this.server.listen(PORT, '127.0.0.1', () => resolve());
    });
  }

  dispose() {
    if (this.server) { this.server.close(); this.server = null; }
  }
}

module.exports = { HttpBridge, PORT };

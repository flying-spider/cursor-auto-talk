const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TtsEngine } = require('./ttsEngine');
const { AudioPanel } = require('./audioPanel');
const { HttpBridge } = require('./httpBridge');
const { concatMp3 } = require('./mp3');
const player = require('./player');

const SPOKEN_LOG = path.join(os.homedir(), '.cursor', 'cursor-tts-spoken.log');
const SPOKEN_LOG_OFF = !!process.env.CURSOR_TTS_NO_LOG;

let engine = null;
let panel = null;
let bridge = null;
let statusBar = null;
let autoReadEnabled = false;
let queue = null;

/** 记录「实际送去朗读的文本」，用于和界面原文逐字比对。 */
function logSpoken(source, text) {
  if (SPOKEN_LOG_OFF) return;
  try {
    fs.appendFileSync(SPOKEN_LOG, '[' + new Date().toISOString() + '][' + source + '] ' + text + '\n');
  } catch (e) { /* ignore */ }
}

function cfg() {
  return vscode.workspace.getConfiguration('cursorAutoTts');
}

function cleanForSpeech(text) {
  let t = String(text || '');
  const skip = cfg().get('skipCodeBlocks', true);
  if (skip) {
    const hint = cfg().get('codeBlockHint', '，代码块省略，');
    t = t.replace(/```[\s\S]*?```/g, () => hint);
    t = t.replace(/`[^`\n]*`/g, '');
  }
  // strip markdown/images/links/html
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/[#>*_~|]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function updateStatus(playing) {
  if (!statusBar) return;
  if (playing) {
    statusBar.text = '$(sync~spin) 朗读中…';
    statusBar.tooltip = '点击停止朗读';
  } else if (autoReadEnabled) {
    statusBar.text = '$(megaphone) 自动朗读:开';
    statusBar.tooltip = '点击关闭自动朗读';
  } else {
    statusBar.text = '$(unmute) 朗读:关';
    statusBar.tooltip = '点击开启自动朗读（Alt+R 手动朗读）';
  }
  statusBar.show();
}

/**
 * 把一段文本切成适合逐段合成的片段。
 *
 * 目的：不必等整条回复都合成完才出声。第一段合成完就立刻播放，
 * 后面的段落在播放期间并行合成，听感上是连续的。
 * 优先在句末标点切；单句过长时再退到逗号/顿号处切。
 */
function splitSegments(text, maxChars) {
  const max = Math.max(20, Number(maxChars) || 60);
  const source = String(text || '');

  // 1) 先按句末标点切成句子
  const sentences = [];
  let cur = '';
  for (const ch of source) {
    cur += ch;
    if ('。！？；!?;\n'.includes(ch)) {
      sentences.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) sentences.push(cur.trim());

  // 2) 单句过长时，在逗号/顿号处再切
  const pieces = [];
  for (const s of sentences) {
    if (!s) continue;
    let rest = s;
    while (rest.length > max) {
      let cut = -1;
      for (let i = Math.min(max, rest.length - 1); i > max / 2; i--) {
        if ('，,、:：'.includes(rest[i])) { cut = i; break; }
      }
      if (cut < 0) cut = max;
      pieces.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) pieces.push(rest);
  }

  // 3) 只有极短碎片（如「好。」）才和相邻段合并，避免为两个字符单独合成一次
  const out = [];
  for (const p of pieces) {
    const last = out.length ? out[out.length - 1] : '';
    if (last && (p.length < 5 || last.length < 5) && last.length + p.length <= max) {
      out[out.length - 1] = last + p;
      continue;
    }
    out.push(p);
  }

  return out.length ? out : (source.trim() ? [source.trim()] : []);
}

/**
 * 朗读队列：并行合成 + 成批连续播放。
 *
 * 为什么要队列：流式朗读会把一条回复切成很多片，如果每片都像以前那样先
 * player.stop() 再播，就会把上一句拦腰掐断。队列保证「一片播完再播下一片」。
 *
 * 为什么还要「成批」：
 *  - 合成：一次并行合成 synthesisConcurrency 段（默认 3），而不是等上一段播完
 *    才去合成下一段。edge-tts 的合成速度大约是实时的 4 倍，3 路并行下来音频
 *    永远跑在播放前面，段与段之间不必等合成。
 *  - 播放：每调一次系统播放器就要付一次 MCI open/close 的开销（Windows 上
 *    ~0.2 秒），所以把「已经合成好的连续段」拼成一条 mp3 一次播完。
 *    一条 15 段的回复通常只需要 2～3 次播放，段间空档从每段一次降到每批一次。
 *  - 语义停顿不受影响：拼接口语料，每段自带的句尾留白仍在，只是去掉了
 *    「等下一段合成/等播放器启动」造成的死气。
 *
 * 去重：hook（整条消息）和 DOM 观察器（逐句分片）会同时投递同一段内容，
 * 这里用一个滚动窗口记录刚念过的文本，只念「还没念过的那部分」。
 */
class SpeechQueue {
  constructor(ttsEngine) {
    this.engine = ttsEngine;
    this.frames = [];      // 按顺序排列的分段：{ text, buf, task, failed }
    this.busy = false;     // 播放循环是否在跑
    this.gen = 0;          // 打断计数：打断后旧任务不再出声
    this.tail = '';        // 已朗读文本的尾部（归一化），用于去重
    this.tailMax = 8000;
    this.inflight = 0;     // 当前并行合成中的段数
    this._wakers = new Set();
  }

  /** 清掉待念内容并打断当前播放。resetTail=true 时同时清空去重窗口。 */
  interrupt(resetTail) {
    this.gen++;
    this.frames.length = 0;
    this.inflight = 0;
    if (resetTail) this.tail = '';
    this._notify();
    player.stop();
  }

  /**
   * @param {string} rawText
   * @param {{stream?: boolean, minChars?: number, source?: string}} opts
   * @returns {boolean} 是否真的排队了内容
   */
  enqueue(rawText, opts) {
    const o = opts || {};
    const clean = cleanForSpeech(rawText);
    const minChars = typeof o.minChars === 'number' ? o.minChars : 2;
    if (!clean || clean.length < minChars) return false;

    const fresh = cfg().get('dedupe', true) ? this._delta(clean) : clean;
    if (!fresh || fresh.length < minChars) return false;

    logSpoken(o.source || 'unknown', fresh);

    const maxSeg = cfg().get('segmentChars', 60);
    const segments = splitSegments(fresh, maxSeg);
    this.tail = (this.tail + fresh).slice(-this.tailMax);
    for (const seg of segments) this.frames.push({ text: seg, buf: null, task: null, failed: false });

    player.prewarm();     // 让常驻播放进程在合成这几秒里把 MCI 编译好
    this._fill();
    this._pump();
    return true;
  }

  /** 计算「这段内容里还没念过的部分」。 */
  _delta(text) {
    const tail = this.tail;
    if (!tail) return text;
    if (tail.includes(text)) return '';            // 整段都说过了
    const maxK = Math.min(200, text.length, tail.length);
    for (let k = maxK; k >= 4; k--) {               // 接着上次的结尾往下念
      if (text.startsWith(tail.slice(-k))) return text.slice(k);
    }
    // 结尾一致且不比已念内容长：判定为重复投递
    if (tail.length >= 30 && text.length <= tail.length && text.endsWith(tail.slice(-24))) {
      return '';
    }
    return text;
  }

  /** 等一个事件（合成完成）或超时。 */
  _wait(ms) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._wakers.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this._wakers.add(finish);
    });
  }

  _notify() {
    for (const w of Array.from(this._wakers)) w();
    this._wakers.clear();
  }

  /** 把并行合成补满：始终让最靠前的若干段同时合成。 */
  _fill() {
    const max = Math.max(1, Math.min(8, Number(cfg().get('synthesisConcurrency', 3)) || 3));
    for (const f of this.frames) {
      if (this.inflight >= max) break;
      if (f.buf || f.task || f.failed) continue;
      const gen = this.gen;
      this.inflight++;
      f.task = this.engine.synthesize(f.text)
        .then((b) => {
          if (gen !== this.gen) return;
          if (b && b.length) f.buf = b;
          else f.failed = true;
        })
        .catch(() => { if (gen === this.gen) f.failed = true; })
        .then(() => {
          if (gen !== this.gen) return;
          this.inflight = Math.max(0, this.inflight - 1);
          f.task = null;
          this._fill();        // 有空位就继续往后合成
          this._notify();      // 叫醒等音频的播放循环
        });
    }
  }

  async _pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.frames.length) {
        const gen = this.gen;
        const head = this.frames[0];

        if (!head.buf && !head.failed) {
          this._fill();
          if (!head.buf && !head.failed) {
            await this._wait(1000);    // 等这一段（或更靠前的段）合成完
            continue;
          }
          if (gen !== this.gen) break;
        }
        if (gen !== this.gen) break;

        if (!head.buf) {
          // 合成失败：这一段退回系统语音，接着念后面
          const text = this.frames.shift().text;
          if (cfg().get('fallbackToSystem', true)) await player.speakNative(text);
          continue;
        }

        // 已合成好的连续段一次播完，把播放器的启动/切换开销摊薄
        const batch = [];
        while (this.frames.length && this.frames[0].buf) batch.push(this.frames.shift());
        const buf = concatMp3(batch.map((f) => f.buf));

        updateStatus(true);
        const played = await player.playMp3Buffer(buf);
        if (gen !== this.gen) break;
        if (!played && cfg().get('fallbackToSystem', true)) {
          await player.speakNative(batch.map((f) => f.text).join(''));
        }
      }
    } catch (e) {
      console.error('[cursor-auto-tts] speak error:', e && e.message);
    } finally {
      this.busy = false;
      if (this.frames.length) {
        this._pump();               // 兜住入队与退出之间的竞态
      } else {
        updateStatus(false);
      }
    }
  }
}

/** 一次性朗读（手动触发 / MCP）：打断当前内容后整段念。 */
function speakNow(text, opts) {
  queue.interrupt(!!(opts && opts.resetDedupe));
  return queue.enqueue(text, { source: (opts && opts.source) || 'manual' });
}

async function readClipboard() {
  // prefer active editor selection, then clipboard
  const ed = vscode.window.activeTextEditor;
  if (ed && !ed.selection.isEmpty) {
    const sel = ed.document.getText(ed.selection);
    if (sel && sel.trim()) {
      speakNow(sel, { resetDedupe: true, source: 'manual' });
      return;
    }
  }
  const clip = await vscode.env.clipboard.readText();
  speakNow(clip, { resetDedupe: true, source: 'manual' });
}

function stop() {
  queue.interrupt(true);
  if (panel) panel.stop();
  updateStatus(false);
}

function toggle() {
  autoReadEnabled = !autoReadEnabled;
  cfg().update('autoRead', autoReadEnabled, vscode.ConfigurationTarget.Global);
  updateStatus(false);
  vscode.window.setStatusBarMessage(autoReadEnabled ? '已开启自动朗读' : '已关闭自动朗读', 2000);
}

async function activate(context) {
  engine = new TtsEngine();
  panel = new AudioPanel(context);
  queue = new SpeechQueue(engine);

  bridge = new HttpBridge(
    (text, opts) => {
      const o = opts || {};
      if (!o.force && !autoReadEnabled) return;
      if (o.stream) {
        // 流式分片：排队，不打断；长度门槛由投递方（观察器/hook）把控
        queue.enqueue(text, { minChars: 2, source: 'hook/stream' });
      } else {
        speakNow(text, { source: o.force ? 'mcp' : 'manual' });
      }
    },
    () => ({ autoRead: autoReadEnabled, minChunkChars: cfg().get('minChunkChars', 12) })
  );

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'cursorAutoTts.toggle';

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorAutoTts.readClipboard', readClipboard),
    vscode.commands.registerCommand('cursorAutoTts.stop', stop),
    vscode.commands.registerCommand('cursorAutoTts.toggle', toggle),
    statusBar
  );

  autoReadEnabled = cfg().get('autoRead', false);
  updateStatus(false);

  await bridge.start();
  vscode.window.setStatusBarMessage('Cursor Auto TTS 已就绪（Alt+R 朗读）', 3000);
}

function deactivate() {
  if (queue) queue.interrupt();
  if (engine && engine.dispose) engine.dispose();
  if (bridge) bridge.dispose();
  if (player.shutdown) player.shutdown();
}

module.exports = { activate, deactivate, SpeechQueue, splitSegments };

const vscode = require('vscode');

function collectStream(s) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    s.on('data', (c) => chunks.push(c));
    s.on('end', () => resolve(Buffer.concat(chunks)));
    s.on('error', reject);
  });
}

/** 给一个 Promise 加超时，避免 WebSocket 静默断连时永远等不到 end。 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' 超时')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/**
 * edge-tts（微软 Edge 朗读）合成器。
 *
 * 两个要点：
 *  1. 复用同一个 WebSocket 连接。以前每段文本都 new 一个实例，等于每念一句都要
 *     重新握手一次，既慢又更容易超时失败（失败就会掉到难听的系统语音）。
 *     现在只在首次或出错重建时连接。
 *  2. 返回 Buffer 而不是 base64 data URI，省掉一次无意义的编解码。
 */
class TtsEngine {
  constructor() {
    this.client = null;
    this.voice = '';
    this.inflight = 0;   // 当前在这条连接上并行合成中的段数
  }

  _config() {
    const cfg = vscode.workspace.getConfiguration('cursorAutoTts');
    return {
      voice: cfg.get('voice', 'zh-CN-XiaoxiaoNeural'),
      rate: cfg.get('rate', '+0%'),
    };
  }

  async _ensureClient(voice) {
    if (this.client && this.voice === voice) return this.client;
    // 并发调用时共用同一次建连，避免互相 close 掉对方刚建好的连接
    if (this._creating && this._creatingVoice === voice) return this._creating;

    const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
    this.dispose();

    this._creatingVoice = voice;
    this._creating = (async () => {
      const client = new MsEdgeTTS({
        connectionTimeoutMs: 15000,
        synthesisTimeoutMs: 30000,
      });
      await client.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      this.client = client;
      this.voice = voice;
      return client;
    })();

    try {
      return await this._creating;
    } finally {
      this._creating = null;
      this._creatingVoice = '';
    }
  }

  async _synthesizeOnce(text, voice, rate) {
    const client = await this._ensureClient(voice);
    const { audioStream } = client.toStream(text, { rate });
    return withTimeout(collectStream(audioStream), 20000, 'edge-tts 合成');
  }

  /**
   * 合成一段文本，返回 mp3 Buffer；失败返回 null（由调用方决定是否回退系统语音）。
   * 失败会自动重建连接并重试一次，把因为连接老化导致的偶发回退挡掉。
   *
   * 注意：现在是多段并行合成共用同一条 WebSocket，某一段失败时不能直接关连接，
   * 否则会把其它正在收流的段一起掐死。只有「这条连接上只剩我自己」时才重建。
   */
  async synthesize(text) {
    const { voice, rate } = this._config();
    this.inflight++;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const buf = await this._synthesizeOnce(text, voice, rate);
          if (buf && buf.length > 0) return buf;
          throw new Error('空音频');
        } catch (e) {
          console.error('[cursor-auto-tts] edge-tts 第 ' + (attempt + 1) + ' 次失败:', e && e.message);
          if (this.inflight <= 1) this.dispose();
        }
      }
      return null;
    } finally {
      this.inflight--;
    }
  }

  dispose() {
    if (this.client) {
      try { this.client.close(); } catch (e) { /* ignore */ }
      this.client = null;
      this.voice = '';
    }
  }
}

module.exports = { TtsEngine };

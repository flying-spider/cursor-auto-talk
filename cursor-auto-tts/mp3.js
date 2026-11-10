// MP3 小工具：把多段 edge-tts 合成结果拼成一个连续的 mp3 流 + 粗估时长。
//
// 为什么可以直接拼接：
//   edge-tts 关掉 metadata 后，返回的是纯 MPEG 帧（没有 ID3 头），
//   帧与帧之间彼此独立，把两段 Buffer 首尾相连就是一条合法的 mp3 流。
//   实测（probe.js）拼接后的时长严格等于各段时长之和。
//
// 拼接的意义：每调一次系统播放器就要付一次进程启动 / MCI open 的开销
//   （Windows 上约 0.2 秒，冷启动还会更久），所以「一次播多段」比「多段各播一次」
//   在听感上连续得多。语义上的停顿由每段自带的尾音留白保留。

/** 去掉 ID3v2 头（防御性：万一将来换成带标签的输出格式）。 */
function stripId3v2(buf) {
  if (!buf || buf.length < 10) return buf;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return buf; // "ID3"
  const size =
    ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const footer = buf[5] & 0x10 ? 10 : 0;
  const end = 10 + size + footer;
  return end < buf.length ? buf.subarray(end) : Buffer.alloc(0);
}

/** 去掉尾部 ID3v1 标签（128 字节，以 "TAG" 开头）。 */
function stripId3v1(buf) {
  if (!buf || buf.length < 128) return buf;
  const i = buf.length - 128;
  if (buf[i] === 0x54 && buf[i + 1] === 0x41 && buf[i + 2] === 0x47) return buf.subarray(0, i);
  return buf;
}

/**
 * 顺序拼接多段 mp3。
 * @param {Buffer[]} buffers
 * @returns {Buffer}
 */
function concatMp3(buffers) {
  const list = (buffers || []).filter((b) => b && b.length);
  if (!list.length) return Buffer.alloc(0);
  if (list.length === 1) return stripId3v1(stripId3v2(list[0]));
  const parts = list.map((b) => stripId3v1(stripId3v2(b)));
  return Buffer.concat(parts);
}

const BYTES_PER_MS = 6; // 24kHz 48kbps 单声道 mp3 => 6000 字节/秒

/** 按字节数粗估播放时长（毫秒），只用于判断「这段够不够长」，不需要精确。 */
function estimateDurationMs(buf) {
  if (!buf || !buf.length) return 0;
  return Math.round(buf.length / BYTES_PER_MS);
}

module.exports = { concatMp3, estimateDurationMs, stripId3v2, stripId3v1 };

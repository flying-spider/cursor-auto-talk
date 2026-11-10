// 朗读流水线自测：并行合成 + 成批连续播放 + 打断清理。
// 运行：node test/pipeline.test.js   （不发网络请求、不发声）
//
// 覆盖的核心行为：
//  1. 多段文本会同时合成（并发上限内），播放顺序仍严格按入队顺序；
//  2. 已合成好的连续段被拼成一条音频一次播完，不会一段一次地调播放器；
//  3. 拼接口没有丢字、没有乱序；
//  4. 打断后旧内容既不出声也不再合成新的。
const Module = require('module');
const path = require('path');
const origLoad = Module._load;

process.env.CURSOR_TTS_NO_LOG = '1';

Module._load = function (req) {
  if (req === 'vscode') {
    return {
      workspace: { getConfiguration: () => ({ get: (k, d) => d }) },
      window: { createStatusBarItem: () => ({ show() {}, hide() {} }), activeTextEditor: null },
      StatusBarAlignment: { Right: 2 },
      commands: { registerCommand: () => ({ dispose() {} }) },
      ConfigurationTarget: { Global: 1 },
      env: { clipboard: { readText: async () => '' } },
    };
  }
  return origLoad.apply(this, arguments);
};

const root = path.join(__dirname, '..');

// 把播放层换成「只记录不发声」，每次播放耗时 200ms（模拟真实的一段音频）
const plays = [];
const player = require(path.join(root, 'player.js'));
player.playMp3Buffer = (buf) => {
  plays.push(Buffer.from(buf));
  return new Promise((r) => setTimeout(() => r(true), 200));
};
player.speakNative = () => Promise.resolve(false);
player.stop = () => {};
player.prewarm = () => {};

const { SpeechQueue } = require(path.join(root, 'extension.js'));
const { concatMp3, estimateDurationMs, stripId3v2 } = require(path.join(root, 'mp3.js'));

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  -> ' + JSON.stringify(actual) + (ok ? '' : ' (期望 ' + JSON.stringify(expected) + ')'));
  ok ? pass++ : fail++;
}
function checkTrue(name, cond, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(detail)));
  cond ? pass++ : fail++;
}

/** 可控合成器：每段延迟 delayMs 后返回 [文本]，并统计真实并发数。 */
function makeEngine(delayMs) {
  const api = { parallel: 0, maxParallel: 0, order: [], started: 0 };
  api.synthesize = (text) => {
    api.started++;
    api.order.push(text);
    api.parallel++;
    api.maxParallel = Math.max(api.maxParallel, api.parallel);
    return new Promise((resolve) => {
      setTimeout(() => {
        api.parallel--;
        resolve(Buffer.from('[' + text + ']'));
      }, delayMs);
    });
  };
  return api;
}

function waitFor(cond, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 3000);
  return new Promise((resolve) => {
    const tick = () => {
      if (cond()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 10);
    };
    tick();
  });
}

const TEXT = '这是第一句话。这是第二句话。这是第三句话。这是第四句话。这是第五句话。这是第六句话。';
const SEGMENTS = ['这是第一句话。', '这是第二句话。', '这是第三句话。', '这是第四句话。', '这是第五句话。', '这是第六句话。'];

(async () => {
  // 1) 并行合成 + 成批播放
  const engine = makeEngine(30);
  const q = new SpeechQueue(engine);
  q.enqueue(TEXT);
  check('入队后拆成 6 段', q.frames.length, 6);
  check('同时开始合成 3 段（并发上限）', engine.maxParallel, 3);

  const done = await waitFor(() => q.frames.length === 0 && plays.length > 0, 4000);
  checkTrue('队列念完', done, { frames: q.frames.length, plays: plays.length });
  checkTrue('合成并发数不超过 3', engine.maxParallel <= 3, engine.maxParallel);
  checkTrue('没有一段一次地播（批次 ≤ 3 次）', plays.length <= 3, plays.length);

  const joined = plays.map((b) => b.toString()).join('');
  check('拼接内容完整且顺序正确', joined, SEGMENTS.map((s) => '[' + s + ']').join(''));

  // 2) 打断：旧内容不出声
  plays.length = 0;
  const slow = makeEngine(80);
  const q2 = new SpeechQueue(slow);
  q2.enqueue(TEXT);
  q2.interrupt(true);
  await new Promise((r) => setTimeout(r, 300));
  check('打断后不再播放', plays.length, 0);
  check('打断后队列清空', q2.frames.length, 0);

  // 3) 打断后还能正常继续
  const fast = makeEngine(10);
  const q3 = new SpeechQueue(fast);
  plays.length = 0;
  q3.enqueue('打断之后重新朗读。');
  const ok3 = await waitFor(() => plays.length > 0, 2000);
  checkTrue('打断后新的内容能正常播', ok3, plays.length);
  check('打断后播的是新内容', plays.map((b) => b.toString()).join(''), '[打断之后重新朗读。]');

  // 4) mp3 拼接工具
  check('纯帧直接拼接', concatMp3([Buffer.from('ab'), Buffer.from('cd')]).toString(), 'abcd');
  const withId3 = Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08]), // ID3v2 头，标签内容 8 字节
    Buffer.from('PADDING!'),
    Buffer.from('FRAMES'),
  ]);
  check('ID3 头被剥掉', stripId3v2(withId3).toString(), 'FRAMES');
  check('拼接时剥掉第二段的 ID3 头', concatMp3([Buffer.from('AA'), withId3]).toString(), 'AAFRAMES');
  check('时长估算：6000 字节 ≈ 1 秒', estimateDurationMs(Buffer.alloc(6000)), 1000);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();

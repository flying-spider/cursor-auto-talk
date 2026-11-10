// 队列去重 / 增量逻辑自测：不联网、不发声，只验证算法。
// 运行：node test/queue.test.js
const Module = require('module');
const path = require('path');
const origLoad = Module._load;

process.env.CURSOR_TTS_NO_LOG = '1';   // 自测不要污染 ~/.cursor/cursor-tts-spoken.log

// 在 Cursor 之外跑时用假 vscode 模块，让 extension.js 能被 require
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
const player = require(path.join(root, 'player.js'));
player.speakNative = () => Promise.resolve(false);
player.playMp3Buffer = () => Promise.resolve(false);
player.stop = () => {};
player.prewarm = () => {};

const { SpeechQueue, splitSegments } = require(path.join(root, 'extension.js'));

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  -> ' + JSON.stringify(actual) + (ok ? '' : ' (期望 ' + JSON.stringify(expected) + ')'));
  ok ? pass++ : fail++;
}

// 永不 resolve 的合成器：让第一段停在「正在念」，后续段落排队
const engine = { synthesize: () => new Promise(() => {}) };

// 1. 去重窗口
const q1 = new SpeechQueue(engine);
check('首次入队', q1.enqueue('今天天气不错。'), true);
check('完全相同再入队被去重', q1.enqueue('今天天气不错。'), false);

// 2. 增量：同一段文本继续增长
const q2 = new SpeechQueue(engine);
q2.enqueue('这句话还没说完');
check('增长部分只念新增', q2._delta('这句话还没说完，后面还有内容。'), '，后面还有内容。');

// 3. 分片后整条消息重复投递（hook 与观察器并存）
const q3 = new SpeechQueue(engine);
q3.enqueue('第一句话。');
q3.enqueue('第二句话。');
check('整条重复投递被去重', q3.enqueue('第一句话。第二句话。'), false);

// 4. 显式停止后重念同一段应该出声
const q4 = new SpeechQueue(engine);
q4.enqueue('重复朗读测试。');
q4.interrupt(true);
check('停止后清空去重窗口', q4.enqueue('重复朗读测试。'), true);

// 5. 代码块剥离
const q5 = new SpeechQueue(engine);
q5.enqueue('这是说明文字。\n\n```js\nconst a = 1;\n```\n\n后面还有一句。');
check('代码块不被朗读', q5.tail.includes('const a = 1'), false);
check('正文保留', q5.tail.includes('这是说明文字'), true);

// 6. 流式排队顺序：并行合成，但播放顺序严格按入队顺序
const q6 = new SpeechQueue(engine);
q6.enqueue('第一片内容。');
q6.enqueue('第二片内容。');
q6.enqueue('第三片内容。');
check('三段按入队顺序排列', q6.frames.map((f) => f.text), ['第一片内容。', '第二片内容。', '第三片内容。']);
check('并行合成不超过并发上限（默认 3）', q6.inflight, 3);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');

// 7. 分段合成
check('按句切段', splitSegments('第一句话。第二句话！第三句？', 60), ['第一句话。', '第二句话！第三句？']);
check('极短碎片与相邻段合并', splitSegments('嗯。明白了，我马上处理。', 60).length, 1);
const longSegs = splitSegments('这是一个很长很长的句子，需要被切成多段，才能尽快开始播放，不至于让用户等太久。', 20);
check('长句在逗号处切且不超长', longSegs.every((s) => s.length <= 21), true);
check('切段后内容不丢失', longSegs.join('').replace(/\s/g, ''), '这是一个很长很长的句子，需要被切成多段，才能尽快开始播放，不至于让用户等太久。'.replace(/\s/g, ''));
check('空文本不产生分段', splitSegments('   ', 60).length, 0);

console.log('追加结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);

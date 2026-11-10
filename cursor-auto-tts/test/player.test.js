// 播放层平台分支自测：在 Windows 上也能验证 macOS 的调用路径。
// 运行：node test/player.test.js
//
// 做法：把 process.platform 伪装成 darwin，并替换 child_process.spawn，
// 检查播放走的是 afplay、语音回退走的是 say（而不是 powershell）。

const Module = require('module');
const { EventEmitter } = require('events');

const calls = [];

function fakeSpawn(cmd, args, opts) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = {
    end(text) { child._input = text; },
    write(text) { child._input = text; },
  };
  calls.push({ cmd, args, opts, child });
  setImmediate(() => child.emit('close', 0));
  return child;
}

const origLoad = Module._load;
Module._load = function (req) {
  if (req === 'child_process') return { spawn: fakeSpawn };
  if (req === 'vscode') {
    return { workspace: { getConfiguration: () => ({ get: (k, d) => d }) } };
  }
  return origLoad.apply(this, arguments);
};

Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

const path = require('path');
const player = require(path.join(__dirname, '..', 'player.js'));

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ' -> ' + JSON.stringify(actual) + (ok ? '' : ' 期望 ' + JSON.stringify(expected)));
  ok ? pass++ : fail++;
}

(async () => {
  const ok = await player.playMp3Buffer(Buffer.from([0x49, 0x44, 0x33]));
  check('mp3 播放成功', ok, true);
  check('macOS 用 afplay 播放', calls[0].cmd, 'afplay');
  check('afplay 收到临时文件路径', /\.mp3$/.test(calls[0].args[0]), true);

  calls.length = 0;
  const spoken = await player.speakNative('你好，这是语音回退测试。');
  check('系统语音回退成功', spoken, true);
  check('macOS 用 say 而非 powershell', calls[0].cmd, 'say');
  check('文本通过 stdin 传给 say', calls[0].child._input, '你好，这是语音回退测试。');

  calls.length = 0;
  player.stop();
  check('stop 不报错', true, true);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();

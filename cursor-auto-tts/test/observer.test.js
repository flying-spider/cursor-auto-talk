// 观察器增量切句逻辑自测：用最小假 DOM，不发网络请求、不发声。
// 运行：node test/observer.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const posted = [];
let observerCb = null;

class El {
  constructor(text) { this.textContent = text; }
  cloneNode() { return new El(this.textContent); }
  querySelectorAll() { return []; }
  contains() { return false; }
}

const msg = new El('历史消息，不应该被念。');

const sandbox = {
  console: { log() {} },
  setTimeout,
  clearTimeout,
  Set,
  WeakMap,
  Array,
  Math,
  JSON,
  Promise,
  fetch: (url, opts) => {
    if (opts && opts.body) posted.push(JSON.parse(opts.body));
    return Promise.resolve({ json: () => Promise.resolve({}) });
  },
  MutationObserver: class {
    constructor(cb) { observerCb = cb; }
    observe() {}
  },
  document: {
    body: {},
    querySelectorAll(sel) {
      if (sel === '[data-role="assistant"]') return [msg];
      return [];
    },
  },
};

const code = fs.readFileSync(
  path.join(__dirname, '..', 'inject', 'observer.js'),
  'utf8'
);
vm.runInNewContext(code, sandbox);

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ' -> ' + JSON.stringify(actual) + (ok ? '' : ' 期望 ' + JSON.stringify(expected)));
  ok ? pass++ : fail++;
}

(async () => {
  await tick(50);
  check('注入时不念历史', posted.length, 0);

  // 第一个流式片段
  msg.textContent = '历史消息，不应该被念。第一句新内容已经足够长了。';
  observerCb([]);
  await tick(250);
  check('新增内容被投递', posted.length, 1);
  check('只念新增部分', posted[0].text, '第一句新内容已经足够长了。');
  check('标记为流式', posted[0].stream, true);

  // 继续增长：短句先攒着，等停顿窗口收尾
  msg.textContent += '第二句也出来了。';
  observerCb([]);
  await tick(700);
  check('后续增长继续投递', posted.length, 2);
  check('第二句内容正确', posted[1].text, '第二句也出来了。');

  // 半句停顿后收尾
  msg.textContent += '没有句号的半句';
  observerCb([]);
  await tick(700);
  check('停顿后把半句补发', posted.length, 3);
  check('半句内容正确', posted[2].text, '没有句号的半句');

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();

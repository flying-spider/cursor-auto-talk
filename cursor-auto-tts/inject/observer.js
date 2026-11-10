// Cursor 聊天面板「句级流式」朗读监听脚本
// （一次性注入，用于 DevTools Console；作为 hooks 方案的增强/备选）
//
// 用法：
//   1. Cursor 里 Ctrl+Shift+P -> "Toggle Developer Tools" -> 回车
//      （打开「主窗口」的开发者工具，不是扩展开发窗口）。
//   2. Console 标签页粘贴本文件全部内容，回车。
//   3. 状态栏「自动朗读:开」时生效（也可设 cursorAutoTts.autoRead=true）。
//
// 与旧版（等整段回复结束才念）的区别：
//   - 按消息节点记录「已朗读偏移」，只投递新增文本；
//   - 按句末标点切片，凑够一句就发一句，边出字边念；
//   - 停顿 SENTENCE_QUIET_MS 后把剩下的半句也发出去；
//   - 过滤思考块 / 代码块 / 按钮等非正文内容；
//   - 注入时把已有历史标记为「已念」，避免刚粘贴就把旧对话全念一遍。
//
// 注意：每次重启 Cursor 后需要重新粘贴一次（这也是推荐用 hooks 的原因）。

(function () {
  const PORT = 51730;
  const SCAN_MS = 120;             // DOM 变化合并窗口
  const SENTENCE_QUIET_MS = 450;   // 这么久没有新内容就把半句先念了
  const MIN_EMIT = 10;             // 单次投递的最小长度
  const MAX_PENDING = 120;         // 攒够这么长就整段投递

  // 候选的 AI 消息选择器（多版本兼容，取并集；可自行增删）
  const SELECTORS = [
    '[data-role="assistant"]',
    '[data-message-role="assistant"]',
    '[data-message-author-type="ai"]',
    '[data-testid="assistant-message"]',
    '[data-testid*="assistant" i]',
    '.assistant-message',
    '.chat-message-ai',
    '.agent-turn',
    '.claude-message',
    '.message-block[data-role="assistant"]',
    '[class*="assistant-message" i]',
    '[class*="ai-message" i]',
    '[class*="agent-turn" i]',
  ];

  // 提取正文前先从副本里删掉的节点：代码、按钮、图标、思考过程
  const STRIP_SELECTOR = [
    'pre',
    'code',
    'button',
    '[role="button"]',
    'svg',
    '[data-testid*="thinking" i]',
    '[data-testid*="thought" i]',
    '[class*="thinking" i]',
    '[class*="reasoning" i]',
    'details',
  ].join(', ');

  const state = new WeakMap(); // el -> { last: string, pending: string }
  const MAX_TRACKED = 6;       // 只跟踪最近几条消息节点，避免遍历整段历史
  let sendChain = Promise.resolve();
  let minEmit = MIN_EMIT;
  let scanTimer = null;
  let quietTimer = null;

  // 从扩展的 /status 读一下阈值，读不到就用默认值
  fetch('http://127.0.0.1:' + PORT + '/status')
    .then((r) => r.json())
    .then((j) => {
      if (j && typeof j.minChunkChars === 'number' && j.minChunkChars > 0) {
        minEmit = j.minChunkChars;
      }
    })
    .catch(function () {});

  function extractText(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll(STRIP_SELECTOR).forEach(function (el) { el.remove(); });
    let t = clone.textContent || '';
    // 去掉 “Thought for 3s” 之类的思考摘要行
    t = t.replace(/^\s*(Thought for .{0,30}|思考了?.{0,15})\s*$/gim, '');
    return t.replace(/\s+/g, ' ').trim();
  }

  /** 找最长公共前缀长度，用于应对 Cursor 的重排/重渲染。 */
  function commonPrefix(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
  }

  function isSentenceEnd(ch) {
    return ch === '。' || ch === '！' || ch === '？' || ch === '；'
      || ch === '!' || ch === '?' || ch === ';' || ch === '\n';
  }

  /** 把 buffer 里已经完整的句子切出来：返回 [要念的, 剩下的] */
  function takeComplete(buffer) {
    let last = -1;
    for (let i = 0; i < buffer.length; i++) {
      if (isSentenceEnd(buffer[i])) last = i;
    }
    if (last < 0) return [null, buffer];
    return [buffer.slice(0, last + 1), buffer.slice(last + 1)];
  }

  function send(text, force) {
    const t = (text || '').trim();
    if (t.length < (force ? 1 : minEmit)) return;    // force=true 用于收尾的半句
    // 串行发送，保证分片顺序
    sendChain = sendChain.then(function () {
      return fetch('http://127.0.0.1:' + PORT + '/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t, stream: true }),
      }).catch(function () {});
    });
  }

  /** 处理单个消息节点：算出新增文本，按句切分投递。 */
  function handleNode(node, initOnly) {
    const text = extractText(node);
    if (!text) return;

    let st = state.get(node);
    if (!st) {
      st = { last: '', pending: '' };
      state.set(node, st);
      if (initOnly) {
        // 注入瞬间已有内容：视作「已经念过」，避免复读历史
        st.last = text;
        return;
      }
      // 之后新出现的消息节点：从头开始念
    }
    const grown = text.startsWith(st.last);
    const added = grown
      ? text.slice(st.last.length)
      : text.slice(commonPrefix(st.last, text));
    st.last = text;
    if (!added) return;

    st.pending += added;

    let [chunk, rest] = takeComplete(st.pending);
    if (chunk) {
      st.pending = rest;
      // 剩余部分太短就先留着，等后面的字
      if (chunk.trim().length >= minEmit) send(chunk);
      else st.pending = chunk + st.pending;
    }
    if (st.pending.length >= MAX_PENDING) {
      send(st.pending);
      st.pending = '';
    }
  }

  /** 收集所有消息节点，去掉被其它节点包含的内层节点，只保留最外层。 */
  function collectNodes() {
    const found = new Set();
    for (const sel of SELECTORS) {
      let nodes = [];
      try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
      for (const n of nodes) found.add(n);
    }
    const list = Array.from(found);
    const outer = list.filter(function (n) {
      return !list.some(function (o) { return o !== n && o.contains(n); });
    });
    // 只关心最新的几条消息（DOM 顺序即时间顺序）
    return outer.length > MAX_TRACKED ? outer.slice(-MAX_TRACKED) : outer;
  }

  function flushPending() {
    const list = collectNodes();
    for (const n of list) {
      const st = state.get(n);
      if (!st || !st.pending) continue;
      send(st.pending, true);   // 收尾：即使很短也要念出来
      st.pending = '';
    }
  }

  function scan(initOnly) {
    for (const n of collectNodes()) handleNode(n, initOnly);
  }

  function scheduleQuiet() {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(flushPending, SENTENCE_QUIET_MS);
  }

  const mo = new MutationObserver(function () {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(function () {
      scan(false);
      scheduleQuiet();
    }, SCAN_MS);
  });

  mo.observe(document.body, { childList: true, subtree: true, characterData: true });

  // 注入瞬间：把当前已渲染的内容全部标记为已读，之后只念新增
  scan(true);
  console.log('[cursor-auto-tts] observer injected (streaming mode). Watching for assistant messages…');
})();

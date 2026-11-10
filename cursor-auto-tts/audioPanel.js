const vscode = require('vscode');

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"></head>
<body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#9a9a9a;">
  <audio id="a" style="display:none"></audio>
  <div id="status" style="padding:10px;font-size:12px;line-height:1.6;">
    朗读播放面板 —— 此页无需操作，可最小化或忽略。
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const a = document.getElementById('a');
    const status = document.getElementById('status');

    function setStatus(t) { status.textContent = t; }

    window.addEventListener('message', (ev) => {
      const m = ev.data || {};
      if (m.type === 'playAudio') {
        a.src = m.src;
        a.play().then(() => setStatus('正在朗读（edge-tts 自然音色）…')).catch(() => setStatus('播放失败'));
      } else if (m.type === 'speak') {
        try {
          if (!('speechSynthesis' in window)) { setStatus('系统语音不可用'); return; }
          speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(m.text);
          u.lang = m.lang || 'zh-CN';
          u.rate = m.rate || 1;
          const voices = speechSynthesis.getVoices();
          const zh = voices.find(v => /zh|Chinese|Huihui|Xiaoxiao|Yaoyao|Kangkang/i.test((v.name || '') + (v.lang || '')));
          if (zh) u.voice = zh;
          speechSynthesis.speak(u);
          setStatus('正在朗读（系统语音）…');
        } catch (e) {
          setStatus('系统语音失败: ' + e.message);
        }
      } else if (m.type === 'stop') {
        a.pause(); a.src = '';
        if ('speechSynthesis' in window) speechSynthesis.cancel();
        setStatus('已停止');
      }
    });
  </script>
</body>
</html>`;

class AudioPanel {
  constructor(context) {
    this.context = context;
    this.panel = null;
  }

  getPanel() {
    if (this.panel) return this.panel;
    this.panel = vscode.window.createWebviewPanel(
      'cursorAutoTts.audio',
      '朗读',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        preserveFocus: true,
      }
    );
    this.panel.webview.html = HTML;
    this.panel.onDidDispose(() => { this.panel = null; });
    return this.panel;
  }

  playAudio(dataUri) {
    const p = this.getPanel();
    return p.webview.postMessage({ type: 'playAudio', src: dataUri });
  }

  playSpeech(text) {
    const p = this.getPanel();
    return p.webview.postMessage({ type: 'speak', text, lang: 'zh-CN', rate: 1 });
  }

  stop() {
    if (this.panel) {
      this.panel.webview.postMessage({ type: 'stop' });
    }
  }
}

module.exports = { AudioPanel };

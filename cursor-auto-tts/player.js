// 跨平台音频播放 + 系统语音回退。
//
// 设计要点：
//  - Cursor 的 webview 会拦截无用户手势的 <audio> 自动播放，所以不能走 HTML 播放。
//  - 统一做法：把 edge-tts 合成出的 mp3 写到临时文件，再交给系统播放器「阻塞式」播放。
//  - 播放函数返回 Promise，resolve 表示这一段念完了（被打断也算 resolve），
//    上层队列靠它串行播放，实现「一条一条念」而不是互相打断。
//
// Windows 上多了一层「常驻播放进程」：
//   每调一次 powershell 启动就要 1.2 秒（Add-Type 编译 C# 还要再加 0.4 秒），
//   一段一句地播的话，段间的静默会比句子本身的停顿还长，听感非常割裂。
//   所以这里起一个后台 powershell 常驻进程，MCI 只编译一次，之后靠 stdin 一行一个
//   文件路径喂进去连续播放，单次切段开销降到 ~0.2 秒；配合上层的 mp3 拼接，
//   绝大多数情况下整条回复只开一次声音设备。
//
// 平台分支：
//  - win32  : 常驻 PowerShell + winmm.dll 的 MCI 接口（无窗口、无 message pump）；
//             常驻进程起不来时回退到「每次新开一个 powershell」
//  - darwin : 系统自带 afplay
//  - linux  : ffplay / mpg123 尝试，失败再回退系统语音
//
// 系统语音回退：Windows SAPI / macOS say / Linux espeak-ng 或 spd-say。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { estimateDurationMs } = require('./mp3');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const LOG = path.join(os.homedir(), '.cursor', 'cursor-tts-play.log');
const PS1 = path.join(os.tmpdir(), 'cursor-tts-play.ps1');
// 每个进程（每个 Cursor 窗口）用自己的守护脚本和停止标志，
// 免得一个窗口点「停止」把另一个窗口的朗读一起掐了
const DAEMON_PS1 = path.join(os.tmpdir(), 'cursor-tts-player-daemon-' + process.pid + '.ps1');
const STOP_FLAG = path.join(os.tmpdir(), 'cursor-tts-stop-' + process.pid + '.flag');

const PS1_CONTENT = `
param([Parameter(Mandatory=$true)][string]$Path)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Mci {
  [DllImport("winmm.dll", CharSet=CharSet.Auto)]
  public static extern int mciSendString(string c, StringBuilder r, int l, IntPtr h);
}
"@
$sb = New-Object System.Text.StringBuilder 512
[Mci]::mciSendString(('open "' + $Path + '" type mpegvideo alias curtts'), $sb, 512, [IntPtr]::Zero) | Out-Null
[Mci]::mciSendString('play curtts wait', $sb, 512, [IntPtr]::Zero) | Out-Null
[Mci]::mciSendString('close curtts', $sb, 512, [IntPtr]::Zero) | Out-Null
try { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue } catch {}
`;

// 常驻播放进程：stdin 每行一个文件路径，播完输出 DONE；收到 STOP_FLAG 则停播并输出 STOPPED。
// 不用 'play ... wait'，改成轮询 mode，这样播放期间还能响应停止。
const DAEMON_PS1_CONTENT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CursorTtsMci {
  [DllImport("winmm.dll", CharSet=CharSet.Auto)]
  public static extern int mciSendString(string c, StringBuilder r, int l, IntPtr h);
}
"@
$flag = '__STOP_FLAG__'
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  $path = $line.Trim()
  if ($path -eq '') { continue }
  if ($path -eq 'QUIT') { break }
  $sb = New-Object System.Text.StringBuilder 256
  $rc = [CursorTtsMci]::mciSendString(('open "' + $path + '" type mpegvideo alias curtts'), $sb, 256, [IntPtr]::Zero)
  if ($rc -ne 0) { [Console]::Out.WriteLine('ERR open ' + $rc); [Console]::Out.Flush(); continue }
  $rc = [CursorTtsMci]::mciSendString('play curtts', $sb, 256, [IntPtr]::Zero)
  if ($rc -ne 0) {
    [CursorTtsMci]::mciSendString('close curtts', $sb, 256, [IntPtr]::Zero) | Out-Null
    [Console]::Out.WriteLine('ERR play ' + $rc); [Console]::Out.Flush(); continue
  }
  $stopped = $false
  while ($true) {
    $msb = New-Object System.Text.StringBuilder 64
    [CursorTtsMci]::mciSendString('status curtts mode', $msb, 64, [IntPtr]::Zero) | Out-Null
    $mode = $msb.ToString().Trim()
    if ($mode -eq 'playing' -or $mode -eq '') {
      if (Test-Path -LiteralPath $flag) {
        [CursorTtsMci]::mciSendString('stop curtts', $sb, 256, [IntPtr]::Zero) | Out-Null
        $stopped = $true
        break
      }
      Start-Sleep -Milliseconds 40
      continue
    }
    break
  }
  [CursorTtsMci]::mciSendString('close curtts', $sb, 256, [IntPtr]::Zero) | Out-Null
  if ($stopped) { [Console]::Out.WriteLine('STOPPED') } else { [Console]::Out.WriteLine('DONE') }
  [Console]::Out.Flush()
}
`;

let currentChild = null;
let daemon = null;

function log(msg) {
  try {
    fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + msg + '\n');
  } catch (e) { /* ignore */ }
}

function ensurePs1() {
  try {
    if (!fs.existsSync(PS1)) fs.writeFileSync(PS1, PS1_CONTENT, 'utf8');
    return true;
  } catch (e) {
    log('write ps1 failed: ' + (e && e.message));
    return false;
  }
}

function ensureDaemonPs1() {
  try {
    if (!fs.existsSync(DAEMON_PS1)) {
      fs.writeFileSync(DAEMON_PS1, DAEMON_PS1_CONTENT.replace('__STOP_FLAG__', STOP_FLAG.replace(/'/g, "''")), 'utf8');
    }
    return true;
  } catch (e) {
    log('write daemon ps1 failed: ' + (e && e.message));
    return false;
  }
}

function clearStopFlag() {
  try { if (fs.existsSync(STOP_FLAG)) fs.unlinkSync(STOP_FLAG); } catch (e) { /* ignore */ }
}

function setStopFlag() {
  try { fs.writeFileSync(STOP_FLAG, '1'); } catch (e) { /* ignore */ }
}

/**
 * 跑一个会阻塞到结束的子进程，resolve(true/false) 表示是否正常跑完。
 * 被 stop() 杀掉时也会 resolve(false)，不会挂住队列。
 */
function run(cmd, args, opts) {
  const spawnOpts = Object.assign({ stdio: 'ignore', windowsHide: true }, opts || {});
  const input = spawnOpts.input;
  delete spawnOpts.input;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, spawnOpts);
    } catch (e) {
      log('spawn failed: ' + cmd + ' ' + (e && e.message));
      resolve(false);
      return;
    }
    currentChild = child;
    if (typeof input === 'string' && child.stdin) {
      try { child.stdin.end(input); } catch (e) { /* ignore */ }
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (currentChild === child) currentChild = null;
      resolve(ok);
    };
    child.on('error', (e) => {
      log('child error: ' + cmd + ' ' + (e && e.message));
      finish(false);
    });
    child.on('close', (code) => finish(code === 0));
  });
}

/* ------------------------------ 常驻播放进程 ------------------------------ */

function killDaemon() {
  const d = daemon;
  daemon = null;
  if (!d) return;
  d.alive = false;
  try { d.child.stdin.end('QUIT\n'); } catch (e) { /* ignore */ }
  try { d.child.kill(); } catch (e) { /* ignore */ }
  const p = d.pending;
  d.pending = null;
  releaseAck(d);
  if (p) p(false);
}

function ensureDaemon() {
  if (daemon && daemon.alive) return daemon;
  if (daemon) killDaemon();
  if (!ensureDaemonPs1()) return null;

  let child;
  try {
    child = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DAEMON_PS1],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
    );
  } catch (e) {
    log('daemon spawn failed: ' + (e && e.message));
    return null;
  }

  const d = {
    child,
    alive: true,
    buf: '',
    pending: null,
    started: Date.now(),
    // stop() 打断播放后，下一次播放必须先等守护进程确认停下，
    // 否则「清停止标志」会赶在它轮询之前，旧音频会接着往下播
    stopped: Promise.resolve(),
    ackStop: null,
  };
  daemon = d;

  child.stdout.on('data', (chunk) => {
    d.buf += chunk.toString('utf8');
    let i;
    while ((i = d.buf.indexOf('\n')) >= 0) {
      const line = d.buf.slice(0, i).trim();
      d.buf = d.buf.slice(i + 1);
      if (!line) continue;
      if (line !== 'DONE' && line !== 'STOPPED') log('daemon: ' + line);
      const p = d.pending;
      d.pending = null;
      releaseAck(d);
      if (p) p(line === 'DONE');
    }
  });
  child.on('error', (e) => log('daemon error: ' + (e && e.message)));
  child.on('close', () => {
    d.alive = false;
    if (daemon === d) daemon = null;
    const p = d.pending;
    d.pending = null;
    releaseAck(d);
    if (p) p(false);
  });
  try { child.stdin.on('error', () => { /* ignore EPIPE */ }); } catch (e) { /* ignore */ }
  return d;
}

/** 让常驻进程提前把 MCI 编译好，避免第一次朗读时白等 2 秒。 */
function prewarm() {
  if (!IS_WIN) return;
  try { ensureDaemon(); } catch (e) { log('prewarm failed: ' + (e && e.message)); }
}

/** 常驻进程确认「已停下」后，放行等待中的下一次播放。 */
function releaseAck(d) {
  if (d && d.ackStop) {
    const r = d.ackStop;
    d.ackStop = null;
    r();
  }
}

/** 通过常驻进程播放一个文件；进程不可用时返回 false（调用方回退一次性进程）。 */
function playViaDaemon(file) {
  const d = ensureDaemon();
  if (!d) return Promise.resolve(false);
  return d.stopped.then(() => new Promise((resolve) => {
    if (!d.alive) { resolve(false); return; }
    clearStopFlag();
    d.pending = resolve;
    try {
      d.child.stdin.write(file + '\n');
    } catch (e) {
      log('daemon write failed: ' + (e && e.message));
      if (d.pending === resolve) d.pending = null;
      killDaemon();
      resolve(false);
    }
  }));
}

/* -------------------------------- 播放接口 -------------------------------- */

/**
 * 常驻进程偶尔会因为 PowerShell 卡住（比如杀毒软件拦截）而不回话，
 * 这里加一个看门狗：超过「音频时长 + 15 秒」还没播完就杀掉重启，避免朗读永久卡死。
 */
async function playViaDaemonWithWatchdog(file, buf) {
  const limitMs = estimateDurationMs(buf) + 15000;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('TIMEOUT'), limitMs);
  });
  try {
    const r = await Promise.race([playViaDaemon(file), timeout]);
    if (r === 'TIMEOUT') {
      log('daemon watchdog timeout, restart');
      killDaemon();
      return false;
    }
    return r === true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 把文本通过 stdin 喂给系统语音合成器，resolve 表示念完。 */
function speakNative(text) {
  const s = String(text || '');
  if (!s.trim()) return Promise.resolve(false);

  if (IS_WIN) {
    const script =
      'Add-Type -AssemblyName System.Speech; ' +
      '$sp = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
      '$sp.Speak([Console]::In.ReadToEnd())';
    return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['pipe', 'ignore', 'ignore'],
      input: s,
    }).then((ok) => { log('sapi ok=' + ok); return ok; }, () => false);
  }

  if (IS_MAC) {
    // say 无参数时从 stdin 读文本，避免命令行长度限制
    return run('say', [], { stdio: ['pipe', 'ignore', 'ignore'], input: s }).then((ok) => ok, () => false);
  }

  return run('espeak-ng', ['-v', 'cmn', '-f', '-'], { stdio: ['pipe', 'ignore', 'ignore'], input: s })
    .then((ok) => ok || run('spd-say', ['--wait', s]), () => run('spd-say', ['--wait', s]));
}

function playMp3File(file) {
  if (IS_WIN) {
    if (!ensurePs1()) return Promise.resolve(false);
    return run('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', PS1, '-Path', file,
    ]);
  }

  if (IS_MAC) {
    return run('afplay', [file]);
  }

  return run('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', file]).then((ok) => {
    if (ok) return true;
    return run('mpg123', ['-q', file]);
  });
}

function tempMp3Path() {
  return path.join(
    os.tmpdir(),
    'cursor-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.mp3'
  );
}

/**
 * 播放一段 mp3 buffer，resolve 表示播完（或失败/被打断）。
 * 临时文件在播放结束后清理。
 */
async function playMp3Buffer(buf) {
  if (!buf || !buf.length) return false;
  const file = tempMp3Path();
  try {
    fs.writeFileSync(file, buf);
  } catch (e) {
    log('write mp3 failed: ' + (e && e.message));
    return false;
  }
  try {
    if (IS_WIN) {
      const ok = await playViaDaemonWithWatchdog(file, buf);
      if (ok) return true;
      // 常驻进程不可用（还没起来/挂了/MCI 报错/卡住）时退回一次性进程
      if (!daemon) return await playMp3File(file);
      return false;
    }
    return await playMp3File(file);
  } finally {
    // 一次性进程的 ps1 会自己删；这里兜底清理（文件还在被 MCI 占用时会删失败，忽略）
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) { /* ignore */ }
  }
}

function stop() {
  setStopFlag();
  if (daemon) {
    const d = daemon;
    const p = d.pending;
    if (p) {
      d.pending = null;
      // 下一次播放要等守护进程真正停下来：给它一个 ack
      const ack = new Promise((resolve) => { d.ackStop = resolve; });
      d.stopped = d.stopped.then(() => ack);
      p(false);
    }
    log('stop daemon pid=' + d.child.pid);
  }
  if (currentChild) {
    try { currentChild.kill(); } catch (e) { /* ignore */ }
    log('stop pid=' + currentChild.pid);
    currentChild = null;
  }
}

/** 扩展停用 / 重载时调用：收掉常驻进程，避免留下孤儿 powershell。 */
function shutdown() {
  setStopFlag();
  killDaemon();
  clearStopFlag();
  try { if (fs.existsSync(DAEMON_PS1)) fs.unlinkSync(DAEMON_PS1); } catch (e) { /* ignore */ }
}

/** 当前平台是否有可用的系统语音回退。 */
function hasNativeFallback() {
  if (IS_WIN || IS_MAC) return true;
  return false;
}

module.exports = {
  playMp3Buffer,
  playMp3File,
  speakNative,
  // 兼容旧名字
  speakSapi: speakNative,
  prewarm,
  stop,
  shutdown,
  hasNativeFallback,
};

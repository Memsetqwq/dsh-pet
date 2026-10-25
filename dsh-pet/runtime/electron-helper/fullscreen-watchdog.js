/**
 * 桌面 Helper 的全屏守卫：前台窗口铺满所在显示器时收起该屏宠物，退出后恢复。
 * 只在 Windows 启动常驻 PowerShell 检测 Win32 前台窗口；其它平台不启动。
 * 不负责渲染、位置与点击穿透；检查失败时 fail-open，绝不把宠物永久藏起来。
 * @module dsh-pet/runtime/electron-helper/fullscreen-watchdog
 */

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

/** 看门狗轮询间隔（ms）：进全屏后最多这么久收起宠物 */
const FULLSCREEN_WATCHDOG_INTERVAL_MS = 400;

/** 看门狗异常退出后的重试间隔（ms） */
const FULLSCREEN_WATCHDOG_RETRY_MS = 5000;

/** 退出全屏后的宽限（ms）：切桌面或通知抢焦点时不要闪一下宠物 */
const FULLSCREEN_EXIT_GRACE_MS = 900;

/**
 * 解析看门狗脚本的一行输出。
 * `0` 表示没有全屏；`1|<left>|<top>|<right>|<bottom>|<class>` 附带显示器 rcMonitor。
 *
 * @param line - 脚本输出的一行。
 * @returns 解析结果；格式不符时返回 undefined。
 */
function parseFullscreenState(line) {
  const text = String(line == null ? '' : line).trim();
  if (text === '0') return { fullscreen: false, monitor: null, className: '' };
  const m = /^1\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(.*)$/.exec(text);
  if (!m) return undefined;
  const left = Number(m[1]);
  const top = Number(m[2]);
  const right = Number(m[3]);
  const bottom = Number(m[4]);
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return undefined;
  return {
    fullscreen: true,
    monitor: { x: left, y: top, width: right - left, height: bottom - top },
    className: m[5] || '',
  };
}

/**
 * 宠物窗口是否落在全屏显示器上。
 * 窗口中心在显示器内，或至少一半面积被覆盖，都算命中（骑在屏幕边缘时也能收起）。
 *
 * @param bounds - 宠物窗口的屏幕坐标。
 * @param monitor - 全屏显示器的屏幕坐标。
 * @returns 是否应隐藏。
 */
function shouldHidePetForFullscreen(bounds, monitor) {
  if (!bounds || !monitor) return false;
  const bw = Number(bounds.width);
  const bh = Number(bounds.height);
  const mw = Number(monitor.width);
  const mh = Number(monitor.height);
  if (![bw, bh, mw, mh].every(Number.isFinite) || bw <= 0 || bh <= 0 || mw <= 0 || mh <= 0) return false;

  const cx = bounds.x + bw / 2;
  const cy = bounds.y + bh / 2;
  if (cx >= monitor.x && cx <= monitor.x + mw && cy >= monitor.y && cy <= monitor.y + mh) return true;

  const ix = Math.max(0, Math.min(bounds.x + bw, monitor.x + mw) - Math.max(bounds.x, monitor.x));
  const iy = Math.max(0, Math.min(bounds.y + bh, monitor.y + mh) - Math.max(bounds.y, monitor.y));
  return ix * iy >= bw * bh * 0.5;
}

/**
 * 启动常驻全屏看门狗；进程退出或脚本失败时 fail-open 并重试。
 *
 * @param options - 脚本路径、轮询间隔与状态回调。
 * @returns 停止函数。
 */
function createFullscreenWatcher(options) {
  const opts = options || {};
  const scriptPath = opts.scriptPath || path.join(__dirname, 'fullscreen-watchdog.ps1');
  const intervalMs =
    Number(opts.intervalMs) > 0 ? Math.round(Number(opts.intervalMs)) : FULLSCREEN_WATCHDOG_INTERVAL_MS;
  const onState = typeof opts.onState === 'function' ? opts.onState : () => {};
  const onUnavailable = typeof opts.onUnavailable === 'function' ? opts.onUnavailable : () => {};
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {};

  const powershell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';

  let child = null;
  let stopped = false;
  let retryTimer = null;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let reportedFailure = false;

  const scheduleRetry = () => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      start();
    }, FULLSCREEN_WATCHDOG_RETRY_MS);
    retryTimer.unref?.();
  };

  const handleStdout = (chunk) => {
    stdoutBuffer += chunk;
    let nl;
    while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, nl).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      const state = parseFullscreenState(line);
      if (!state) continue;
      reportedFailure = false;
      try {
        onState(state);
      } catch (error) {
        log('fullscreen state handler failed: ' + (error && error.message ? error.message : String(error)));
      }
    }
    if (stdoutBuffer.length > 4096) stdoutBuffer = '';
  };

  const handleStderr = (chunk) => {
    stderrBuffer += chunk;
    if (stderrBuffer.length > 2048) stderrBuffer = stderrBuffer.slice(-2048);
  };

  function start() {
    if (stopped) return;
    // 上一次进程可能死在半行上，残留字节不能拼进新进程的第一行
    stdoutBuffer = '';
    stderrBuffer = '';
    try {
      child = spawn(
        powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-File',
          scriptPath,
          '-IntervalMs',
          String(intervalMs),
          '-ParentPid',
          String(process.pid),
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      if (!reportedFailure) {
        reportedFailure = true;
        log('fullscreen watchdog failed to start: ' + (error && error.message ? error.message : String(error)));
      }
      onUnavailable();
      scheduleRetry();
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', handleStdout);
    child.stderr.on('data', handleStderr);

    child.once('error', (error) => {
      if (stopped) return;
      if (!reportedFailure) {
        reportedFailure = true;
        log('fullscreen watchdog error: ' + (error && error.message ? error.message : String(error)));
      }
      child = null;
      onUnavailable();
      scheduleRetry();
    });

    child.once('exit', (code, signal) => {
      if (stopped) return;
      if (!reportedFailure) {
        reportedFailure = true;
        const detail = stderrBuffer.trim().split(/\r?\n/).slice(0, 2).join(' ');
        log(
          'fullscreen watchdog exited (code=' +
            String(code) +
            ', signal=' +
            String(signal) +
            ')' +
            (detail ? ': ' + detail : ''),
        );
      }
      child = null;
      onUnavailable();
      scheduleRetry();
    });
  }

  start();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const current = child;
      child = null;
      if (current && !current.killed) {
        try {
          current.kill();
        } catch {
          /* 已经退出 */
        }
      }
    },
  };
}

module.exports = {
  FULLSCREEN_WATCHDOG_INTERVAL_MS,
  FULLSCREEN_WATCHDOG_RETRY_MS,
  FULLSCREEN_EXIT_GRACE_MS,
  parseFullscreenState,
  shouldHidePetForFullscreen,
  createFullscreenWatcher,
};

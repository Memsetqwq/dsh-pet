/**
 * 桌面 Helper 全屏守卫的纯判定与接线守卫。
 * 覆盖脚本输出解析、宠物与全屏显示器的相交判定、常量不变式，以及 main.js/脚本的关键接线。
 * 不启动真实 PowerShell 或 Electron；真实窗口行为由本地手动验证覆盖。
 * @module dsh-pet/src/host/fullscreen-watchdog.test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';
const {
  FULLSCREEN_WATCHDOG_INTERVAL_MS,
  FULLSCREEN_WATCHDOG_RETRY_MS,
  FULLSCREEN_EXIT_GRACE_MS,
  parseFullscreenState,
  shouldHidePetForFullscreen,
} = require(helper + 'fullscreen-watchdog.js');

/** 读取包内源码，供接线守卫使用 */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('parseFullscreenState', () => {
  test('区分无全屏、全屏显示器与非法输出', () => {
    assert.deepEqual(parseFullscreenState('0'), { fullscreen: false, monitor: null, className: '' });
    assert.deepEqual(parseFullscreenState(' 1|0|0|2560|1440|Game\r'), {
      fullscreen: true,
      monitor: { x: 0, y: 0, width: 2560, height: 1440 },
      className: 'Game',
    });
    assert.deepEqual(parseFullscreenState('1|-1920|-200|-640|880|Game'), {
      fullscreen: true,
      monitor: { x: -1920, y: -200, width: 1280, height: 1080 },
      className: 'Game',
    });
    assert.equal(parseFullscreenState('PowerShell banner'), undefined);
    assert.equal(parseFullscreenState('1|0|0|0|1440|Game'), undefined);
    assert.equal(parseFullscreenState(''), undefined);
  });
});

describe('shouldHidePetForFullscreen', () => {
  const monitor = { x: 0, y: 0, width: 2560, height: 1440 };

  test('宠物在屏内或与全屏屏过半相交时隐藏', () => {
    assert.equal(shouldHidePetForFullscreen({ x: 100, y: 800, width: 924, height: 744 }, monitor), true);
    assert.equal(shouldHidePetForFullscreen({ x: 1900, y: 800, width: 924, height: 744 }, monitor), true);
  });

  test('宠物在另一块屏、或参数非法时不隐藏', () => {
    assert.equal(shouldHidePetForFullscreen({ x: -1500, y: 800, width: 924, height: 744 }, monitor), false);
    assert.equal(shouldHidePetForFullscreen({ x: 2500, y: 100, width: 924, height: 744 }, monitor), false);
    assert.equal(shouldHidePetForFullscreen(null, monitor), false);
    assert.equal(shouldHidePetForFullscreen({ x: 0, y: 0, width: -1, height: 100 }, monitor), false);
  });
});

test('常量不变式：轮询、重试与退出宽限都是正数', () => {
  assert.ok(FULLSCREEN_WATCHDOG_INTERVAL_MS > 0);
  assert.ok(FULLSCREEN_WATCHDOG_RETRY_MS > 0);
  assert.ok(FULLSCREEN_EXIT_GRACE_MS > 0);
  assert.ok(FULLSCREEN_WATCHDOG_INTERVAL_MS < FULLSCREEN_EXIT_GRACE_MS);
});

describe('源码守卫：main.js 与 PowerShell 脚本按约定接线', () => {
  const main = readSource(helper + 'main.js');
  const script = readSource(helper + 'fullscreen-watchdog.ps1');

  test('helper 复用纯判定模块并在建窗后启动看门狗', () => {
    assert.match(main, /require\('\.\/fullscreen-watchdog\.js'\)/);
    assert.match(main, /createPetWindows\(\);\s*\n\s*\/\/[^\n]*\n\s*startFullscreenWatchdog\(\);/);
    assert.match(main, /DSH_PET_FULLSCREEN_HIDE === '0'/);
    assert.match(main, /process\.platform !== 'win32' \|\| DPI_PROBE/);
  });

  test('隐藏/恢复只碰全屏标记过的窗口，并在退出时停掉看门狗', () => {
    assert.match(main, /fullscreenHidden\.add\(win\.id\)/);
    assert.match(main, /fullscreenHidden\.delete\(win\.id\)/);
    assert.match(main, /win\.hide\(\)/);
    assert.match(main, /win\.showInactive\(\)/);
    assert.match(main, /stopFullscreenWatchdog\(\);/);
  });

  test('首帧显示与移动重判都尊重全屏隐藏标记', () => {
    assert.match(main, /ready-to-show[\s\S]{0,160}fullscreenHidden\.has\(win\.id\)/);
    assert.match(
      main,
      /did-finish-load[\s\S]{0,200}if \(fullscreenHidden\.has\(win\.id\)\) return;[\s\S]{0,80}!win\.isDestroyed\(\) && !win\.isVisible\(\)\) win\.showInactive\(\)/,
    );
    assert.match(main, /if \(fullscreenMonitor\) applyFullscreenVisibility\(fullscreenMonitor\)/);
  });

  test('PowerShell 脚本保持 ASCII，避免 Windows PowerShell 5.1 按 ANSI 读取破坏 C#', () => {
    const bytes = readFileSync(fileURLToPath(new URL(helper + 'fullscreen-watchdog.ps1', import.meta.url)));
    assert.ok(
      bytes.every((byte) => byte < 0x80),
      '脚本不能含非 ASCII 字符：BOM-less .ps1 会被 Windows PowerShell 5.1 当成 ANSI',
    );
  });

  test('PowerShell 脚本用真实前台窗口与 DWM 边框判定，并带父进程存活检查', () => {
    for (const symbol of [
      'GetForegroundWindow',
      'DwmGetWindowAttribute',
      'MonitorFromWindow',
      'GetMonitorInfo',
      'SHQueryUserNotificationState',
    ]) {
      assert.match(script, new RegExp(symbol));
    }
    assert.match(script, /return "1\|"/);
    assert.match(script, /Get-Process -Id \$ParentPid/);
    assert.match(script, /Start-Sleep -Milliseconds \$IntervalMs/);
  });
});

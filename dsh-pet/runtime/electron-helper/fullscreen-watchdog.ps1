# dsh-pet desktop helper fullscreen watchdog.
# Polls the Windows foreground window and prints `1|<rcMonitor>|<class>` only when
# it really covers its monitor. Started by fullscreen-watchdog.js; exits when the
# parent helper disappears. ASCII-only: Windows PowerShell 5.1 reads BOM-less
# scripts as ANSI, so non-ASCII comments would corrupt the embedded C# source.

param(
  [int]$IntervalMs = 400,
  [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DshPetFullscreen
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public uint cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("shell32.dll")]
    private static extern int SHQueryUserNotificationState(out int state);

    private const int GWL_STYLE = -16;
    private const int WS_CAPTION = 0x00C00000;
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private const uint MONITOR_DEFAULTTONEAREST = 2;

    public static string Query()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return "0";
        if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return "0";

        StringBuilder cls = new StringBuilder(256);
        GetClassName(hwnd, cls, cls.Capacity);
        string className = cls.ToString();
        if (className == "Progman" || className == "WorkerW" ||
            className == "Shell_TrayWnd" || className == "Shell_SecondaryTrayWnd" ||
            className == "Windows.UI.Core.CoreWindow")
        {
            return "0";
        }

        // Normal maximized windows have a caption and their DWM frame stops at the
        // work area. Games and video players are usually borderless (WS_POPUP).
        // QUNS busy / D3D fullscreen catches the rare exclusive game that kept a
        // caption style bit.
        int style = GetWindowLong(hwnd, GWL_STYLE);
        bool hasCaption = (style & WS_CAPTION) == WS_CAPTION;
        int notificationState = 0;
        bool shellSaysFullscreen =
            SHQueryUserNotificationState(out notificationState) == 0 &&
            (notificationState == 2 || notificationState == 3);
        if (hasCaption && !shellSaysFullscreen) return "0";

        RECT r;
        int hr = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT)));
        if (hr != 0 && !GetWindowRect(hwnd, out r)) return "0";

        IntPtr mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        MONITORINFO mi = new MONITORINFO();
        mi.cbSize = (uint)Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(mon, ref mi)) return "0";
        RECT m = mi.rcMonitor;

        // 2px tolerance absorbs DPI rounding and invisible resize borders.
        bool covers = r.Left <= m.Left + 2 && r.Top <= m.Top + 2 &&
                      r.Right >= m.Right - 2 && r.Bottom >= m.Bottom - 2;
        if (!covers) return "0";

        return "1|" + m.Left + "|" + m.Top + "|" + m.Right + "|" + m.Bottom + "|" + className;
    }
}
'@

$last = ''
while ($true) {
    if ($ParentPid -gt 0) {
        $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
        if (-not $parent) { break }
    }

    $state = [DshPetFullscreen]::Query()
    if ($state -ne $last) {
        [Console]::Out.WriteLine($state)
        [Console]::Out.Flush()
        $last = $state
    }

    Start-Sleep -Milliseconds $IntervalMs
}

// 如意 Ruyi 桌面外壳（clean-room，零 npm 依赖）
//
// 目标：把「后台 terminal + Chrome 标签页」收敛为【一个自有窗口的独立进程】——
//   - 无边框窗口 + 自绘标题栏（右上 ─ □ × 三键，× 关闭整个进程连同后台服务）
//   - 内嵌 WebView2（Win11 自带运行时；Win10 绝大多数已随 Edge 安装）
//   - 宿主进程内拉起 node app/server.js serve（Job Object 绑定：宿主退出/崩溃 → 服务自动回收）
//   - WebView2 运行时缺失时优雅降级：仍起服务，改开系统默认浏览器 + 托盘常驻（可退出）
//
// 编译：desktop/build-desktop.ps1（系统自带 csc.exe，/target:winexe，无控制台窗口）。
// 语法约束：随系统 csc（C# 5）——不用字符串插值/null 条件运算符/表达式成员。
// COM 互操作：接口方法必须与 WebView2.h 的 vtable 顺序逐一对齐（只声明用到的前缀段）。

using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace RuyiDesktop
{
    /* ============================ Win32 ============================ */

    internal static class Native
    {
        public const int WM_GETMINMAXINFO = 0x0024;
        public const int WM_NCHITTEST = 0x0084;
        public const int WM_NCLBUTTONDOWN = 0x00A1;
        public const int WM_MOUSEWHEEL = 0x020A;
        public const int WM_MOUSEHWHEEL = 0x020E;
        public const int WM_DPICHANGED = 0x02E0;
        public const int HTCAPTION = 2;
        public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        public const int DWMWCP_ROUND = 2;
        public const uint MONITOR_DEFAULTTONEAREST = 2;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int left, top, right, bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int x, y; }

        // 无边框最大化钳到显示器工作区（任务栏可见→排除之；任务栏自动隐藏→工作区即全屏）。
        [StructLayout(LayoutKind.Sequential)]
        public struct MINMAXINFO
        {
            public POINT ptReserved;
            public POINT ptMaxSize;
            public POINT ptMaxPosition;
            public POINT ptMinTrackSize;
            public POINT ptMaxTrackSize;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        public struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("user32.dll")] public static extern bool ReleaseCapture();
        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);
        [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint dwFlags);
        [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT pt);
        [DllImport("user32.dll")] public static extern bool IsChild(IntPtr hWndParent, IntPtr hWnd);
        [DllImport("user32.dll")] public static extern IntPtr GetFocus();
        [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        // WebView2 入口（WebView2Loader.dll 随 exe 同目录分发；Microsoft 官方可再发行组件）。
        [DllImport("WebView2Loader.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Unicode)]
        public static extern int CreateCoreWebView2EnvironmentWithOptions(
            string browserExecutableFolder, string userDataFolder,
            IntPtr environmentOptions, ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler handler);
    }

    /* ============================ WebView2 COM 互操作（vtable 对齐 WebView2.h） ============================ */

    [StructLayout(LayoutKind.Sequential)]
    internal struct EventRegistrationToken { public long Value; }

    [ComImport, Guid("4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler
    {
        [PreserveSig] int Invoke(int errorCode, ICoreWebView2Environment environment);
    }

    [ComImport, Guid("b96d755e-0319-4e92-a296-23436f46a1fc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ICoreWebView2Environment
    {
        [PreserveSig] int CreateCoreWebView2Controller(IntPtr parentWindow, ICoreWebView2CreateCoreWebView2ControllerCompletedHandler handler);
        [PreserveSig] int CreateWebResourceResponse(IntPtr content, int statusCode, string reasonPhrase, string headers, out IntPtr response);
        [PreserveSig] int get_BrowserVersionString([MarshalAs(UnmanagedType.LPWStr)] out string value);
        [PreserveSig] int add_NewBrowserVersionAvailable(IntPtr handler, out EventRegistrationToken token);
        [PreserveSig] int remove_NewBrowserVersionAvailable(EventRegistrationToken token);
    }

    [ComImport, Guid("6c4819f3-c9b7-4260-8127-c9f5bde7f68c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ICoreWebView2CreateCoreWebView2ControllerCompletedHandler
    {
        [PreserveSig] int Invoke(int errorCode, ICoreWebView2Controller controller);
    }

    [ComImport, Guid("4d00c0d1-9434-4eb6-8078-8697a560334f"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ICoreWebView2Controller
    {
        [PreserveSig] int get_IsVisible(out int isVisible);
        [PreserveSig] int put_IsVisible(int isVisible);
        [PreserveSig] int get_Bounds(out Native.RECT bounds);
        [PreserveSig] int put_Bounds(ref Native.RECT bounds);
        [PreserveSig] int get_ZoomFactor(out double zoomFactor);
        [PreserveSig] int put_ZoomFactor(double zoomFactor);
        [PreserveSig] int add_ZoomFactorChanged(IntPtr handler, out EventRegistrationToken token);
        [PreserveSig] int remove_ZoomFactorChanged(EventRegistrationToken token);
        [PreserveSig] int SetBoundsAndZoomFactor(ref Native.RECT bounds, double zoomFactor);
        [PreserveSig] int MoveFocus(int reason);
        [PreserveSig] int add_MoveFocusRequested(IntPtr handler, out EventRegistrationToken token);
        [PreserveSig] int remove_MoveFocusRequested(EventRegistrationToken token);
        [PreserveSig] int add_GotFocus(IntPtr handler, out EventRegistrationToken token);
        [PreserveSig] int remove_GotFocus(EventRegistrationToken token);
        [PreserveSig] int add_LostFocus(IntPtr handler, out EventRegistrationToken token);
        [PreserveSig] int remove_LostFocus(EventRegistrationToken token);
        [PreserveSig] int add_AcceleratorKeyPressed(IntPtr handler, out EventRegistrationToken token);
        [PreserveSig] int remove_AcceleratorKeyPressed(EventRegistrationToken token);
        [PreserveSig] int get_ParentWindow(out IntPtr parentWindow);
        [PreserveSig] int put_ParentWindow(IntPtr parentWindow);
        [PreserveSig] int NotifyParentWindowPositionChanged();
        [PreserveSig] int Close();
        [PreserveSig] int get_CoreWebView2(out ICoreWebView2 coreWebView2);
    }

    [ComImport, Guid("76eceacb-0462-4d94-ac83-423a6793775e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ICoreWebView2
    {
        [PreserveSig] int get_Settings(out ICoreWebView2Settings settings);
        [PreserveSig] int get_Source([MarshalAs(UnmanagedType.LPWStr)] out string uri);
        [PreserveSig] int Navigate([MarshalAs(UnmanagedType.LPWStr)] string uri);
        [PreserveSig] int NavigateToString([MarshalAs(UnmanagedType.LPWStr)] string htmlContent);
        [PreserveSig] int add_NavigationStarting(IntPtr handler, out EventRegistrationToken token);
        [PreserveSig] int remove_NavigationStarting(EventRegistrationToken token);
        [PreserveSig] int add_ContentLoading(IntPtr handler, out EventRegistrationToken token);
        [PreserveSig] int remove_ContentLoading(EventRegistrationToken token);
        [PreserveSig] int add_SourceChanged(IntPtr handler, out EventRegistrationToken token);
        [PreserveSig] int remove_SourceChanged(EventRegistrationToken token);
        [PreserveSig] int add_HistoryChanged(IntPtr handler, out EventRegistrationToken token);
        [PreserveSig] int remove_HistoryChanged(EventRegistrationToken token);
        [PreserveSig] int add_NavigationCompleted(IntPtr handler, out EventRegistrationToken token);
        [PreserveSig] int remove_NavigationCompleted(EventRegistrationToken token);
        [PreserveSig] int add_FrameNavigationStarting(IntPtr handler, out EventRegistrationToken token);
        [PreserveSig] int remove_FrameNavigationStarting(EventRegistrationToken token);
        [PreserveSig] int add_FrameNavigationCompleted(IntPtr handler, out EventRegistrationToken token);
        [PreserveSig] int remove_FrameNavigationCompleted(EventRegistrationToken token);
        [PreserveSig] int add_ScriptDialogOpening(IntPtr handler, out EventRegistrationToken token);
        [PreserveSig] int remove_ScriptDialogOpening(EventRegistrationToken token);
        [PreserveSig] int add_PermissionRequested(IntPtr handler, out EventRegistrationToken token);
        [PreserveSig] int remove_PermissionRequested(EventRegistrationToken token);
        [PreserveSig] int add_ProcessFailed(IntPtr handler, out EventRegistrationToken token);
        [PreserveSig] int remove_ProcessFailed(EventRegistrationToken token);
        [PreserveSig] int AddScriptToExecuteOnDocumentCreated([MarshalAs(UnmanagedType.LPWStr)] string javaScript, ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler handler);
        [PreserveSig] int RemoveScriptToExecuteOnDocumentCreated([MarshalAs(UnmanagedType.LPWStr)] string id);
        [PreserveSig] int ExecuteScript([MarshalAs(UnmanagedType.LPWStr)] string javaScript, ICoreWebView2ExecuteScriptCompletedHandler handler);
        [PreserveSig] int CapturePreview(int imageFormat, IntPtr imageStream, IntPtr handler);
        [PreserveSig] int Reload();
        [PreserveSig] int PostWebMessageAsJson([MarshalAs(UnmanagedType.LPWStr)] string webMessageAsJson);
        [PreserveSig] int PostWebMessageAsString([MarshalAs(UnmanagedType.LPWStr)] string webMessageAsString);
        [PreserveSig] int add_WebMessageReceived(ICoreWebView2WebMessageReceivedEventHandler handler, out EventRegistrationToken token);
        [PreserveSig] int remove_WebMessageReceived(EventRegistrationToken token);
        [PreserveSig] int CallDevToolsProtocolMethod([MarshalAs(UnmanagedType.LPWStr)] string methodName, [MarshalAs(UnmanagedType.LPWStr)] string parametersAsJson, IntPtr handler);
        [PreserveSig] int get_BrowserProcessId(out uint value);
        [PreserveSig] int get_CanGoBack(out int canGoBack);
        [PreserveSig] int get_CanGoForward(out int canGoForward);
        [PreserveSig] int GoBack();
        [PreserveSig] int GoForward();
        [PreserveSig] int GetDevToolsProtocolEventReceiver([MarshalAs(UnmanagedType.LPWStr)] string eventName, out IntPtr receiver);
        [PreserveSig] int Stop();
        [PreserveSig] int add_NewWindowRequested(ICoreWebView2NewWindowRequestedEventHandler handler, out EventRegistrationToken token);
    }

    [ComImport, Guid("e562e4f0-d7fa-43ac-8d71-c05150499f00"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ICoreWebView2Settings
    {
        [PreserveSig] int get_IsScriptEnabled(out int value);
        [PreserveSig] int put_IsScriptEnabled(int value);
        [PreserveSig] int get_IsWebMessageEnabled(out int value);
        [PreserveSig] int put_IsWebMessageEnabled(int value);
        [PreserveSig] int get_AreDefaultScriptDialogsEnabled(out int value);
        [PreserveSig] int put_AreDefaultScriptDialogsEnabled(int value);
        [PreserveSig] int get_IsStatusBarEnabled(out int value);
        [PreserveSig] int put_IsStatusBarEnabled(int value);
        [PreserveSig] int get_AreDevToolsEnabled(out int value);
        [PreserveSig] int put_AreDevToolsEnabled(int value);
        [PreserveSig] int get_AreDefaultContextMenusEnabled(out int value);
        [PreserveSig] int put_AreDefaultContextMenusEnabled(int value);
    }

    [ComImport, Guid("49511172-cc67-4bca-9923-137112f4c4cc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ICoreWebView2ExecuteScriptCompletedHandler
    {
        [PreserveSig] int Invoke(int errorCode, [MarshalAs(UnmanagedType.LPWStr)] string resultObjectAsJson);
    }

    // 注意：AddScriptToExecuteOnDocumentCreated 的第二参是完成回调（非 token）；
    // 误传 byref 结构体地址会被当 COM 指针解引用 → AccessViolation。
    [ComImport, Guid("b99369f3-9b11-47b5-bc6f-8e7895fcea17"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler
    {
        [PreserveSig] int Invoke(int errorCode, [MarshalAs(UnmanagedType.LPWStr)] string id);
    }

    [ComImport, Guid("57213f19-00e6-49fa-8e07-898ea01ecbd2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ICoreWebView2WebMessageReceivedEventHandler
    {
        [PreserveSig] int Invoke(ICoreWebView2 sender, ICoreWebView2WebMessageReceivedEventArgs args);
    }

    [ComImport, Guid("0f99a40c-e962-4207-9e92-e3d542eff849"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ICoreWebView2WebMessageReceivedEventArgs
    {
        [PreserveSig] int get_Source([MarshalAs(UnmanagedType.LPWStr)] out string source);
        [PreserveSig] int get_WebMessageAsJson([MarshalAs(UnmanagedType.LPWStr)] out string webMessageAsJson);
        [PreserveSig] int TryGetWebMessageAsString([MarshalAs(UnmanagedType.LPWStr)] out string webMessageAsString);
    }

    [ComImport, Guid("d4c185fe-c81c-4989-97af-2d3fa7ab5651"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ICoreWebView2NewWindowRequestedEventHandler
    {
        [PreserveSig] int Invoke(ICoreWebView2 sender, ICoreWebView2NewWindowRequestedEventArgs args);
    }

    [ComImport, Guid("34acb11c-fc37-4418-9132-f9c21d1eafb9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ICoreWebView2NewWindowRequestedEventArgs
    {
        [PreserveSig] int get_Uri([MarshalAs(UnmanagedType.LPWStr)] out string uri);
        [PreserveSig] int put_NewWindow(IntPtr newWindow);
        [PreserveSig] int get_NewWindow(out IntPtr newWindow);
        [PreserveSig] int put_Handled(int handled);
    }

    /* ============================ 后台服务宿主 ============================ */

    // node app/server.js serve —— 绑进 Job Object（KILL_ON_JOB_CLOSE）：
    // 外壳进程无论正常退出、被杀还是崩溃，服务子进程树都会被系统回收（「点 × 关闭进程」的硬保证）。
    internal sealed class ServerHost : IDisposable
    {
        private readonly IntPtr job;
        private Process process;
        private readonly StringBuilder stderrTail = new StringBuilder();
        public event Action<string> UrlReady;       // "http://127.0.0.1:port/"
        public event Action<int> Exited;

        public bool Running { get { return process != null && !process.HasExited; } }
        public string StderrTail { get { lock (stderrTail) { return stderrTail.ToString(); } } }

        public ServerHost()
        {
            job = Native.CreateJobObject(IntPtr.Zero, null);
            if (job != IntPtr.Zero)
            {
                var info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                Native.SetInformationJobObject(job, 9 /* ExtendedLimitInformation */, ref info, Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
            }
        }

        public void Start(string baseDir)
        {
            string bundled = Path.Combine(baseDir, @"runtime\node\node.exe");
            string nodeExe = File.Exists(bundled) ? bundled : "node";
            string serverJs = Path.Combine(baseDir, @"app\server.js");
            if (!File.Exists(serverJs)) throw new FileNotFoundException("找不到 app\\server.js —— 请从完整安装包运行。", serverJs);

            var psi = new ProcessStartInfo();
            psi.FileName = nodeExe;
            psi.Arguments = "\"" + serverJs + "\" serve"; // 不带 --open：窗口由外壳自持
            psi.WorkingDirectory = baseDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;                    // 不再有后台 terminal 窗口
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            process = new Process();
            process.StartInfo = psi;
            process.EnableRaisingEvents = true;
            process.OutputDataReceived += OnOutput;
            process.ErrorDataReceived += OnError;
            process.Exited += delegate(object s, EventArgs e)
            {
                int code = 0;
                try { code = process.ExitCode; } catch { /* ignore */ }
                var handler = Exited;
                if (handler != null) handler(code);
            };
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            if (job != IntPtr.Zero) Native.AssignProcessToJobObject(job, process.Handle);
        }

        private void OnOutput(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            // server.js 启动成功后打印 "UI: http://host:port/" —— 以真实监听地址为准（含端口回退）。
            var m = Regex.Match(e.Data, @"UI:\s*(http://[0-9A-Za-z._:-]+/?)");
            if (m.Success)
            {
                var handler = UrlReady;
                if (handler != null) handler(m.Groups[1].Value);
            }
        }

        private void OnError(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            lock (stderrTail)
            {
                stderrTail.AppendLine(e.Data);
                if (stderrTail.Length > 8000) stderrTail.Remove(0, stderrTail.Length - 8000);
            }
        }

        public void Kill()
        {
            try
            {
                if (process != null && !process.HasExited)
                {
                    // .NET Framework 无整树 Kill —— taskkill /T 兜底；Job Object 仍是最终保险。
                    var tk = new Process();
                    tk.StartInfo.FileName = "taskkill.exe";
                    tk.StartInfo.Arguments = "/F /T /PID " + process.Id;
                    tk.StartInfo.UseShellExecute = false;
                    tk.StartInfo.CreateNoWindow = true;
                    tk.Start();
                    tk.WaitForExit(3000);
                }
            }
            catch { /* Job Object 兜底 */ }
        }

        public void Dispose()
        {
            Kill();
            try { if (process != null) process.Dispose(); } catch { /* ignore */ }
            if (job != IntPtr.Zero) { try { Marshal.GetLastWin32Error(); } catch { /* ignore */ } }
        }
    }

    /* ============================ 原生标题栏（三键 / 拖动 / 双击最大化） ============================ */

    // 页面注入式标题栏与 app 内部 fixed/sticky 布局冲突（切顶、页面多出滚动条），
    // 改用原生 WinForms 标题栏：WebView 只画标题栏以下区域，页面零 CSS 侵入。
    // 右侧三键 GDI+ 自绘线形字形；标题栏空白区可拖动、双击最大化；
    // 左上图标取 exe 嵌入的 win32 图标，与任务栏/窗口图标一致。

    internal enum CaptionKind { Min, Max, Close }

    internal sealed class CaptionButton : Control
    {
        private readonly CaptionKind kind;
        private bool hovered;
        private bool showRestore;

        public CaptionButton(CaptionKind kind)
        {
            this.kind = kind;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            SetStyle(ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent; // 透出标题栏渐变与底边线，三键区不断线
            SetStyle(ControlStyles.Selectable, false); // 不抢 WebView 焦点
            Size = new Size(46, TitlePanel.HeightPx);
            TabStop = false;
        }

        public bool ShowRestore
        {
            get { return showRestore; }
            set { if (showRestore != value) { showRestore = value; Invalidate(); } }
        }

        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); hovered = true; Invalidate(); }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); hovered = false; Invalidate(); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            bool light = Parent is TitlePanel && ((TitlePanel)Parent).LightTheme;
            Color hoverBg = kind == CaptionKind.Close ? Color.FromArgb(232, 17, 35)
                : (light ? Color.FromArgb(223, 229, 238) : Color.FromArgb(38, 50, 78));
            if (hovered)
            {
                using (var b = new SolidBrush(hoverBg)) g.FillRectangle(b, ClientRectangle);
            }
            Color fg = (hovered && kind == CaptionKind.Close) ? Color.White
                : (light ? Color.FromArgb(55, 65, 81) : Color.FromArgb(207, 216, 236));
            using (var pen = new Pen(fg, 1f))
            {
                int cx = Width / 2, cy = Height / 2;
                if (kind == CaptionKind.Min)
                {
                    g.DrawLine(pen, cx - 5, cy, cx + 5, cy);
                }
                else if (kind == CaptionKind.Max && !showRestore)
                {
                    g.DrawRectangle(pen, cx - 5, cy - 5, 10, 10);
                }
                else if (kind == CaptionKind.Max)
                {
                    // 还原字形：前后交叠双方框（前框用底色填充遮挡后框线条）
                    g.DrawRectangle(pen, cx - 2, cy - 6, 8, 8);
                    using (var mask = new SolidBrush(hovered ? hoverBg : (light ? Color.FromArgb(238, 242, 248) : Color.FromArgb(16, 26, 48))))
                        g.FillRectangle(mask, cx - 5, cy - 3, 9, 8);
                    g.DrawRectangle(pen, cx - 5, cy - 3, 8, 8);
                }
                else
                {
                    g.DrawLine(pen, cx - 5, cy - 5, cx + 5, cy + 5);
                    g.DrawLine(pen, cx - 5, cy + 5, cx + 5, cy - 5);
                }
            }
        }
    }

    internal sealed class TitlePanel : Panel
    {
        public const int HeightPx = 36;

        public readonly CaptionButton MinButton = new CaptionButton(CaptionKind.Min);
        public readonly CaptionButton MaxButton = new CaptionButton(CaptionKind.Max);
        public readonly CaptionButton CloseButton = new CaptionButton(CaptionKind.Close);
        public Action OnToggleMaximize; // 标题栏空白区双击

        private string statusText = "服务启动中…";
        private bool statusOk;
        private bool light;

        public bool LightTheme { get { return light; } }

        public TitlePanel()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            // 位置/尺寸由 ShellForm.LayoutPanels 手动 SetBounds（不用 Dock，杜绝停靠顺序/DPI 缩放切顶）。
            Controls.Add(MinButton);
            Controls.Add(MaxButton);
            Controls.Add(CloseButton);
        }

        // 主题由页面经消息桥上报（跟随 app 的日夜切换）。
        public void SetLight(bool value)
        {
            if (light == value) return;
            light = value;
            Invalidate();
        }

        public void SetStatus(string text, bool ok)
        {
            statusText = text;
            statusOk = ok;
            Invalidate();
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            int w = ClientSize.Width;
            CloseButton.Location = new Point(w - 46, 0);
            MaxButton.Location = new Point(w - 92, 0);
            MinButton.Location = new Point(w - 138, 0);
        }

        // 空白区按下 = 系统级标题栏拖动（三键是子控件，不走这里）。
        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            Form f = FindForm();
            if (f == null) return;
            Native.ReleaseCapture();
            Native.SendMessage(f.Handle, Native.WM_NCLBUTTONDOWN, (IntPtr)Native.HTCAPTION, IntPtr.Zero);
        }

        protected override void OnMouseDoubleClick(MouseEventArgs e)
        {
            base.OnMouseDoubleClick(e);
            var act = OnToggleMaximize;
            if (act != null) act();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            var body = new Rectangle(0, 0, Width, Height);
            Color top = light ? Color.FromArgb(255, 255, 255) : Color.FromArgb(17, 26, 48);
            Color bottom = light ? Color.FromArgb(243, 245, 249) : Color.FromArgb(14, 21, 38);
            using (var bg = new System.Drawing.Drawing2D.LinearGradientBrush(body, top, bottom, 90f))
                g.FillRectangle(bg, body);
            Color edge = light ? Color.FromArgb(90, 168, 130, 47) : Color.FromArgb(71, 245, 196, 81);
            using (var pen = new Pen(edge)) // 品牌金底边
                g.DrawLine(pen, 0, Height - 1, Width, Height - 1);

            int x = 10;
            DrawLogo(g, x, (Height - 22) / 2, 22, light); // Feather 云标，与任务栏/侧栏同一几何
            x += 30;
            using (var titleFont = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold))
            using (var smallFont = new Font("Microsoft YaHei UI", 8.5f, FontStyle.Regular))
            {
                const string title = "如意工作台 Ruyi Workbench";
                Color ink = light ? Color.FromArgb(31, 41, 55) : Color.FromArgb(207, 216, 236);
                Color muted = light ? Color.FromArgb(107, 114, 128) : Color.FromArgb(142, 160, 191);
                TextRenderer.DrawText(g, title, titleFont,
                    new Point(x, (Height - TextRenderer.MeasureText(g, title, titleFont).Height) / 2), ink);
                x += TextRenderer.MeasureText(g, title, titleFont).Width + 12;

                Color dotColor = statusOk
                    ? (light ? Color.FromArgb(23, 138, 94) : Color.FromArgb(57, 208, 160))
                    : muted;
                using (var dotBrush = new SolidBrush(dotColor))
                    g.FillEllipse(dotBrush, x, (Height - 7) / 2, 7, 7);
                x += 13;
                TextRenderer.DrawText(g, statusText, smallFont,
                    new Point(x, (Height - TextRenderer.MeasureText(g, statusText, smallFont).Height) / 2), muted);
            }
        }

        // Feather 云标（与 index.html 侧栏品牌标同一几何：
        //   path M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z + 金点 19.4,3.4 r1.5），
        //   24 单位网格按 size 缩放，GDI+ 弧线换算描边；明暗取各自品牌主/金色。
        internal static void DrawLogo(Graphics g, int x, int y, int size, bool light)
        {
            var sm = g.SmoothingMode;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            float k = size / 24f;
            Color qh = light ? Color.FromArgb(35, 80, 168) : Color.FromArgb(107, 143, 242); // --brand-qh
            Color au = light ? Color.FromArgb(217, 164, 65) : Color.FromArgb(242, 193, 78); // --brand-au

            using (var tile = RoundRect(new Rectangle(x, y, size, size), size * 3 / 10))
            using (var fill = new SolidBrush(Color.FromArgb(30, qh)))
                g.FillPath(fill, tile); // 极淡底砖，无描边（不产生周边留白）

            using (var cloud = new System.Drawing.Drawing2D.GraphicsPath())
            {
                cloud.AddLine(x + 18f * k, y + 10f * k, x + 16.74f * k, y + 10f * k);
                cloud.AddArc(x + 1f * k, y + 4f * k, 16f * k, 16f * k, -14.5f, -255.5f);
                cloud.AddLine(x + 9f * k, y + 20f * k, x + 18f * k, y + 20f * k);
                cloud.AddArc(x + 13f * k, y + 10f * k, 10f * k, 10f * k, 90f, -180f);
                cloud.CloseFigure();
                using (var pen = new Pen(qh, 1.5f * k))
                {
                    pen.StartCap = System.Drawing.Drawing2D.LineCap.Round;
                    pen.EndCap = System.Drawing.Drawing2D.LineCap.Round;
                    pen.LineJoin = System.Drawing.Drawing2D.LineJoin.Round;
                    g.DrawPath(pen, cloud);
                }
            }
            using (var dot = new SolidBrush(au))
                g.FillEllipse(dot, x + 17.9f * k, y + 1.9f * k, 3f * k, 3f * k);
            g.SmoothingMode = sm;
        }

        private static System.Drawing.Drawing2D.GraphicsPath RoundRect(Rectangle r, int radius)
        {
            var p = new System.Drawing.Drawing2D.GraphicsPath();
            int d = radius * 2;
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }
    }

    /* ============================ 主窗口 ============================ */

    internal sealed class ShellForm : Form
    {
        private const int TitlebarHeight = 36;
        private const int ResizeBorder = 6;

        private readonly ServerHost server;
        private readonly Panel webPanel = new Panel();
        private TitlePanel titlePanel;
        private ICoreWebView2Controller controller;
        private ICoreWebView2 webView;
        private bool webViewReady;      // WebView2 控制器就绪
        private bool browserFallback;   // 运行时缺失 → 默认浏览器降级
        private string serverUrl;       // 服务真实监听地址
        private bool navigated;
        private NotifyIcon trayIcon;
        private readonly System.Threading.Timer bootTimer;

        // COM 回调对象必须强引用存活（CCW 被 GC 会崩）。
        private EnvHandler envHandler;
        private CtrlHandler ctrlHandler;
        private NewWinHandler newWinHandler;
        private AddScriptHandler addScriptHandler;
        private MsgHandler msgHandler;

        private bool themeLight;    // 当前宿主主题（默认暗）
        private bool themeApplied;
        private Icon themeIcon;
        private bool nativeRoundedCorners;

        public ShellForm(ServerHost serverHost)
        {
            AutoScaleMode = AutoScaleMode.None; // 手动布局：不受自动缩放影响，杜绝标题栏/内容错位切顶
            server = serverHost;
            Text = "如意工作台 Ruyi Workbench";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(14, 21, 38); // 墨底，首帧不闪白
            MinimumSize = new Size(760, 480);
            var area = Screen.GetWorkingArea(this);
            Size = new Size(Math.Min(1280, area.Width * 4 / 5), Math.Min(820, area.Height * 4 / 5));

            webPanel.BackColor = BackColor;
            webPanel.Resize += delegate { SyncWebViewBounds(); };

            // 原生标题栏：右侧三键，空白区可拖动/双击最大化；状态点反映服务状态。
            titlePanel = new TitlePanel();
            titlePanel.OnToggleMaximize = delegate { ToggleMaximize(); };
            titlePanel.MinButton.Click += delegate { WindowState = FormWindowState.Minimized; };
            titlePanel.MaxButton.Click += delegate { ToggleMaximize(); };
            titlePanel.CloseButton.Click += delegate { Close(); };

            Controls.Add(titlePanel);
            Controls.Add(webPanel);
            LayoutPanels(); // 手动 SetBounds：标题栏固定顶 36px，WebView 紧贴其下（不依赖 Dock 停靠顺序）

            ApplyTheme(false); // 默认暗色；页面就绪后经主题桥上报，随 app 日夜切换

            bootTimer = new System.Threading.Timer(OnBootTimeout, null, 30000, System.Threading.Timeout.Infinite);
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyWindowCorners();
            InitWebView();
        }

        /* ---------- WebView2 初始化 ---------- */

        private void InitWebView()
        {
            string userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"Ruyi\EBWebView");
            try { Directory.CreateDirectory(userData); } catch { /* 创建失败时交给运行时自身报错 */ }

            envHandler = new EnvHandler(this);
            int hr;
            try
            {
                hr = Native.CreateCoreWebView2EnvironmentWithOptions(null, userData, IntPtr.Zero, envHandler);
            }
            catch (DllNotFoundException)
            {
                hr = unchecked((int)0x8007007E); // 找不到 WebView2Loader.dll → 按运行时缺失降级
            }
            if (hr < 0) EnterBrowserFallback("WebView2 初始化失败 (0x" + hr.ToString("X8") + ")");
        }

        internal void OnEnvironmentReady(int errorCode, ICoreWebView2Environment env)
        {
            if (IsDisposed) return;
            if (errorCode < 0 || env == null)
            {
                EnterBrowserFallback("未检测到 WebView2 运行时 (0x" + errorCode.ToString("X8") + ")");
                return;
            }
            ctrlHandler = new CtrlHandler(this);
            int hr = env.CreateCoreWebView2Controller(webPanel.Handle, ctrlHandler);
            if (hr < 0) EnterBrowserFallback("创建 WebView 控制器失败 (0x" + hr.ToString("X8") + ")");
        }

        internal void OnControllerReady(int errorCode, ICoreWebView2Controller ctrl)
        {
            if (IsDisposed) return;
            if (errorCode < 0 || ctrl == null)
            {
                EnterBrowserFallback("WebView 控制器不可用 (0x" + errorCode.ToString("X8") + ")");
                return;
            }
            controller = ctrl;
            ICoreWebView2 core;
            if (ctrl.get_CoreWebView2(out core) < 0 || core == null)
            {
                EnterBrowserFallback("WebView 核心对象不可用");
                return;
            }
            webView = core;

            ICoreWebView2Settings settings;
            if (core.get_Settings(out settings) == 0 && settings != null)
                settings.put_IsStatusBarEnabled(0);

            EventRegistrationToken token;
            newWinHandler = new NewWinHandler();
            core.add_NewWindowRequested(newWinHandler, out token);

            // 主题桥：每个文档创建前注入监听脚本，页面上报 light/dark → 宿主标题栏/背景/图标同步。
            addScriptHandler = new AddScriptHandler();
            core.AddScriptToExecuteOnDocumentCreated(ThemeScript.Install, addScriptHandler);
            msgHandler = new MsgHandler(this);
            core.add_WebMessageReceived(msgHandler, out token);

            // 服务就绪前先铺占位页：旋转圈 + Feather 云标（无文字）；margin-top 补偿标题栏高度使视觉居中。
            core.NavigateToString(
                "<!doctype html><html><head><meta charset='utf-8'><style>"
                + ":root{--qh:#6b8ff2;--au:#f2c14e;--bg:#0e1526;--ring:rgba(107,143,242,.15)}"
                + "body[data-theme='light']{--qh:#2350a8;--au:#d9a441;--bg:#f3f5f9;--ring:rgba(35,80,168,.15)}"
                + "body{margin:0;background:var(--bg);height:100vh;display:flex;align-items:center;justify-content:center}"
                + "@keyframes ruyispin{to{transform:rotate(360deg)}}"
                + ".ring{position:relative;width:88px;height:88px;margin-top:36px}"
                + ".spin{position:absolute;left:0;top:0;box-sizing:border-box;width:88px;height:88px;border-radius:50%;"
                + "border:3px solid var(--ring);border-top-color:var(--qh);border-right-color:var(--au);"
                + "animation:ruyispin 1.1s linear infinite}"
                + ".mark{position:absolute;left:18px;top:18px}"
                + "</style></head><body>"
                + "<script>var t=null;try{t=localStorage.getItem('wcw.theme');}catch(e){}"
                + "if(t!=='light'&&t!=='dark'){t=document.documentElement.getAttribute('data-theme');}"
                + "if(t!=='light'&&t!=='dark'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches){t='light';}"
                + "if(t==='light'||t==='dark'){document.body.setAttribute('data-theme',t);}</script>"
                + "<div class='ring'><div class='spin'></div>"
                + "<svg class='mark' width='52' height='52' viewBox='0 0 24 24' fill='none' stroke-width='1.5' "
                + "stroke-linecap='round' stroke-linejoin='round'>"
                + "<path stroke='var(--qh)' d='M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z'/>"
                + "<circle fill='var(--au)' stroke='none' cx='19.4' cy='3.4' r='1.5'/></svg>"
                + "</div></body></html>");
            SyncWebViewBounds();
            webViewReady = true;
            MaybeNavigate();
        }

        private void EnterBrowserFallback(string reason)
        {
            if (browserFallback || IsDisposed) return;
            browserFallback = true;
            Show(); // 确保有可见窗口承载提示
            var msg = "本机缺少 WebView2 运行时（" + reason + "）。\n"
                + "服务仍会正常启动，界面将改用系统默认浏览器打开；\n"
                + "本窗口将收进托盘，右键托盘图标可退出（退出会一并关闭后台服务）。\n\n"
                + "如需独立窗口体验，请安装 Microsoft Edge WebView2 Runtime。";
            MessageBox.Show(this, msg, "如意工作台", MessageBoxButtons.OK, MessageBoxIcon.Information);
            Visible = false;
            ShowInTaskbar = false;
            EnsureTrayIcon();
            MaybeNavigate(); // serverUrl 到达后开浏览器
        }

        private void EnsureTrayIcon()
        {
            if (trayIcon != null) return;
            trayIcon = new NotifyIcon();
            trayIcon.Text = "如意工作台 Ruyi Workbench";
            trayIcon.Icon = Icon ?? SystemIcons.Application;
            var menu = new ContextMenuStrip();
            var open = new ToolStripMenuItem("在浏览器中打开");
            open.Click += delegate { OpenInDefaultBrowser(); };
            var exit = new ToolStripMenuItem("退出（关闭服务）");
            exit.Click += delegate { Close(); };
            menu.Items.Add(open);
            menu.Items.Add(exit);
            trayIcon.ContextMenuStrip = menu;
            trayIcon.DoubleClick += delegate { if (browserFallback) OpenInDefaultBrowser(); else ActivateShellWindow(); };
            trayIcon.BalloonTipClicked += delegate { ActivateShellWindow(); };
            trayIcon.Visible = true;
        }

        private void ActivateShellWindow()
        {
            if (IsDisposed || browserFallback) { OpenInDefaultBrowser(); return; }
            ShowInTaskbar = true;
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            BringToFront();
        }

        private void ShowDesktopNotification(string title, string body)
        {
            if (IsDisposed) return;
            EnsureTrayIcon();
            trayIcon.BalloonTipTitle = string.IsNullOrWhiteSpace(title) ? "如意工作台" : title;
            trayIcon.BalloonTipText = string.IsNullOrWhiteSpace(body) ? "任务正在等待你的处理。" : body;
            trayIcon.BalloonTipIcon = ToolTipIcon.Info;
            trayIcon.ShowBalloonTip(10000);
        }

        /* ---------- 服务地址就绪 → 导航 ---------- */

        public void OnServerUrl(string url)
        {
            if (IsDisposed) return;
            serverUrl = url;
            titlePanel.SetStatus("已连接", true);
            bootTimer.Dispose();
            MaybeNavigate();
        }

        private void MaybeNavigate()
        {
            if (navigated || string.IsNullOrEmpty(serverUrl)) return;
            navigated = true;
            if (browserFallback)
            {
                OpenInDefaultBrowser();
                return;
            }
            if (!webViewReady) return;
            webView.Navigate(serverUrl);
        }

        private void OnBootTimeout(object state)
        {
            if (IsDisposed) return;
            if (!string.IsNullOrEmpty(serverUrl)) return;
            BeginInvoke((Action)delegate
            {
                if (!string.IsNullOrEmpty(serverUrl) || IsDisposed) return;
                string tail = server.StderrTail.Trim();
                string detail = tail.Length > 0 ? "\n\n服务输出：\n" + tail : "";
                MessageBox.Show(this, "后台服务 30 秒内未就绪。" + detail, "如意工作台",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            });
        }

        public void OnServerExited(int code)
        {
            if (IsDisposed || browserFallback) return;
            BeginInvoke((Action)delegate
            {
                if (IsDisposed) return;
                titlePanel.SetStatus("服务已停止 (exit " + code + ")", false);
                if (!webViewReady)
                    MessageBox.Show(this, "后台服务已退出（exit " + code + "）。", "如意工作台",
                        MessageBoxButtons.OK, MessageBoxIcon.Warning);
            });
        }

        /* ---------- 标题栏动作 ---------- */

        private void ToggleMaximize()
        {
            WindowState = WindowState == FormWindowState.Maximized
                ? FormWindowState.Normal
                : FormWindowState.Maximized;
        }

        private void OpenInDefaultBrowser()
        {
            if (string.IsNullOrEmpty(serverUrl)) return;
            try
            {
                // explorer.exe 直传 URL → 交给默认浏览器；无 shell 解释，与服务端 buildOpenSpawn 同一安全口径。
                var p = new Process();
                p.StartInfo.FileName = "explorer.exe";
                p.StartInfo.Arguments = serverUrl;
                p.StartInfo.UseShellExecute = false;
                p.Start();
            }
            catch { /* 浏览器打开失败不致命 */ }
        }

        /* ---------- 布局：手动 SetBounds（无边框窗口缩放 + WebView 贴合） ---------- */

        private void LayoutPanels()
        {
            if (titlePanel == null) return; // 构造期设 MinimumSize/Size 会提前触发 OnSizeChanged
            int w = ClientSize.Width, h = ClientSize.Height;
            // WebView2 is a child HWND. If it covers the outermost pixels it receives hit-testing before
            // the form, so WM_NCHITTEST on the shell never sees the pointer. Reserve one native resize
            // band around the content in restored mode; that makes all four edges/corners reliably
            // draggable and also gives the rounded shell a quiet visual frame.
            int inset = WindowState == FormWindowState.Maximized ? 0 : ResizeBorder;
            int innerW = Math.Max(0, w - inset * 2);
            titlePanel.SetBounds(inset, inset, innerW, TitlebarHeight);
            webPanel.SetBounds(inset, inset + TitlebarHeight, innerW, Math.Max(0, h - TitlebarHeight - inset * 2));
        }

        private void SyncWebViewBounds()
        {
            if (controller == null) return;
            // manifest 声明 DPI 感知（PerMonitorV2/PMv1）→ ClientSize 即物理像素，put_Bounds 直接用。
            var r = new Native.RECT();
            r.left = 0;
            r.top = 0; // bounds 相对 webPanel 客户区（原生标题栏之下）
            r.right = webPanel.ClientSize.Width;
            r.bottom = webPanel.ClientSize.Height;
            controller.put_Bounds(ref r);
            controller.NotifyParentWindowPositionChanged();
        }

        protected override void OnResizeEnd(EventArgs e) { base.OnResizeEnd(e); SyncWebViewBounds(); }
        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            UpdateFallbackWindowRegion();
            LayoutPanels();
            SyncWebViewBounds();
            if (titlePanel != null)
                titlePanel.MaxButton.ShowRestore = WindowState == FormWindowState.Maximized;
        }

        // Windows 11 supplies smooth antialiased corners through DWM. Windows 10 does not understand
        // attribute 33, so keep a small GraphicsPath region fallback there. Maximized windows remain
        // square and fill the monitor work area as users expect.
        private void ApplyWindowCorners()
        {
            int preference = Native.DWMWCP_ROUND;
            try
            {
                nativeRoundedCorners = Native.DwmSetWindowAttribute(Handle,
                    Native.DWMWA_WINDOW_CORNER_PREFERENCE, ref preference, sizeof(int)) == 0;
            }
            catch (DllNotFoundException) { nativeRoundedCorners = false; }
            catch (EntryPointNotFoundException) { nativeRoundedCorners = false; }
            UpdateFallbackWindowRegion();
        }

        private void UpdateFallbackWindowRegion()
        {
            if (!IsHandleCreated) return;
            if (nativeRoundedCorners || WindowState == FormWindowState.Maximized)
            {
                Region old = Region;
                Region = null;
                if (old != null) old.Dispose();
                return;
            }
            int radius = 12;
            try { radius = Math.Max(10, (int)Math.Round(12.0 * Native.GetDpiForWindow(Handle) / 96.0)); }
            catch { /* 96-DPI fallback */ }
            var rect = new Rectangle(0, 0, Math.Max(1, ClientSize.Width), Math.Max(1, ClientSize.Height));
            int d = Math.Min(radius * 2, Math.Min(rect.Width, rect.Height));
            using (var path = new System.Drawing.Drawing2D.GraphicsPath())
            {
                path.AddArc(rect.Left, rect.Top, d, d, 180, 90);
                path.AddArc(rect.Right - d, rect.Top, d, d, 270, 90);
                path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
                path.AddArc(rect.Left, rect.Bottom - d, d, d, 90, 90);
                path.CloseFigure();
                Region old = Region;
                Region = new Region(path);
                if (old != null) old.Dispose();
            }
        }

        /* ---------- 主题：页面上报 light/dark → 标题栏/背景/窗口图标同步 ---------- */

        internal void OnWebMessage(string json)
        {
            if (IsDisposed || string.IsNullOrEmpty(json)) return;
            if (json.IndexOf("\"ruyiTheme\":\"light\"", StringComparison.Ordinal) >= 0) ApplyTheme(true);
            else if (json.IndexOf("\"ruyiTheme\":\"dark\"", StringComparison.Ordinal) >= 0) ApplyTheme(false);
            try
            {
                var root = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                object value;
                if (root != null && root.TryGetValue("ruyiNotification", out value))
                {
                    var notice = value as Dictionary<string, object>;
                    object title, body;
                    string titleText = notice != null && notice.TryGetValue("title", out title) ? Convert.ToString(title) : "";
                    string bodyText = notice != null && notice.TryGetValue("body", out body) ? Convert.ToString(body) : "";
                    ShowDesktopNotification(titleText, bodyText);
                }
            }
            catch { /* malformed or unrelated page message */ }
        }

        private void ApplyTheme(bool light)
        {
            if (IsDisposed || (themeApplied && themeLight == light)) return;
            themeApplied = true;
            themeLight = light;
            titlePanel.SetLight(light);
            Color bg = light ? Color.FromArgb(243, 245, 249) : Color.FromArgb(14, 21, 38);
            BackColor = bg;
            webPanel.BackColor = bg;
            Icon old = themeIcon;
            themeIcon = BuildIcon(light);
            Icon = themeIcon;
            if (trayIcon != null) trayIcon.Icon = themeIcon;
            if (old != null) old.Dispose();
        }

        // 运行时窗口图标：32x32 现画 Feather 云标（与标题栏/侧栏/ico 同一几何），随主题重画。
        private static Icon BuildIcon(bool light)
        {
            using (var bmp = new Bitmap(32, 32, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    TitlePanel.DrawLogo(g, 0, 0, 32, light);
                }
                IntPtr h = bmp.GetHicon();
                try { return (Icon)Icon.FromHandle(h).Clone(); }
                finally { Native.DestroyIcon(h); }
            }
        }

        // DPI 变化经 WndProc 的 WM_DPICHANGED 处理（兼容旧版 WinForms 引用）。

        // 无边框窗口的可缩放边角：WM_NCHITTEST 命中 6px 边带 → 系统原生缩放体验。
        // 边带判定必须前置自行返回：WebView 子窗口覆盖全客户区时 DefWindowProc 返回
        // HTTRANSPARENT 而非 HTCLIENT，依赖其结果会让边带判定永远走不到。
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_DPICHANGED)
            {
                base.WndProc(ref m);
                SyncWebViewBounds(); // 换屏/改缩放后 WebView 重新贴合
                return;
            }
            if (m.Msg == Native.WM_GETMINMAXINFO)
            {
                base.WndProc(ref m);
                // 无边框最大化默认铺满整个显示器（连任务栏一起挡住）：钳到所在屏工作区。
                // 任务栏可见→工作区排除之；任务栏自动隐藏→工作区即全屏，两种用户都正确。
                var mmi = (Native.MINMAXINFO)Marshal.PtrToStructure(m.LParam, typeof(Native.MINMAXINFO));
                IntPtr mon = Native.MonitorFromWindow(m.HWnd, Native.MONITOR_DEFAULTTONEAREST);
                var mi = new Native.MONITORINFO();
                mi.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFO));
                if (Native.GetMonitorInfo(mon, ref mi))
                {
                    mmi.ptMaxPosition.x = mi.rcWork.left;
                    mmi.ptMaxPosition.y = mi.rcWork.top;
                    mmi.ptMaxSize.x = mi.rcWork.right - mi.rcWork.left;
                    mmi.ptMaxSize.y = mi.rcWork.bottom - mi.rcWork.top;
                    mmi.ptMinTrackSize.x = MinimumSize.Width;
                    mmi.ptMinTrackSize.y = MinimumSize.Height;
                    Marshal.StructureToPtr(mmi, m.LParam, true);
                }
                m.Result = IntPtr.Zero;
                return;
            }
            if (m.Msg == Native.WM_MOUSEWHEEL || m.Msg == Native.WM_MOUSEHWHEEL)
            {
                // Win32 滚轮消息发给【焦点窗口】：点过标题栏/三键后焦点留在原生控件，
                // 在页面上滚滚轮就不动（“滑不动”）。转发到光标下最深的子窗口（WebView 宿主）。
                int wlp = m.LParam.ToInt32();
                var pt = new Native.POINT();
                pt.x = (short)(wlp & 0xFFFF);
                pt.y = (short)((wlp >> 16) & 0xFFFF);
                IntPtr target = Native.WindowFromPoint(pt);
                if (target != IntPtr.Zero && target != Handle
                    && webPanel.IsHandleCreated && Native.IsChild(webPanel.Handle, target))
                {
                    Native.SendMessage(target, m.Msg, m.WParam, m.LParam);
                    m.Result = IntPtr.Zero;
                    return;
                }
                base.WndProc(ref m);
                return;
            }
            if (m.Msg == Native.WM_NCHITTEST && WindowState != FormWindowState.Maximized)
            {
                int lp = m.LParam.ToInt32();
                short sx = (short)(lp & 0xFFFF);
                short sy = (short)((lp >> 16) & 0xFFFF);
                Point p = PointToClient(new Point(sx, sy));
                int w = ClientSize.Width, h = ClientSize.Height;
                bool left = p.X < ResizeBorder, right = p.X >= w - ResizeBorder;
                bool top = p.Y < ResizeBorder, bottom = p.Y >= h - ResizeBorder;
                if (top && left) { m.Result = (IntPtr)13; return; }
                if (top && right) { m.Result = (IntPtr)14; return; }
                if (bottom && left) { m.Result = (IntPtr)16; return; }
                if (bottom && right) { m.Result = (IntPtr)17; return; }
                if (left) { m.Result = (IntPtr)10; return; }
                if (right) { m.Result = (IntPtr)11; return; }
                if (top) { m.Result = (IntPtr)12; return; }
                if (bottom) { m.Result = (IntPtr)15; return; }
                base.WndProc(ref m);
                return;
            }
            base.WndProc(ref m);
        }

        /* ---------- 关闭：× 即退出整个进程（服务随 Job Object / taskkill 一并回收） ---------- */

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            bootTimer.Dispose();
            if (trayIcon != null) { trayIcon.Visible = false; trayIcon.Dispose(); }
            if (controller != null) { try { controller.Close(); } catch { /* ignore */ } }
            server.Kill();
            base.OnFormClosing(e);
        }

        /* ---------- COM 回调桥 ---------- */

        private sealed class EnvHandler : ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler
        {
            private readonly ShellForm owner;
            public EnvHandler(ShellForm owner) { this.owner = owner; }
            public int Invoke(int errorCode, ICoreWebView2Environment environment)
            {
                owner.BeginInvoke((Action)delegate { owner.OnEnvironmentReady(errorCode, environment); });
                return 0;
            }
        }

        private sealed class CtrlHandler : ICoreWebView2CreateCoreWebView2ControllerCompletedHandler
        {
            private readonly ShellForm owner;
            public CtrlHandler(ShellForm owner) { this.owner = owner; }
            public int Invoke(int errorCode, ICoreWebView2Controller controller)
            {
                owner.BeginInvoke((Action)delegate { owner.OnControllerReady(errorCode, controller); });
                return 0;
            }
        }

        // target=_blank / window.open → 交回系统默认浏览器，不被 WebView2 静默吞掉。
        private sealed class NewWinHandler : ICoreWebView2NewWindowRequestedEventHandler
        {
            public int Invoke(ICoreWebView2 sender, ICoreWebView2NewWindowRequestedEventArgs args)
            {
                string uri;
                if (args != null && args.get_Uri(out uri) == 0 && !string.IsNullOrEmpty(uri))
                {
                    try
                    {
                        var p = new Process();
                        p.StartInfo.FileName = "explorer.exe";
                        p.StartInfo.Arguments = uri;
                        p.StartInfo.UseShellExecute = false;
                        p.Start();
                    }
                    catch { /* ignore */ }
                    args.put_Handled(1);
                }
                return 0;
            }
        }

        // 页面 → 宿主消息（主题上报）：{"ruyiTheme":"light|dark"}
        private sealed class MsgHandler : ICoreWebView2WebMessageReceivedEventHandler
        {
            private readonly ShellForm owner;
            public MsgHandler(ShellForm owner) { this.owner = owner; }
            public int Invoke(ICoreWebView2 sender, ICoreWebView2WebMessageReceivedEventArgs args)
            {
                string json = null;
                if (args != null) args.get_WebMessageAsJson(out json);
                owner.BeginInvoke((Action)delegate { owner.OnWebMessage(json); });
                return 0;
            }
        }

        private sealed class AddScriptHandler : ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler
        {
            public int Invoke(int errorCode, string id) { return 0; }
        }
    }

    /* ============================ 主题桥：页面 → 宿主 ============================ */

    // 主题归页面管（localStorage 'wcw.theme' + data-theme + 系统媒体查询），宿主不做任何存储。
    // document.created 时机注入：上报当前生效主题，并监听 data-theme 变更与媒体查询变化，
    // 使宿主标题栏/窗口图标随 app 内日夜切换实时跟随。
    internal static class ThemeScript
    {
        public const string Install = @"(function () {
  window.__ruyiDesktop = 1; // 桌面外壳标记：前端据此做壳专属默认（如工具面板首启收起）
  var last = '';
  function eff() {
    var attr = null;
    try { attr = document.documentElement.getAttribute('data-theme'); } catch (e) { }
    try {
      var t = localStorage.getItem('wcw.theme');
      if (t === 'light' || t === 'dark') return t;
    } catch (e) { }
    if (attr === 'light' || attr === 'dark') return attr;
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    } catch (e) { }
    return 'dark';
  }
  function send() {
    var t = eff();
    if (t === last) return;
    last = t;
    try { window.chrome.webview.postMessage({ ruyiTheme: t }); } catch (e) { }
  }
  function wire() {
    try {
      new MutationObserver(send).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      if (window.matchMedia) {
        var mq = window.matchMedia('(prefers-color-scheme: light)');
        if (mq.addEventListener) mq.addEventListener('change', send);
        else if (mq.addListener) mq.addListener(send);
      }
    } catch (e) { }
    send();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();";
    }

    /* ============================ 入口 ============================ */

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            bool createdNew;
            var mutex = new System.Threading.Mutex(true, @"Local\RuyiWorkbenchDesktopShell", out createdNew);
            if (!createdNew)
            {
                MessageBox.Show("如意工作台已在运行（请查看任务栏或已有窗口）。", "如意工作台",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                using (var server = new ServerHost())
                {
                    var form = new ShellForm(server);
                    server.UrlReady += delegate(string url)
                    {
                        try { form.BeginInvoke((Action)delegate { form.OnServerUrl(url); }); } catch { /* 窗口已关 */ }
                    };
                    server.Exited += delegate(int code)
                    {
                        try { form.BeginInvoke((Action)delegate { form.OnServerExited(code); }); } catch { /* ignore */ }
                    };
                    try
                    {
                        server.Start(baseDir);
                    }
                    catch (Win32Exception)
                    {
                        MessageBox.Show("找不到 Node.js：安装包应自带 runtime\\node\\node.exe，" +
                            "或请先安装 Node.js 后重试。", "如意工作台", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return;
                    }
                    catch (Exception ex)
                    {
                        MessageBox.Show("后台服务启动失败：" + ex.Message, "如意工作台",
                            MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return;
                    }
                    Application.Run(form);
                    // using 退出时 ServerHost.Kill 兜底；Job Object 是最终保险。
                }
            }
            finally
            {
                try { mutex.ReleaseMutex(); } catch { /* ignore */ }
                mutex.Dispose();
            }
        }
    }
}

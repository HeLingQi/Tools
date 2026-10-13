using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Net.NetworkInformation;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace FloatMonitor
{
    static class Program
    {
        private const string MutexName = "Global\\FloatMonitor_SingleInstance_Mutex_Native";

        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

        [STAThread]
        static void Main()
        {
            try
            {
                // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
                SetProcessDpiAwarenessContext(new IntPtr(-4));
            }
            catch { }

            bool createdNew;
            using (Mutex mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show("FloatMonitor 已经在运行中！可在屏幕右下角查看。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new FloatWindow());
            }
        }
    }

    public class FloatWindow : Form
    {
        #region Win32 API
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize,
            IntPtr hdcSrc, ref POINT pptSrc, uint crKey, [In] ref BLENDFUNCTION pblend, uint dwFlags);

        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        private static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr hObject);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateDIBSection(IntPtr hdc, [In] ref BITMAPINFO pbmi, uint iUsage, out IntPtr ppvBits, IntPtr hSection, uint dwOffset);

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern int SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);

        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr hwnd);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetSystemTimes(out System.Runtime.InteropServices.ComTypes.FILETIME idleTime,
                                                   out System.Runtime.InteropServices.ComTypes.FILETIME kernelTime,
                                                   out System.Runtime.InteropServices.ComTypes.FILETIME userTime);

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int X; public int Y; public POINT(int x, int y) { X = x; Y = y; } }

        [StructLayout(LayoutKind.Sequential)]
        private struct SIZE { public int cx; public int cy; public SIZE(int x, int y) { cx = x; cy = y; } }

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        private struct BLENDFUNCTION { public byte BlendOp; public byte BlendFlags; public byte SourceConstantAlpha; public byte AlphaFormat; }

        [StructLayout(LayoutKind.Sequential)]
        private struct BITMAPINFOHEADER
        {
            public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes;
            public ushort biBitCount; public uint biCompression; public uint biSizeImage;
            public int biXPelsPerMeter; public int biYPelsPerMeter; public uint biClrUsed; public uint biClrImportant;
            public BITMAPINFOHEADER(int w, int h)
            {
                biSize = 40; biWidth = w; biHeight = -h; biPlanes = 1; biBitCount = 32;
                biCompression = 0; biSizeImage = 0; biXPelsPerMeter = 0; biYPelsPerMeter = 0;
                biClrUsed = 0; biClrImportant = 0;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BITMAPINFO
        {
            public BITMAPINFOHEADER bmiHeader; public uint bmiColors;
            public BITMAPINFO(int w, int h) { bmiHeader = new BITMAPINFOHEADER(w, h); bmiColors = 0; }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        private class MEMORYSTATUSEX
        {
            public uint dwLength; public uint dwMemoryLoad; public ulong ullTotalPhys;
            public ulong ullAvailPhys; public ulong ullTotalPageFile; public ulong ullAvailPageFile;
            public ulong ullTotalVirtual; public ulong ullAvailVirtual; public ulong ullAvailExtendedVirtual;
            public MEMORYSTATUSEX() { this.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX)); }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX lpBuffer);

        // AMD ADL Native API
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        public delegate IntPtr ADL_Main_Memory_Alloc(int size);

        [DllImport("atiadlxx.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern int ADL_Main_Control_Create(ADL_Main_Memory_Alloc callback, int enumConnectedAdapters);

        [DllImport("atiadlxx.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern int ADL_Main_Control_Destroy();

        [DllImport("atiadlxx.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern int ADL2_OverdriveN_Temperature_Get(IntPtr context, int iAdapterIndex, int iThermalControllerIndex, ref int lpTemperature);

        private static ADL_Main_Memory_Alloc _adlAlloc = delegate(int s) { return Marshal.AllocHGlobal(s); };
        private static bool _adlInitialized = false;

        private const int WM_NCLBUTTONDOWN = 0xA1;
        private const int HTCAPTION = 0x2;
        private const int WS_EX_LAYERED = 0x80000;
        private const int WS_EX_TOPMOST = 0x08;
        private const int WS_EX_TOOLWINDOW = 0x80;
        private const string RunRegistryKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string AppRegistryName = "FloatMonitor";
        #endregion

        // Metrics
        private double _temperature = 0.0;
        private double _cpuUsage = 0.0;
        private uint _memoryLoad = 0;
        private double _memUsedGb = 0.0;
        private double _memTotalGb = 0.0;
        private double _speedDownBps = 0.0;
        private double _speedUpBps = 0.0;

        private ulong _prevIdleTime = 0;
        private ulong _prevKernelTime = 0;
        private ulong _prevUserTime = 0;
        private long _prevRx = 0;
        private long _prevTx = 0;
        private DateTime _prevNetTime = DateTime.UtcNow;

        // UI State
        private float _scale = 1f;
        private bool _isBallMode = false;
        private bool _isDocked = false;
        private bool _isLocked = false;
        private int _intervalMs = 1000;
        private System.Windows.Forms.Timer _timer;
        private ContextMenuStrip _contextMenu;
        private NotifyIcon _notifyIcon;
        private ToolTip _toolTip;
        private string _iniPath;

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW;
                return cp;
            }
        }

        public FloatWindow()
        {
            this.FormBorderStyle = FormBorderStyle.None;
            this.ShowInTaskbar = false;
            this.TopMost = true;
            this.StartPosition = FormStartPosition.Manual;

            _iniPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "FloatMonitor.ini");

            InitAdl();
            InitMetrics();
            InitMenu();
            InitTray();
            LoadSettings();
            ApplyModeSize();

            _toolTip = new ToolTip();
            _toolTip.AutoPopDelay = 10000;
            _toolTip.InitialDelay = 350;
            _toolTip.ReshowDelay = 200;

            _timer = new System.Windows.Forms.Timer();
            _timer.Interval = _intervalMs;
            _timer.Tick += (s, e) =>
            {
                UpdateMetrics();
                Redraw();
            };
            _timer.Start();

            this.MouseDown += OnMouseDown;
            this.MouseDoubleClick += OnMouseDoubleClick;
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            UpdateMetrics();
            Redraw();
        }

        // 未配置 app.config 时 WinForms 不转发 WM_DPICHANGED，需自行处理
        protected override void WndProc(ref Message m)
        {
            base.WndProc(ref m);
            if (m.Msg == 0x02E0 && IsHandleCreated)
            {
                ApplyModeSize();
                Redraw();
            }
        }

        private void InitAdl()
        {
            try { _adlInitialized = (ADL_Main_Control_Create(_adlAlloc, 1) == 0); }
            catch { _adlInitialized = false; }
        }

        private void InitMetrics()
        {
            System.Runtime.InteropServices.ComTypes.FILETIME idle, kernel, user;
            if (GetSystemTimes(out idle, out kernel, out user))
            {
                _prevIdleTime = ToUInt64(idle);
                _prevKernelTime = ToUInt64(kernel);
                _prevUserTime = ToUInt64(user);
            }
            long rx, tx;
            GetNetworkBytes(out rx, out tx);
            _prevRx = rx;
            _prevTx = tx;
            _prevNetTime = DateTime.UtcNow;
        }

        private static ulong ToUInt64(System.Runtime.InteropServices.ComTypes.FILETIME ft)
        {
            return ((ulong)ft.dwHighDateTime << 32) | (uint)ft.dwLowDateTime;
        }

        private void GetNetworkBytes(out long rx, out long tx)
        {
            rx = 0; tx = 0;
            try
            {
                foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus == OperationalStatus.Up &&
                        ni.NetworkInterfaceType != NetworkInterfaceType.Loopback &&
                        ni.NetworkInterfaceType != NetworkInterfaceType.Tunnel)
                    {
                        IPv4InterfaceStatistics s = ni.GetIPv4Statistics();
                        rx += s.BytesReceived;
                        tx += s.BytesSent;
                    }
                }
            }
            catch { }
        }

        private void UpdateMetrics()
        {
            // 1. APU Temperature
            if (_adlInitialized)
            {
                try
                {
                    int tempVal = 0;
                    int r = ADL2_OverdriveN_Temperature_Get(IntPtr.Zero, 0, 1, ref tempVal);
                    if (r == 0 && tempVal > 0)
                    {
                        _temperature = tempVal / 1000.0;
                    }
                }
                catch { }
            }

            // 2. CPU Load
            System.Runtime.InteropServices.ComTypes.FILETIME idle, kernel, user;
            if (GetSystemTimes(out idle, out kernel, out user))
            {
                ulong curIdle = ToUInt64(idle);
                ulong curKernel = ToUInt64(kernel);
                ulong curUser = ToUInt64(user);
                ulong sysDelta = (curKernel - _prevKernelTime) + (curUser - _prevUserTime);
                ulong idleDelta = curIdle - _prevIdleTime;

                if (sysDelta > 0 && sysDelta >= idleDelta)
                {
                    _cpuUsage = (double)(sysDelta - idleDelta) * 100.0 / sysDelta;
                }
                _prevIdleTime = curIdle;
                _prevKernelTime = curKernel;
                _prevUserTime = curUser;
            }

            // 3. Memory
            try
            {
                MEMORYSTATUSEX mem = new MEMORYSTATUSEX();
                if (GlobalMemoryStatusEx(mem))
                {
                    _memoryLoad = mem.dwMemoryLoad;
                    _memTotalGb = mem.ullTotalPhys / (1024.0 * 1024.0 * 1024.0);
                    _memUsedGb = (mem.ullTotalPhys - mem.ullAvailPhys) / (1024.0 * 1024.0 * 1024.0);
                }
            }
            catch { }

            // 4. Net Speeds
            long curRx, curTx;
            GetNetworkBytes(out curRx, out curTx);
            DateTime now = DateTime.UtcNow;
            double seconds = (now - _prevNetTime).TotalSeconds;
            if (seconds >= 0.2)
            {
                long deltaRx = curRx - _prevRx;
                long deltaTx = curTx - _prevTx;
                if (deltaRx >= 0) _speedDownBps = deltaRx / seconds;
                if (deltaTx >= 0) _speedUpBps = deltaTx / seconds;
                _prevRx = curRx;
                _prevTx = curTx;
                _prevNetTime = now;
            }

            // Update ToolTip
            string tip = string.Format(
                "AMD Ryzen™ 7 5700G 硬件与网络状态\n" +
                "───────────────────────────\n" +
                "APU 核心温度 : {0:F1} ℃ ({1})\n" +
                "CPU 实时负载 : {2:F0} %\n" +
                "内存 实时占用 : {3} % ({4:F1} / {5:F1} GB)\n" +
                "实时下行网速 : {6}\n" +
                "实时上行网速 : {7}",
                _temperature, (_temperature < 60 ? "低温健康" : (_temperature < 75 ? "温热负载" : "高负荷预警")),
                _cpuUsage, _memoryLoad, _memUsedGb, _memTotalGb,
                FormatSpeed(_speedDownBps), FormatSpeed(_speedUpBps));
            _toolTip.SetToolTip(this, tip);

            if (_notifyIcon != null)
            {
                _notifyIcon.Text = string.Format("温:{0:F0}℃ CPU:{1:F0}% ↓{2}", _temperature, _cpuUsage, FormatSpeedShort(_speedDownBps));
            }
        }

        private void Redraw()
        {
            int w = this.Width;
            int h = this.Height;
            if (w <= 0 || h <= 0) return;

            IntPtr screenDc = GetDC(IntPtr.Zero);
            IntPtr memDc = CreateCompatibleDC(screenDc);
            BITMAPINFO bmi = new BITMAPINFO(w, h);
            IntPtr pBits;
            IntPtr hBmp = CreateDIBSection(memDc, ref bmi, 0, out pBits, IntPtr.Zero, 0);
            IntPtr oldBmp = SelectObject(memDc, hBmp);

            using (Bitmap bmp = new Bitmap(w, h, w * 4, PixelFormat.Format32bppPArgb, pBits))
            {
                // 固定 96 DPI，字号只经 ScaleTransform 缩放一次
                bmp.SetResolution(96, 96);
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.Clear(Color.Transparent);
                    g.ScaleTransform(_scale, _scale);
                    int lw = (int)Math.Round(w / _scale), lh = (int)Math.Round(h / _scale);

                    if (_isDocked) RenderDockBar(g, lw, lh);
                    else if (_isBallMode) RenderBallMode(g, lw, lh);
                    else RenderCapsuleMode(g, lw, lh);
                }
            }

            POINT dstPoint = new POINT(this.Left, this.Top);
            SIZE dstSize = new SIZE(w, h);
            POINT srcPoint = new POINT(0, 0);
            BLENDFUNCTION blend = new BLENDFUNCTION
            {
                BlendOp = 0,
                BlendFlags = 0,
                SourceConstantAlpha = 255,
                AlphaFormat = 1 // AC_SRC_ALPHA
            };

            UpdateLayeredWindow(this.Handle, screenDc, ref dstPoint, ref dstSize, memDc, ref srcPoint, 0, ref blend, 2);

            SelectObject(memDc, oldBmp);
            DeleteObject(hBmp);
            DeleteDC(memDc);
            ReleaseDC(IntPtr.Zero, screenDc);
        }

        private void RenderCapsuleMode(Graphics g, int w, int h)
        {
            g.TextRenderingHint = TextRenderingHint.AntiAlias;

            // 1. Soft Multi-layer Drop Shadow
            for (int i = 3; i >= 1; i--)
            {
                Rectangle sr = new Rectangle(4 - i, 4 - i, w - 8 + i * 2, h - 8 + i * 2);
                using (GraphicsPath sp = GetPillPath(sr, 24 + i))
                using (Pen spPen = new Pen(Color.FromArgb(14 / i, 0, 0, 0), 1.5f))
                {
                    g.DrawPath(spPen, sp);
                }
            }

            // 2. Main Capsule Body (Radius 24)
            Rectangle cr = new Rectangle(4, 4, w - 8, h - 8);
            using (GraphicsPath cp = GetPillPath(cr, 24))
            {
                using (LinearGradientBrush bg = new LinearGradientBrush(cr,
                    Color.FromArgb(242, 16, 20, 28),
                    Color.FromArgb(245, 24, 30, 44), 60f))
                {
                    g.FillPath(bg, cp);
                }
                using (LinearGradientBrush bpen = new LinearGradientBrush(cr,
                    Color.FromArgb(140, 75, 95, 135),
                    Color.FromArgb(50, 35, 45, 65), 45f))
                using (Pen p = new Pen(bpen, 1.2f))
                {
                    g.DrawPath(p, cp);
                }
            }

            // 3. Left Circular Ball (40x40 at 8, 8)
            Rectangle br = new Rectangle(8, 8, 40, 40);
            using (LinearGradientBrush ballBg = new LinearGradientBrush(br,
                Color.FromArgb(255, 22, 28, 40),
                Color.FromArgb(255, 30, 38, 56), 45f))
            {
                g.FillEllipse(ballBg, br);
            }

            // Temperature color
            Color tempCol = GetTempColor();

            // Ring track & arc
            using (Pen trackPen = new Pen(Color.FromArgb(35, 255, 255, 255), 2.5f))
            {
                g.DrawArc(trackPen, br, 0, 360);
            }
            using (Pen arcPen = new Pen(tempCol, 2.5f))
            {
                arcPen.StartCap = LineCap.Round;
                arcPen.EndCap = LineCap.Round;
                int sweep = Math.Min(360, (int)(360.0 * Math.Max(10.0, _temperature) / 100.0));
                g.DrawArc(arcPen, br, -90, sweep);
            }

            // Center Temp Text
            string tempStr = (_temperature > 0) ? string.Format(CultureInfo.InvariantCulture, "{0:F0}°", _temperature) : "--";
            using (Font fTemp = new Font("Segoe UI", 11f, FontStyle.Bold))
            using (SolidBrush bTemp = new SolidBrush(tempCol))
            {
                StringFormat sf = new StringFormat { Alignment = StringAlignment.Center };
                g.DrawString(tempStr, fTemp, bTemp, 28, 14, sf);
            }

            // CPU load sub-text inside ball
            using (Font fCpu = new Font("Segoe UI", 6.8f, FontStyle.Bold))
            using (SolidBrush bCpu = new SolidBrush(Color.FromArgb(220, 148, 163, 184)))
            {
                StringFormat sf = new StringFormat { Alignment = StringAlignment.Center };
                g.DrawString(string.Format("C {0:F0}%", _cpuUsage), fCpu, bCpu, 28, 30, sf);
            }

            // 4. Right Section: Net Speeds
            using (Font fArrow = new Font("Segoe UI", 9.5f, FontStyle.Bold))
            using (Font fSpeed = new Font("Segoe UI", 9.5f, FontStyle.Bold))
            {
                // Down
                using (SolidBrush bArrow = new SolidBrush(Color.FromArgb(255, 56, 189, 248)))
                using (SolidBrush bText = new SolidBrush(Color.FromArgb(255, 248, 250, 252)))
                {
                    g.DrawString("↓", fArrow, bArrow, 56, 10);
                    g.DrawString(FormatSpeedShort(_speedDownBps), fSpeed, bText, 70, 10);
                }
                // Up
                using (SolidBrush bArrow = new SolidBrush(Color.FromArgb(255, 52, 211, 153)))
                using (SolidBrush bText = new SolidBrush(Color.FromArgb(255, 203, 213, 225)))
                {
                    g.DrawString("↑", fArrow, bArrow, 56, 29);
                    g.DrawString(FormatSpeedShort(_speedUpBps), fSpeed, bText, 70, 29);
                }
            }

            using (Pen sepPen = new Pen(Color.FromArgb(40, 255, 255, 255), 1f))
            {
                g.DrawLine(sepPen, 118, 16, 118, 40);
            }
            using (Font fMem = new Font("Segoe UI", 10.5f, FontStyle.Bold))
            using (SolidBrush bMem = new SolidBrush(Color.FromArgb(255, 167, 139, 250)))
            {
                StringFormat sf = new StringFormat { Alignment = StringAlignment.Center };
                g.DrawString(string.Format("{0}%", _memoryLoad), fMem, bMem, 146, 11, sf);
            }
            using (Font fRam = new Font("Segoe UI", 6.8f, FontStyle.Bold))
            using (SolidBrush bRam = new SolidBrush(Color.FromArgb(220, 148, 163, 184)))
            {
                StringFormat sf = new StringFormat { Alignment = StringAlignment.Center };
                g.DrawString("RAM", fRam, bRam, 146, 30, sf);
            }
        }

        private void RenderBallMode(Graphics g, int w, int h)
        {
            g.TextRenderingHint = TextRenderingHint.AntiAlias;
            Rectangle br = new Rectangle(4, 4, w - 8, h - 8);

            // Shadow
            for (int i = 3; i >= 1; i--)
            {
                Rectangle sr = new Rectangle(4 - i, 4 - i, w - 8 + i * 2, h - 8 + i * 2);
                using (Pen spPen = new Pen(Color.FromArgb(14 / i, 0, 0, 0), 1.5f))
                {
                    g.DrawEllipse(spPen, sr);
                }
            }

            // Ball background
            using (LinearGradientBrush bg = new LinearGradientBrush(br,
                Color.FromArgb(242, 18, 24, 34),
                Color.FromArgb(246, 26, 34, 48), 45f))
            {
                g.FillEllipse(bg, br);
            }

            // Temp color
            Color tempCol = GetTempColor();

            // Gauge Ring
            using (Pen trackPen = new Pen(Color.FromArgb(35, 255, 255, 255), 2.5f))
            {
                g.DrawArc(trackPen, br, 0, 360);
            }
            using (Pen ringPen = new Pen(tempCol, 2.5f))
            {
                ringPen.StartCap = LineCap.Round;
                ringPen.EndCap = LineCap.Round;
                int sweep = Math.Min(360, (int)(360.0 * Math.Max(10.0, _temperature) / 100.0));
                g.DrawArc(ringPen, br, -90, sweep);
            }

            using (Pen p = new Pen(Color.FromArgb(120, 75, 95, 130), 1.2f))
            {
                g.DrawEllipse(p, br);
            }

            // Temp Text
            string tempStr = (_temperature > 0) ? string.Format(CultureInfo.InvariantCulture, "{0:F0}°", _temperature) : "--";
            using (Font f = new Font("Segoe UI", 12f, FontStyle.Bold))
            using (SolidBrush b = new SolidBrush(tempCol))
            {
                StringFormat sf = new StringFormat { Alignment = StringAlignment.Center };
                g.DrawString(tempStr, f, b, w / 2, 13, sf);
            }

            // Speed Text
            using (Font f = new Font("Segoe UI", 7.5f, FontStyle.Bold))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(255, 56, 189, 248)))
            {
                StringFormat sf = new StringFormat { Alignment = StringAlignment.Center };
                g.DrawString("↓" + FormatSpeedShort(_speedDownBps), f, b, w / 2, 33, sf);
            }
        }

        private Color GetTempColor()
        {
            if (_temperature >= 75.0) return Color.FromArgb(255, 239, 68, 68);
            if (_temperature >= 60.0) return Color.FromArgb(255, 245, 158, 11);
            return Color.FromArgb(255, 34, 197, 94);
        }

        private void RenderDockBar(Graphics g, int w, int h)
        {
            using (GraphicsPath p = GetPillPath(new Rectangle(1, 4, w - 2, h - 8), 3))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(230, GetTempColor())))
                g.FillPath(b, p);
        }

        private GraphicsPath GetPillPath(Rectangle r, int rad)
        {
            GraphicsPath path = new GraphicsPath();
            path.AddArc(r.X, r.Y, rad * 2, rad * 2, 180, 90);
            path.AddArc(r.Right - rad * 2, r.Y, rad * 2, rad * 2, 270, 90);
            path.AddArc(r.Right - rad * 2, r.Bottom - rad * 2, rad * 2, rad * 2, 0, 90);
            path.AddArc(r.X, r.Bottom - rad * 2, rad * 2, rad * 2, 90, 90);
            path.CloseFigure();
            return path;
        }

        private void OnMouseDown(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left && !_isLocked)
            {
                ReleaseCapture();
                SendMessage(this.Handle, WM_NCLBUTTONDOWN, HTCAPTION, 0);
                SnapToScreen();
                Redraw();
                SaveSettings();
            }
        }

        private void OnMouseDoubleClick(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                ToggleMode();
            }
        }

        private void ToggleMode()
        {
            _isBallMode = !_isBallMode;
            ApplyModeSize();
            SnapToScreen();
            Redraw();
            SaveSettings();
        }

        private void ApplyModeSize()
        {
            // DeviceDpi 在未配置 app.config 时恒为 96，直接向系统查询
            _scale = GetDpiForWindow(this.Handle) / 96f;
            int w = (int)Math.Round((_isDocked ? 8 : (_isBallMode ? 56 : 180)) * _scale);
            int h = (int)Math.Round(56 * _scale);
            this.Size = new Size(w, h);
        }

        private void SnapToScreen()
        {
            Rectangle work = Screen.FromControl(this).WorkingArea;
            int snapDist = 20;

            // 右边缘吸附成竖条；拖离边缘时恢复原形态
            bool dock = this.Right >= work.Right - snapDist;
            if (dock != _isDocked)
            {
                _isDocked = dock;
                ApplyModeSize();
            }

            int newLeft = this.Left;
            int newTop = this.Top;

            if (_isDocked) newLeft = work.Right - this.Width;
            else
            {
                if (Math.Abs(this.Left - work.Left) < snapDist) newLeft = work.Left + 4;
                // 从竖条恢复时宽度变大，限制在屏幕内
                newLeft = Math.Min(newLeft, work.Right - this.Width - 4);
            }

            if (Math.Abs(this.Top - work.Top) < snapDist) newTop = work.Top + 4;
            else if (Math.Abs(this.Bottom - work.Bottom) < snapDist) newTop = work.Bottom - this.Height - 4;

            this.Location = new Point(newLeft, newTop);
        }

        private void InitMenu()
        {
            _contextMenu = new ContextMenuStrip();
            _contextMenu.RenderMode = ToolStripRenderMode.System;

            ToolStripMenuItem miMode = new ToolStripMenuItem("切换形态 (胶囊条 / 经典圆球)", null, (s, e) => ToggleMode());

            ToolStripMenuItem miLock = new ToolStripMenuItem("锁定位置", null, (s, e) =>
            {
                _isLocked = !_isLocked;
                ((ToolStripMenuItem)s).Checked = _isLocked;
                SaveSettings();
            });
            miLock.Checked = _isLocked;

            ToolStripMenuItem miTopMost = new ToolStripMenuItem("窗口置顶", null, (s, e) =>
            {
                this.TopMost = !this.TopMost;
                ((ToolStripMenuItem)s).Checked = this.TopMost;
                SaveSettings();
            });
            miTopMost.Checked = this.TopMost;

            ToolStripMenuItem miInterval = new ToolStripMenuItem("刷新频率");
            ToolStripMenuItem int05 = new ToolStripMenuItem("0.5 秒", null, (s, e) => SetInterval(500));
            ToolStripMenuItem int10 = new ToolStripMenuItem("1.0 秒 (推荐)", null, (s, e) => SetInterval(1000));
            ToolStripMenuItem int20 = new ToolStripMenuItem("2.0 秒", null, (s, e) => SetInterval(2000));
            int10.Checked = true;
            miInterval.DropDownItems.AddRange(new ToolStripItem[] { int05, int10, int20 });

            ToolStripMenuItem miStartup = new ToolStripMenuItem("开机自启", null, (s, e) =>
            {
                ToolStripMenuItem item = (ToolStripMenuItem)s;
                bool enable = !item.Checked;
                SetStartup(enable);
                item.Checked = enable;
            });
            miStartup.Checked = IsStartupEnabled();

            ToolStripMenuItem miReset = new ToolStripMenuItem("重置位置到右下角", null, (s, e) =>
            {
                _isDocked = false; ApplyModeSize();
                Rectangle work = Screen.PrimaryScreen.WorkingArea;
                this.Location = new Point(work.Right - this.Width - 20, work.Bottom - this.Height - 50);
                Redraw();
                SaveSettings();
            });

            ToolStripMenuItem miExit = new ToolStripMenuItem("退出", null, (s, e) =>
            {
                SaveSettings();
                if (_notifyIcon != null) { _notifyIcon.Visible = false; _notifyIcon.Dispose(); }
                if (_adlInitialized) { try { ADL_Main_Control_Destroy(); } catch { } }
                Application.Exit();
            });

            _contextMenu.Items.Add(miMode);
            _contextMenu.Items.Add(miLock);
            _contextMenu.Items.Add(miTopMost);
            _contextMenu.Items.Add(miInterval);
            _contextMenu.Items.Add(miStartup);
            _contextMenu.Items.Add(new ToolStripSeparator());
            _contextMenu.Items.Add(miReset);
            _contextMenu.Items.Add(miExit);

            this.ContextMenuStrip = _contextMenu;
        }

        private void InitTray()
        {
            _notifyIcon = new NotifyIcon();
            _notifyIcon.Text = "FloatMonitor 硬件监控";
            _notifyIcon.Icon = SystemIcons.Application;
            _notifyIcon.ContextMenuStrip = _contextMenu;
            _notifyIcon.Visible = true;
            _notifyIcon.DoubleClick += (s, e) =>
            {
                this.Visible = !this.Visible;
                if (this.Visible) Redraw();
            };
        }

        private void SetInterval(int ms)
        {
            _intervalMs = ms;
            _timer.Interval = ms;
            ToolStripMenuItem menu = (ToolStripMenuItem)_contextMenu.Items[3];
            foreach (ToolStripMenuItem sub in menu.DropDownItems) sub.Checked = false;
            if (ms == 500) ((ToolStripMenuItem)menu.DropDownItems[0]).Checked = true;
            else if (ms == 1000) ((ToolStripMenuItem)menu.DropDownItems[1]).Checked = true;
            else if (ms == 2000) ((ToolStripMenuItem)menu.DropDownItems[2]).Checked = true;
            SaveSettings();
        }

        private bool IsStartupEnabled()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunRegistryKey, false))
                {
                    if (key != null) return key.GetValue(AppRegistryName) != null;
                }
            }
            catch { }
            return false;
        }

        private void SetStartup(bool enable)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunRegistryKey, true))
                {
                    if (key != null)
                    {
                        if (enable) key.SetValue(AppRegistryName, "\"" + Application.ExecutablePath + "\"");
                        else key.DeleteValue(AppRegistryName, false);
                    }
                }
            }
            catch { }
        }

        private string FormatSpeed(double bytesPerSec)
        {
            if (bytesPerSec < 1024)
                return string.Format(CultureInfo.InvariantCulture, "{0:F0} B/s", bytesPerSec);
            if (bytesPerSec < 1024 * 1024)
                return string.Format(CultureInfo.InvariantCulture, "{0:F1} KB/s", bytesPerSec / 1024.0);
            if (bytesPerSec < 1024 * 1024 * 1024)
                return string.Format(CultureInfo.InvariantCulture, "{0:F2} MB/s", bytesPerSec / (1024.0 * 1024.0));
            return string.Format(CultureInfo.InvariantCulture, "{0:F2} GB/s", bytesPerSec / (1024.0 * 1024.0 * 1024.0));
        }

        private string FormatSpeedShort(double bytesPerSec)
        {
            if (bytesPerSec < 1024) return "0K";
            if (bytesPerSec < 1024 * 1024)
                return string.Format(CultureInfo.InvariantCulture, "{0:F0}K", bytesPerSec / 1024.0);
            return string.Format(CultureInfo.InvariantCulture, "{0:F1}M", bytesPerSec / (1024.0 * 1024.0));
        }

        private void LoadSettings()
        {
            try
            {
                if (File.Exists(_iniPath))
                {
                    string[] lines = File.ReadAllLines(_iniPath);
                    int x = -1, y = -1;
                    foreach (string l in lines)
                    {
                        string[] parts = l.Split('=');
                        if (parts.Length == 2)
                        {
                            string k = parts[0].Trim();
                            string v = parts[1].Trim();
                            if (k == "X") int.TryParse(v, out x);
                            if (k == "Y") int.TryParse(v, out y);
                            if (k == "BallMode") _isBallMode = (v == "1");
                            if (k == "Docked") _isDocked = (v == "1");
                            if (k == "Locked") _isLocked = (v == "1");
                            if (k == "TopMost") this.TopMost = (v == "1");
                            if (k == "Interval") int.TryParse(v, out _intervalMs);
                        }
                    }
                    if (x >= 0 && y >= 0)
                    {
                        this.Location = new Point(x, y);
                        return;
                    }
                }
            }
            catch { }

            Rectangle work = Screen.PrimaryScreen.WorkingArea;
            this.Location = new Point(work.Right - this.Width - 20, work.Bottom - this.Height - 50);
        }

        private void SaveSettings()
        {
            try
            {
                string content = string.Format(CultureInfo.InvariantCulture,
                    "X={0}\r\nY={1}\r\nBallMode={2}\r\nLocked={3}\r\nTopMost={4}\r\nInterval={5}\r\nDocked={6}\r\n",
                    this.Left, this.Top, _isBallMode ? 1 : 0, _isLocked ? 1 : 0, this.TopMost ? 1 : 0, _intervalMs, _isDocked ? 1 : 0);
                File.WriteAllText(_iniPath, content);
            }
            catch { }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            SaveSettings();
            if (_notifyIcon != null) { _notifyIcon.Visible = false; }
            if (_adlInitialized) { try { ADL_Main_Control_Destroy(); } catch { } }
            base.OnFormClosing(e);
        }
    }
}

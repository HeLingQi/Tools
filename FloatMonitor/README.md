# FloatMonitor

Windows 桌面悬浮硬件监控小窗，单个 C# 源文件，编译产物约 24KB，无第三方依赖。

## 显示内容

- **胶囊形态**：APU 温度环 + CPU 占用、实时下行/上行网速、内存占用
- **圆球形态**：温度环 + 下行网速
- **贴边竖条**：拖到屏幕右边缘自动吸附成细条，颜色随温度变化（绿 < 60℃ ≤ 琥珀 < 75℃ ≤ 红），拖离边缘恢复
- 鼠标悬停显示详细数据

温度通过 AMD ADL（`atiadlxx.dll`）读取，仅支持 AMD APU/显卡；其他平台温度显示为 `--`。

## 编译

只需系统自带的 .NET Framework 4.x 编译器，双击 `build.bat`，或：

```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe /optimize /out:FloatMonitor.exe FloatMonitor.cs
```

## 使用

- 左键拖动：移动位置（靠近屏幕边缘自动吸附）
- 双击：切换胶囊 / 圆球形态
- 右键菜单：锁定位置、窗口置顶、刷新频率、开机自启、重置位置、退出
- 托盘图标双击：显示 / 隐藏

支持高 DPI 和按显示器缩放。

## 配置

设置自动保存在 exe 同目录的 `FloatMonitor.ini`：

| 键 | 说明 |
|---|---|
| `X` / `Y` | 窗口位置（物理像素） |
| `BallMode` | 1 = 圆球形态 |
| `Docked` | 1 = 贴边竖条 |
| `Locked` | 1 = 锁定位置 |
| `TopMost` | 1 = 置顶 |
| `Interval` | 刷新间隔（毫秒） |

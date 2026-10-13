@echo off
chcp 65001 >nul
echo 正在编译 FloatMonitor (轻量级 C# 原生分层窗口架构)...
set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe

%CSC% /target:winexe /optimize /out:"%~dp0FloatMonitor.exe" "%~dp0FloatMonitor.cs"
if %ERRORLEVEL% EQU 0 (
    echo [OK] 编译成功！生成文件: %~dp0FloatMonitor.exe (体积仅 ~18KB, 运行时内存 ~1MB)
) else (
    echo [ERR] 编译失败，请检查提示。
)
pause

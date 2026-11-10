# pi-extension

Pi Coding Agent 实用扩展与自检测试套件集合。

## 目录结构

```text
pi-extension/
├── extensions/             # 扩展源码（放到 ~/.pi/agent/extensions/）
│   ├── auto-compact.ts     # 上下文达到 90% 阈值时自动压缩并续跑
│   ├── delegate.ts         # 主子代理委派机制（针对复杂开发任务委派子代理）
│   ├── safe-copy.ts        # 终端长命令软折行安全续行，防止框选复制断行
│   ├── token-speed.ts      # 模型生成速度实时监控 (tokens/s) 与 Footer 美化
│   ├── verify.ts           # 收尾自动执行验证命令，失败自动修复一次
│   └── goal/               # 任务目标管理扩展（/goal 跟踪任务进度与自主执行）
├── tests/                  # 对应的 Node.js 测试用例
├── lean.md                 # 子代理精简代码规范参考提示词
└── README.md
```

## 扩展介绍

### 1. `auto-compact.ts` (自动压缩上下文)
- **功能**：当会话上下文使用率达到 90% 时，自动触发 Pi 原生压缩，并携带任务进度续跑，防止长对话撑爆 context window。
- **命令**：
  - `/auto-compact-status`：查看当前上下文占用与阈值。
  - `/auto-compact-now`：立即执行压缩。

### 2. `delegate.ts` (子代理委派工具)
- **功能**：为主会话注册 `delegate` 工具，将实现细节委派给独立的子代理进程运行，主会话保持精简并统筹任务与验证。
- **配置**：支持通过环境变量自定义子代理模型：
  - `PI_DELEGATE_STD_MODEL`：默认只读分析代理模型
  - `PI_DELEGATE_SOL_MODEL`：默认代码开发代理模型

### 3. `safe-copy.ts` (安全复制/换行转换)
- **功能**：Pi 在 TUI 终端中按终端宽度软折行时，框选复制容易变成硬换行导致命令截断。本扩展通过 Markdown 转换器在代码块安全位置注入 `\` 续行符，框选复制直接可用。

### 4. `token-speed.ts` (Token 速度与状态栏美化)
- **功能**：
  - 实时监测模型吐字速度 (`tokens/s`)、TTFT 首字延迟、总耗时。
  - 美化底部状态栏（Footer），精简图标与统一分隔符。
  - `/speed` 查看上一轮请求的详细性能指标。

### 5. `verify.ts` (完成验证)
- **功能**：`/verify <命令>` 为当前会话设置验证命令，每次代理收尾前执行；失败时把诊断日志交给模型自动修复一次，仍失败则停止并保留日志。
- **命令**：
  - `/verify <shell命令>`：设置验证命令（固定设置时的 cwd）
  - `/verify`：查看当前命令
  - `/verify off`：关闭，并取消正在执行的验证

### 6. `goal/` (目标跟踪扩展)
- **功能**：提供结构化的 Goal 机制，支持 `/goal <任务>` 设置持久化任务目标，实时呈现 Plan、Next Action 与 Blockers，支持自动/手动模式自主推进。

## 安装方式

将需要使用的扩展拷贝至 Pi 的扩展目录：
```bash
# 复制所有扩展
mkdir -p ~/.pi/agent/extensions
cp -r extensions/* ~/.pi/agent/extensions/

# 拷贝 lean.md（如需使用 delegate 扩展）
cp lean.md ~/.pi/agent/
```
在 Pi 会话中输入 `/reload` 重新加载扩展即可生效。

## 运行测试

```bash
node --test tests/*.test.mjs
```

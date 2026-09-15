# Agent Note: Bedrock profile、有界请求与 Windows cmd

Status: implemented

[English](2026-09-14-bedrock-failsafe-cmd.md) | 中文

## 问题

受控代理需要有界 Bedrock 请求及可恢复输出，而 Windows 部署需要 AWS profile 和不依赖 PowerShell 的命令执行。

## 决策

[自适应代理策略](2026-09-15-bedrock-adaptive-proxy-failsafe.zh.md) 负责字节预算、期限、纠正重试、续写及交换诊断。它部分取代本记录的字符预算决策。本记录仍负责 AWS 认证和 Windows shell 选择。

profile 选择顺序为路由配置、存储的 AWS profile、`AWS_PROFILE`、`default`；凭据和刷新仍由 AWS SDK 负责。固定的 pi-ai 补丁为选中的 profile 强制使用 SigV4。显式 API-key 引用仍是可选的 bearer 认证。精简 `bedrock` preset 提供小型提示和 shell 目录，不会自动更改会话模型。

本地和沙箱 Bash 执行器也接受 `cmd` 方言。它们管理临时 UTF-8 batch 文件直到 subprocess 结束，避免嵌套命令行转义。选择此方言后，工具公布 `cmd` 和 batch 语法。共享 base 与 Web preset 在 Windows 禁用 PowerShell 行并使用 cmd，POSIX 保留 Bash。minimal preset 在 Windows 使用一次性 cmd。此选择不施加操作系统级可执行文件拒绝策略。

根目录的 `start-harness.cmd` 通过源码 `dsh` 入口启动 Web profile。仅在缺少 pnpm 安装标记时安装依赖，每次启动前构建，确保源码修改进入所提供的产物。包脚本继承 `cmd.exe` 作为 shell。启动脚本禁用基于 PowerShell 的浏览器打开程序，继承 AWS 配置，转发 Web 参数时不进行第二次 batch 展开，并保留子进程退出码。

## 考虑的替代方案

**重试相同载荷。** 代理大小错误很可能再次发生，SDK 和应用重试叠加会放大流量。Failsafe 缩减预算，并为每个纠正请求允许一次原生尝试。

**截断所有字符串。** 截断指令、schema 或工具参数会悄悄改变任务或产生无效操作。无法容纳的必要输入会显式失败。

**按字符计数限制代理预算。** 部署测量表明正文大小和请求时长是独立限制，[自适应代理策略](2026-09-15-bedrock-adaptive-proxy-failsafe.zh.md) 因此用 UTF-8 字节取代此决策。

**在 cmd 标签后复用 PowerShell。** 这会公布错误语言并保留部署排除的依赖。执行器直接启动 cmd 并公开其 batch 语义。

## 后果

[Windows ACL 沙箱决策](2026-08-08-windows-acl-restricted-token-sandbox.zh.md)继续有效：其令牌边界适用于 cmd 和可选的 PowerShell 执行器。本记录仅替代默认 shell 选择。

受控模式以流式延迟和完整历史细节换取有界请求及完整操作。缩写并非语义摘要；原日志仍可用，但省略的细节必须重新读取。过大的必要指令、工具或图片仍可能在传输前失败。即使有续写指令，模型仍可能重复文本。独立发布必须携带 pi-ai 依赖补丁，本地构建由 workspace lockfile 固定它。

单元测试覆盖限制、Unicode、压缩、重试、取消及不完整工具。Loader 和本地 HTTP fixture 执行真实 AWS 共享 profile 解析、SigV4、SDK 帧解析、502 恢复、Normal 行为及续写。Windows 测试执行含空格与 Unicode 的 cmd、取消后台工作，并通过 ACL 沙箱 runner 写入。TypeScript 和 Python SDK 投影 fixture 在持久化会话中保留请求与响应包络。Python smoke 使用构建后 CLI 的包装脚本，不验证打包的可执行文件。真实 AWS 账户权限、SSO 续期和企业代理行为需要部署 smoke 测试。

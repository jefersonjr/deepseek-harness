# Agent Note: Bedrock profile、有界请求与 Windows cmd

Status: implemented

[English](2026-09-14-bedrock-failsafe-cmd.md) | 中文

## 问题

受控代理可能以 HTTP 502 拒绝大型 Bedrock 请求，长回复也可能在输出 token 上限处停止，留下不完整工具参数。运维需要本地 AWS profile、可配置字符预算，以及不依赖 PowerShell 的 Windows 命令界面。

## 决策

pi-ai 适配器负责 Bedrock 策略。Normal 保留普通传输行为。Failsafe 默认每次序列化 SDK 输入最多 5,000 个 Unicode 码点，通过 `bedrock.maxRequestCharacters` 配置。SDK 输入计数包含 JSON 语法、base64 数据和移入 URL 的模型 id。适配器保留系统指令、工具定义和最新用户输入，缩写较早数据，并在传输前拒绝无法进一步缩减的输入。精简 `bedrock` preset 提供小型 prompt 和 shell 目录，不自动更改会话模型。

profile 依次选择路由配置、已存 AWS profile、`AWS_PROFILE`、`default`；凭据与刷新仍由 AWS SDK 负责。固定的 pi-ai 补丁为所选 profile 强制 SigV4，仅为 Failsafe 尝试禁用原生重试。显式 API-key 引用仍可选择 bearer 认证。502 会缩减输入／输出预算并触发有界、可取消重试。达到 token 上限后使用精简续写；不完整工具调用会重新生成，绝不执行。包装器缓冲到完整回复成功，统计所有尝试 usage，并在提供方事件到达时重置流空闲计时器。

`llm/bedrock-exchange` 会话事件记录每个有效请求及已结束响应。存在活动会话时，请求在网络 I/O 前 flush，不含认证标头。该事件保留无法仅从普通 assistant 消息重建的实际缩写上下文及合成续写。

本地和沙箱 Bash 执行器也接受 `cmd` 方言。它们管理临时 UTF-8 batch 文件直到 subprocess 结束，避免嵌套命令行转义。选择此方言后，工具公布 `cmd` 和 batch 语法。共享 base 与 Web preset 在 Windows 禁用 PowerShell 行并使用 cmd，POSIX 保留 Bash。minimal preset 在 Windows 使用一次性 cmd。此选择不施加操作系统级可执行文件拒绝策略。

## 考虑的替代方案

**重试相同载荷。** 代理大小错误很可能再次发生，SDK 和应用重试叠加会放大流量。Failsafe 缩减预算，并为每个纠正请求允许一次原生尝试。

**截断所有字符串。** 截断指令、schema 或工具参数会悄悄改变任务或产生无效操作。无法容纳的必要输入会显式失败。

**把 5k 当作 token 或字节。** 部署需求指定每次请求的字符数。Unicode 码点与序列化信封给出明确、可测试的解释。

**在 cmd 标签后复用 PowerShell。** 这会公布错误语言并保留部署排除的依赖。执行器直接启动 cmd 并公开其 batch 语义。

## 后果

[Windows ACL 沙箱决策](2026-08-08-windows-acl-restricted-token-sandbox.zh.md)继续有效：其令牌边界适用于 cmd 和可选的 PowerShell 执行器。本记录仅替代默认 shell 选择。

受控模式以流式延迟和完整历史细节换取有界请求及完整操作。缩写并非语义摘要；原日志仍可用，但省略的细节必须重新读取。过大的必要指令、工具或图片仍可能在传输前失败。即使有续写指令，模型仍可能重复文本。独立发布必须携带 pi-ai 依赖补丁，本地构建由 workspace lockfile 固定它。

单元测试覆盖限制、Unicode、压缩、重试、取消及不完整工具。Loader 和本地 HTTP fixture 执行真实 AWS 共享 profile 解析、SigV4、SDK 帧解析、502 恢复、Normal 行为及续写。Windows 测试执行含空格与 Unicode 的 cmd、取消后台工作，并通过 ACL 沙箱 runner 写入。TypeScript 和 Python SDK 投影 fixture 在持久化会话中保留请求与响应包络。Python smoke 使用构建后 CLI 的包装脚本，不验证打包的可执行文件。真实 AWS 账户权限、SSO 续期和企业代理行为需要部署 smoke 测试。

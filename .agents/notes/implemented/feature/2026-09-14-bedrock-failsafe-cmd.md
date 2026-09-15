# Agent Note: Bedrock profiles, bounded requests and Windows cmd

Status: implemented

English | [中文](2026-09-14-bedrock-failsafe-cmd.zh.md)

## Problem

Controlled proxies can reject large Bedrock requests with HTTP 502, while long replies can stop at the output-token limit with incomplete tool arguments. Operators need local AWS profiles, a configurable character budget and a Windows command surface that does not depend on PowerShell.

## Decision

The pi-ai adapter owns the Bedrock policy. Normal preserves ordinary transport behavior. Failsafe defaults to 5,000 Unicode code points per serialized SDK input and exposes that value as `bedrock.maxRequestCharacters`. The SDK input count includes JSON syntax and base64 data plus the URL-bound model id. The adapter preserves system instructions, tool definitions and the latest user input, abbreviates earlier data, and rejects irreducible input before transmission. The compact `bedrock` preset supplies a small prompt and shell catalog without automatically changing a session's model.

Profile selection prefers route configuration, a stored AWS profile, `AWS_PROFILE`, then `default`; credentials and refresh remain AWS SDK responsibilities. A pinned pi-ai patch forces SigV4 for a selected profile and disables native retries only for Failsafe attempts. Explicit API-key references remain opt-in bearer authentication. A 502 reduces input/output budgets and triggers bounded, cancellable retries. Token-limited replies use compact continuations; incomplete tool calls are regenerated and never executed. The wrapper buffers output until a complete reply succeeds, counts all attempt usage and pulses the stream idle watchdog as provider events arrive.

The `llm/bedrock-exchange` session event records each effective request and settled response. Requests flush before network I/O when a live session is available. Authentication headers are excluded. The event preserves the actual abbreviated context and synthetic continuation that cannot be reconstructed from the ordinary assistant message alone.

The local and sandbox Bash executors also accept the `cmd` dialect. They own temporary UTF-8 batch files through subprocess settlement, avoiding nested command-line quoting. The tool advertises `cmd` and batch syntax when that dialect is selected. The shared base and Web presets disable PowerShell rows on Windows and use cmd; POSIX keeps Bash. The minimal preset uses one-shot cmd on Windows. This selection does not impose an operating-system executable deny policy.

The root `start-harness.cmd` starts the Web profile through the source `dsh` entry. It installs dependencies only when the pnpm installation marker is absent and builds before every launch so source edits reach the served artifacts. Package scripts inherit `cmd.exe` as their shell. The launcher disables the PowerShell-based browser opener, inherits AWS configuration, forwards Web arguments without a second batch expansion, and preserves the child exit code.

## Alternatives considered

**Retry the same payload.** A proxy size failure is likely to recur, and overlapping SDK and application retries amplify traffic. Failsafe reduces budgets and allows one native attempt per corrective request.

**Cut every string to fit.** Truncating instructions, schemas or tool arguments silently changes the task or creates invalid operations. Mandatory input fails visibly when it cannot fit.

**Treat 5k as tokens or bytes.** The deployment requirement specifies characters per request. Unicode code points and the serialized envelope provide an explicit, testable interpretation.

**Reuse PowerShell behind a cmd label.** That would advertise the wrong language and retain a dependency the deployment excludes. The executor launches cmd itself and exposes its batch semantics.

## Consequences

The [Windows ACL sandbox decision](2026-08-08-windows-acl-restricted-token-sandbox.md) remains active: its token boundary applies to cmd as well as the optional PowerShell executor. This note replaces only the shipped shell selection.

The controlled mode trades streaming latency and full historical detail for bounded requests and complete operations. Abbreviation is not semantic summarization; the original log remains available, but omitted details must be re-read. Large mandatory instructions, tools or images can still fail before transmission. Model-generated continuations may repeat text despite the continuation instruction. Standalone publication must carry the pi-ai dependency patch; the workspace lockfile pins it for local builds.

Unit tests cover limits, Unicode, compaction, retries, cancellation and incomplete tools. Loader and local HTTP fixtures exercise real AWS shared-profile resolution, SigV4, SDK framing, 502 recovery, Normal behavior and continuation. Windows tests execute cmd with spaces and Unicode, cancel background work, and run a write through the ACL sandbox runner. TypeScript and Python SDK projection fixtures preserve the request/response envelopes in persisted sessions. The Python smoke uses a wrapper around the built CLI; it does not validate the packaged executable. Real AWS account permissions, SSO renewal and corporate proxy behavior require a deployment smoke test.

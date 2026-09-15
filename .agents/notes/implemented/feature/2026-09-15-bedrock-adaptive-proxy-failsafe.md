# Agent Note: Adaptive Bedrock proxy recovery

Status: implemented

English | [中文](2026-09-15-bedrock-adaptive-proxy-failsafe.zh.md)

## Problem

The deployment observed HTTP 403 at 100 KB and HTTP 502 after 246 seconds of inference, while an 82-second request succeeded. These measurements identify size and duration restrictions without establishing exact thresholds. A character ceiling rejects useful mandatory context without measuring transmitted bytes, and an output token ceiling alone cannot bound elapsed inference time.

## Decision

This note partially supersedes the character-budget and gateway-recovery decisions in [Bedrock profiles and cmd](2026-09-14-bedrock-failsafe-cmd.md). That note retains AWS profile precedence, the compact preset and Windows cmd behavior. Normal Bedrock retains its ordinary transport behavior.

Failsafe measures UTF-8 bytes of serialized SDK input, including base64 binaries, and checks the final HTTP body before transmission. Its configurable initial ceilings are 80,000 bytes and 512 output tokens, with a 128-token floor. An absolute 75-second attempt deadline includes streaming. The request and output limits are separate controls.

A 502 or local attempt deadline first halves output, then reduces the input target at the token floor. A 403 reduces input only when a configured message pattern identifies a size rejection; AWS authorization failures remain terminal. Input recovery targets the actual failed request size. Mandatory instructions, tool schemas, current user input and active tool arguments never fall back above a reduced target or get silently truncated.

Each attempt owns cancellation and transport settlement before a retry. Native SDK retries and outer provider retries are disabled in Failsafe, including an outer `always` policy. Retry count, continuation count, total attempts and total duration bound one generation. Completed text parts survive later corrective retries; failed partial output and incomplete tool arguments do not reach consumers or executors.

Successful corrective reductions are remembered per adapter, configured route identity and model for a configurable expiry. Concurrent recovery retains the smaller limits. Reloading configuration, expiry or process restart restores the configured starting limits. Learning is process-local and never raises limits automatically. Durable exchange records include byte/token ceilings, status, duration, first-content latency and failure classification; legacy character-budget records remain readable. Removed character settings fail with explicit byte-setting migration guidance.

## Alternatives considered

**Treat every 403 as size rejection.** AWS uses 403 for authorization failures. Retrying those requests cannot repair credentials or permissions and mislearns a proxy limit.

**Tune only max_tokens or reset a timer on chunks.** Neither bounds total inference duration. An absolute deadline remains active while content arrives, and its cancellation drains the owned transport.

**Binary-search the largest working budget.** Output latency depends on model, input and load. Upward probes would deliberately risk failed requests; conservative reductions with expiry provide predictable recovery without claiming an exact optimal limit.

**Persist one shared learned value.** Endpoints, AWS profiles and models have different behavior. Instance-local route/model state prevents unrelated traffic from inheriting a reduction and avoids a new persistent settings owner.

## Consequences

Reduced context loses detail, and mandatory input may still fail locally. A lower output floor can make large tool arguments infeasible; tasks need smaller complete operations. The total deadline stops local work but cannot establish that a remote service stopped billing or inference. A proxy returning only a generic 403 requires an identifiable size-error message before automatic size recovery applies.

Verification covers UTF-8/base64 limits, a short input with large instructions, preserved mandatory data, 403 classification, 502/deadline recovery, cancellation, global budgets, learning isolation/expiry and incomplete tool calls. Loader and AWS-protocol HTTP fixtures verify profile signing, final-body checks, transport closure before retries and unchanged Normal behavior. Both SDK projection fixtures retain the new diagnostics. Local fixtures do not establish real AWS permissions, SSO renewal or the corporate proxy's thresholds.

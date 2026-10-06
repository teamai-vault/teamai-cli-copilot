Event c2ef8017-5997-4d05-8f54-088464045d09; agentId=parent

在 **Workspace Scope** 检索到的 `payments-api` 已发布资料中，现场确认的 **state 恰为 E4** 且 **previous sender 已停止**，满足再次尝试的条件：需等 **250 ms** 后才可重试；这只表示允许再次尝试，不保证一定取得 generation lease。若任一条件未知或不成立，资料不授予重试权限，也未规定替代等待时间。

避免 stale owner epoch 导致重复发送，还必须确认 **former producer 已放弃 outstanding request marker**。仅确认 sender 已停止，或仅经过一段时间，都不足以证明 marker 已 relinquish；资料没有进一步规定如何取得这项确认。

实际支撑以上结论的资料（均已读原文）：

- [RetryEnvelope generation lease observations](<file:///F:/agent-workspace/multiAgent/teamai-cli-customization/.tmp/recall-29-35/handoffs/b-minimal-0.5.1/fixture/resource/contexts/payments-api/docs/40-replay-guard.md>) — **Decision conditions**：“Only when the state label is exactly E4 and the previous sender has stopped may the operation be attempted again after 250 ms.”；**Incident observation**记录了对应的 `REPLAY_GUARD_BUSY` 诊断。
- [Stale owner epoch and duplicate send](<file:///F:/agent-workspace/multiAgent/teamai-cli-customization/.tmp/recall-29-35/handoffs/b-minimal-0.5.1/fixture/resource/contexts/payments-api/docs/70-epoch-policy.md>) — **Producer epoch rule**：旧 producer 仍持有 outstanding request marker 时可能重复发送；须确认 marker 已 relinquish，单靠时间经过不能证明。

**没有找到实际支撑这些结论的 Learning**；检索到的同词 Learning 属于不同的 LedgerDrain 情况，未作为依据。

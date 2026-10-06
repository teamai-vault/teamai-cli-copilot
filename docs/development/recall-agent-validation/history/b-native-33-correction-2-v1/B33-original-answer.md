Event b4a08d9d-cd21-45ca-ae01-03473a792915; agentId=parent

**结论：**现场确认的两个条件——state **恰为 E4**、previous sender **已停止**——满足了 RetryEnvelope 原文列出的重试条件；但原文只允许在 **250 ms 后**再次尝试。因此，只有这 250 ms 已经过去，才可按该说明重试；若尚未过去，应等待到 250 ms。原文未说明这段等待从哪个时点起算，所以仅凭现有信息无法确认等待是否已经结束。

如果 state 不是恰好 E4，或 previous sender 未停止、任一条件未知或不成立，原文**不授予重试许可，也没有提供替代等待时长**。另需注意，补充规则指出：若 former producer 仍持有未完成的 request marker，可能造成 duplicate send；必须先确认其已 relinquished marker，才能将 replacement producer 视为安全。仅经过一段时间不能证明 marker 已 relinquished。该规则补充安全条件，但不单独规定 RetryEnvelope 的重试时长。（40 文档“Decision conditions”；70 文档“Producer epoch rule”。）

**诊断原文：**`REPLAY_GUARD_BUSY: RetryEnvelope cannot acquire generation lease after reconnect.`（40 文档“Observed diagnostic”）

**来源与核验范围：**TeamAI Recall 在绑定的 `payments-api` Project 中返回并标记以下两份文档为 **published**，未涉及 pending 来源：`doc:payments-api:contexts/payments-api/docs/40-replay-guard.md`，路径 `F:\agent-workspace\multiAgent\teamai-cli-customization\.tmp\recall-29-35\runtime\b\native-33-preparation-v2\resource\contexts\payments-api\docs\40-replay-guard.md`，revision `1fa6573a20a65b3d1cfea9ba98cacf5d2c5f0c53`，SHA-256（contentHash）`0e2751160489cddc7dacb81eb626a71581c0e663ed5c936cb7adf857a001ab25`；以及 `doc:payments-api:contexts/payments-api/docs/70-epoch-policy.md`，路径 `F:\agent-workspace\multiAgent\teamai-cli-customization\.tmp\recall-29-35\runtime\b\native-33-preparation-v2\resource\contexts\payments-api\docs\70-epoch-policy.md`，同一 revision，SHA-256（contentHash）`d1c3e9d39ca87b5b9192d768ba19301fcd377875fd18c9ca71199295c4001fc1`。两者 Recall 的 Project sourceHash 均为 `9d050ba1bf1d770deb29ec937702efc44ad4f02b77c49485a96d3632a4629afa`。以上 SHA 与来源元数据由 Recall 返回；原文读取确认了所引段落内容，但读取本身未重新计算哈希，也不能独立证明文件整体未变。原文读取结果未提供原始行号，故以上以可核对的章节名定位。

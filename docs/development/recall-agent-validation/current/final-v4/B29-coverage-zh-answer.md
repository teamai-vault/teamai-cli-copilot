Event 77904ed3-07b3-436f-8c5c-3d4c1ecfdc82; agentId=parent

结论：已确认的 **E4** 和 **previous sender stopped** 满足重试记录中的两个条件；该记录允许在 **250 ms 后尝试重试**。但若要把 replacement producer 视为不会重复发送，还需要**确认 former producer 已 relinquish outstanding request marker**。仅有等待时间、E4 状态或 sender 已停止，都不能替代这项确认；资料没有说明具体应以哪种日志、应答或其他信号证明 marker 已 relinquish。

现场诊断原文：`REPLAY_GUARD_BUSY: RetryEnvelope cannot acquire generation lease after reconnect.`

**依据与来源：**Recall 使用显式 `--project payments-api`，实际返回 scope 为 `workspace`、Logical Project 为 `payments-api`；检索未包含 pending 草稿。以下来源均由 Recall 标为 `published`。Recall 返回的公共 `sourceHash` 为 `698b4c8833e096c2e1ca1e016fb8d3eb615cf9d86600c0b51a9de7f35edcaf34`、资源 revision 为 `3df2318a88d551876cd587a21e4cf8435af08d3c`。SHA-256 `contentHash` 和来源身份如下；原文内容是通过 read 工具读取的，hash 是 Recall 提供的元数据，read 未独立计算 hash。

- **重试条件：**来源身份 `doc:payments-api:contexts/payments-api/docs/40-replay-guard.md`，路径 `F:\agent-workspace\multiAgent\teamai-cli-customization\.tmp\recall-29-35\runtime\b\b29-v1\resource\contexts\payments-api\docs\40-replay-guard.md`，SHA-256 `contentHash`：`0e2751160489cddc7dacb81eb626a71581c0e663ed5c936cb7adf857a001ab25`。在 `## Decision conditions` 中，原文限定：“Only when the state label is exactly E4 and the previous sender has stopped may the operation be attempted again after 250 ms.” 并说明任一条件未知或不成立时，不授予重试许可，也没有替代等待时间；仪表盘上的相同标签本身不足以证明条件成立。
- **避免重复发送的依据：**来源身份 `doc:payments-api:contexts/payments-api/docs/70-epoch-policy.md`，路径 `F:\agent-workspace\multiAgent\teamai-cli-customization\.tmp\recall-29-35\runtime\b\b29-v1\resource\contexts\payments-api\docs\70-epoch-policy.md`，SHA-256 `contentHash`：`d1c3e9d39ca87b5b9192d768ba19301fcd377875fd18c9c71199295c4001fc1`。在 `# Producer epoch rule` 中，原文指出 stale owner epoch 在 former producer 仍持有 outstanding request marker 时可能导致重复发送；必须确认 former producer 已 relinquish 该 marker，才能认为 replacement producer 安全，单纯经过一段延迟不能证明 relinquishment。该规则补充 E4 状态判断，但不替代 E4 判断。

因此，**250 ms 是满足重试条件后的等待时间，不是 marker 已释放的证据**。当前资料支持“重试条件已满足”，但没有给出如何验证 marker relinquishment 的具体操作性信号；在取得该确认前，不能据此认定 replacement producer 已具备避免重复发送的依据。引用原文按章节及摘录定位；read 输出未提供可核实的显式行号，因此不标注行号。

Event 58bf9865-5d9d-49e4-97a3-365ee43f593e; agentId=parent

按明确指定的 `workspace` Scope 和实际 Logical Project ID `payments-api` 查询时，Team AI 返回错误 `UNBOUND_WORKSPACE`：当前目录不是已绑定该 Logical Project 的 Git Workspace。

查询的完整诊断原文是：`REPLAY_GUARD_BUSY: RetryEnvelope cannot acquire generation lease after reconnect.` 因绑定错误，本次无法检索或核验相关来源；我没有改用其他 Scope 或猜测绑定。

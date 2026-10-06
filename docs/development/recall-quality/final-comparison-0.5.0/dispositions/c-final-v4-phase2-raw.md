# C / #30 final-v4 phase2 原始消费者交接

状态：**E19_ORIGINAL_8_SESSIONS_10_TURNS_NORMALLY_ENDED_MODEL_STOPPED**。仅运行批准的原 8 会话 / 10 条固定输入一次，全部 normal exit 0。C 已停止 native/model 执行；expensive-slot 的接受、关闭和释放由 root 管理。当前只交接原始测量，不宣称产品或整票 PASS。

路径相对 `F:/agent-workspace/multiAgent/teamai-cli-customization/.tmp/recall-29-35`。C branch `task/recall-30-c`，worktree `worktrees/c-quality-30`，HEAD `c73d27a6c33e9bdd4ad91150f3facb8a661a8ee8`，仍 clean，无生产提交。产品 base `0fb99a7b065de71eb683d774231b518971b57e8c` / 0.4.0；实际 target `4977e40ac7e6d327f63710302bac137177f70193` / 0.5.0。root 文档集成 `2a5506349ecb1a8dc35cda874c319e79788a590a` 没有替换实际 runtime。

## 冻结身份和实际授权

- E19 plan `slots/E19-C30-native-v4-plan.json` SHA `6654cc9263725f45671a26ae2337f92e462ce9489a561165fd05565e0ea0d36e`；actual active slot 原字节另存 `native-v1/phase2-active-slot-at-seal.json`。
- manifest SHA `56f6935e691e87a0d48ede91670e12c22c41004b1fd04323606d14645f8c854e`；tar SHA `b1d9bf3a73525dcc289e87e8afd7a35180d98fe7a1259db7bb7607eaf6389656`；Agent 9279 bytes / SHA `03562f41201196a8272e3fbbd6997f989ba6eceb34bbae99276fe1e4359a0452`。实际包、CLI、Agent、Skill、commands 字节仍匹配。
- 31 个离线准备索引项和 99 个 phase1 实际索引项全部原字节匹配。C 固定 fixture tree 仍 `d185a284718659d296afa2f93cea7f225bfb41b5`；原概念、锚点、ID、位置、原文与独立预期未改，旧 FAIL 未覆盖。
- full owned delivery、E18 normal consumer preflight 的固定接受文件仍匹配；consumer 实际 1.0.92，旧基线 1.0.91 的 vendor confound 保留。Auto，无模型/SDK/API/发现/权限覆盖参数。

## 原始会话和可见观测

actual output root：`handoffs/c-quality/final-comparison-v4-ready/native-v1`。各 label 都有 invocation、terminal.raw、usage、exit、curated task-events，以及前后保护记录。事件投影保留任务可见字段，未复制 account/auth/config/session identity 或 opaque/reasoning/provider 字段。

| Label | 固定 session ID | 原题数 | Recall | view | normal exit |
| --- | --- | ---: | ---: | ---: | ---: |
| C01 | 0959f296-9f52-4fdb-bae8-8084fdf36417 | 3 | 1 | 5 | 0 |
| C02 | 310e4936-72d3-47ed-bb19-4fad1869d517 | 1 | 1 | 1 | 0 |
| C03 | 33af9d7b-a224-47a3-8248-b3de845ea55c | 1 | 2 | 3 | 0 |
| C04 | 748dee5f-e97f-4c59-b6b8-6755742c674b | 1 | 1 | 2 | 0 |
| C05 | f9e182db-a515-41a9-aefd-91c8da1bed19 | 1 | 1 | 2 | 0 |
| C06 | e48bf436-1bcf-45a0-b6e4-b186e452ade0 | 1 | 2 | 0 | 0 |
| C06-missing | ed6cec1f-5ba6-4fc1-b92c-d32f46780f56 | 1 | 2 | 0 | 0 |
| C06-damaged | 992e31ee-cc06-427b-b1fa-c427877b6b3c | 1 | 2 | 0 | 0 |

12 次实际 Recall = 8 success + 4 真实 CACHE_UNAVAILABLE；23 个返回 hit 的原文/provenance/hash/snippet 核对无失败。13 次 view = 12 次原文读取 + 1 次 commands reference；9 个不同原文，12 次原文完整字节核对无失败。34 tool starts；本轮无 native task delegation，实际路由为 selected Agent direct。旧轮 caller/child delegated 结果继续独立保留，不能把路由不同当作同一机制的确定改进。

`phase2-selection-readback.json` 对每条 actual user.message 取此前最后一个 selected/deselected 事件，10 条都处于 teamai-recall，10 条与冻结输入一致。C01 首题由当时当前 footer + 最终事件序列确认；C01 后两题有提交前单独记录。C02/C03/C04/C05/两个 controls 在启动通知之后实际回到 Default，C 已在首题前通过正常菜单选择 Recall；当前菜单/footer 和原始事件均保留，未仅凭 --agent/banner 推定选择。C06 当前 footer 保持 Recall。实际 C01 首题 gpt-6-luna，英语/指代两题 claude-haiku-4.5；其他七个会话 gpt-6-luna，Auto 实际结果未改。

现有 readback 记录每条实际 query 的 limit 5、前五覆盖、前三弱候选、tuple 和原文读取。native limit 10 未请求，标 UNVERIFIED_NOT_REQUESTED；固定 public CLI phase1 的同一 34 个输入在前 5/10 的比较继续见 phase1-report，不以 native 5 反推 10。内部 CLI read 成本、USD price 未验证。

可见 usage 原字段累计：totalUserRequests 10；totalPremiumRequestCost 8.66；totalNanoAiu 4039302000；totalApiDurationMs 166688。native process elapsed 总计 1647400 ms，含启动、人工单次审批、观察/捕获等待与正常退出，不能称为 query-only latency。原 baseline 各字段保留，不从这一次结果作模型成本或检索性能的因果结论。

## 保护与真实质量边界

- 原 owning native 190→190 facts，所有会话前后及 control 前→全结束均 0 delta。原 fixed CLI 215→215 facts，0 delta。new missing 5→5、damaged 10→10 fictional .teamai facts 各 0 delta。沿用原实际 COPILOT_HOME/native login，不复制认证、ownership 或 session；controls 不是 native ownership 证明。
- 只记录两个 exact ordinary per-case HOME StartupProfileData-NonInteractive 路径；8 个 changed occurrences 的全字节 before/after 在原始输出中。generating PID 未独立观测，未声称整 HOME/AppData 零变化或给予目录豁免。
- C02 至两个 controls 共 7 个会话，在运行中观察到 launcher/node/copilot PID，结束后均 absent。C01 transcript 可取 launcher 30876，当前 absent；未在结束前保存 child PID，明确 UNVERIFIED，不补造 child 退出证据。所有 8 个正常 exit 0 原记录保留。
- C01 原 retry AND/forbid 条件获得支持，但英语改写 final event `c8bb3cc8-5612-4e73-b4ba-7cd457b1d545` 把完整 diagnostic 缩为 `ACME_E_BARRIER_412: retry budget exhausted`，丢失 `for tenant=demo-7`：**保留 FAIL**。英语/指代最终来源压缩与缺失字段仍保留；C02 最终未给 sourceHash。原事件和答案不改，待离线逐条质量表界定范围。
- C03 保留 30000/45000 冲突而未合造值，完成条件读到长文后段与互补原文；C04 800/equal jitter 和复制关系、C05 blue/未执行注入、正常 no-hit 与 missing/damaged cache error 的分开处理均为本次已见观测，不替代最后独立 review 或全票接受。未跑变体仍未验证，不重抽样、重跑或修 prompt。

## 索引、复跑方法和下一步

新 sealed `native-v1/phase2-artifact-index.json`，203 项，SHA `2bb04958a076bcf06f8f5758aca5f8332183697fc1740f003a05b73806bc3f88`。summary SHA `c5bbbecbc30de7c443cdcb17ad4f1b4ee2b81670e3b07d376c6be08767815783`；selection SHA `24ed41de4da9ee539bdcb9ef778576155f7d50d0864e3d0e4e52520ef6971c4b`；protection SHA `f9a1ecd0231108a8c99e03067b8f45a7f9799c0d6561f8a91f2a41f92feaa69b`；identity SHA `d16ba20a0e4cb35a499c25c947a0f18e4ed0a22a46db0f52c66611e542865217`。

实际只调用已经接受的 v4 prepare-controls 一次、原 launch-native 各 label 一次、原 snapshot/capture/control-profile-snapshot，并在正常结束后调用 unchanged readback-native-observations / summarize-native-readback 各一次。无额外 native/model/version/login/sync/fixture prepare。记录原命令和时段见 invocation/exit、phase2-readback/summary-exit；复现时必须由 root 给新隔离身份和串行时段，不重复使用已 sealed 的 session/output 路径。

请 root 回读并接受这批 raw，关闭/释放 E19，再给 C 文档集成后的明确 doc-only base/target。C 下一步仅可写质量比较报告与所选 raw evidence，更新 handoff-c-quality；当前不移动 worktree/source、不提交新生产或公共 delta、不 push/merge/release/闭票。原始测量已结束，最终报告接受与整票交付仍待 root。

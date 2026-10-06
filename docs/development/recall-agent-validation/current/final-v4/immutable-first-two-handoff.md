# B E16 两例停止检查交接

E16 仅运行原冻结中文、英文 coverage 各一次，均新 session、正常结束，recorder/protection 全部 exit 0，原题逐字匹配。行为判断待总协调；中文 hash 精度与英文父回答引用限制如实保留，不称全 PASS。未启动其余八项，也未修改 prompt、源码、任务、oracle、语料或 runner。

身份：`4977e40ac7e6d327f63710302bac137177f70193` / tree `ad24e49fe5c958a22bbaaa111c5193de56c4ab86` / final-v4 / package 0.5.0。Agent 9279 bytes，SHA `03562f41201196a8272e3fbbd6997f989ba6eceb34bbae99276fe1e4359a0452`；tarball SHA `b1d9bf3a73525dcc289e87e8afd7a35180d98fe7a1259db7bb7607eaf6389656`。原拥有者 Agent receipt SHA `7f741adf0c476a1c3009a2cb002c13409702b19ee6ac7419dfc630581636529c`，Skill receipt `43b1ca9f4b6d1516ee43e613cfc453bac5ad1c7bfdbad59aff13c1d75dc361b2` 未变。精确 E16 plan SHA `106b48a15c2912ad6e245fa2f7d8995c440c489a36f54cfeec16618c93468da4`；[root activation](supervisor-b29-stop-native-activation.json) 与正常交付验收均由 guard 绑定。

使用原正常 Copilot 1.0.92，Auto 实际为 `gpt-6-luna`，无 model override；英文 Recall child 为 model unset / session inheritance。只给原冻结 caller，普通单次许可，没有 oracle/排名/路径列表/理想答案输入。源码/来源身份和业务/Git保护由原 observer/recorder记录，不将静态指令当行为通过。

| 实际例 | Session / 实际路径 | 查询及读取 |
| --- | --- | --- |
| 中文 | `e7339469-a2f9-4dbd-ad61-06f00db057de`；所选 Recall Agent 直接回答，无 child | 3 Recall，均 CLI 0；3 个返回原文 View（40/70/10），另 1 个合法 bundled commands reference View |
| 英文 | `7cff9c8a-e87c-432a-b252-d22e51cbf0b1`；1 parent + 1 Recall child | 3 Recall，均 CLI 0；3 个返回原文 View（40/70/90） |

两例所有 Recall 都在原文读取之前发出；完成读取后直接作答，没有新查询。重复返回的 40/70 各只 View 一次。中文诊断词查询实际是 10 在前、40 在后，两份均读，回答采用有处置依据的 40；70 不在首个诊断查询返回中，由另一查询补入。英文精确诊断 query 用当前支持的 required literal，只返回 40；其他查询补入 70；未读 10，不能称英文证明 weak-first 原文比较变体。没有为排名变体重跑。

已核对原文与实际回答：完整诊断、Project payments-api、E4 + previous sender stopped、250 ms、marker relinquishment 的独立条件均保留；中文及英文 child 明确 unknown/false 不授予重试许可、无替代时间。没有把停止/等待当作 marker 释放证据，没有借 90 的 LeaseMux/Z8 条件处理 RetryEnvelope。中文直接回答与英文 child 保留 doc ID、原文路径、published、revision、sourceHash/contentHash 字段和真实 section/excerpt，不估算行号；中文 70 hash 值存在下述精度缺陷。

**中文 hash 精度限制：**最终 event `77904ed3-07b3-436f-8c5c-3d4c1ecfdc82` 的 70 contentHash 为 `d1c3e9d39ca87b5b9192d768ba19301fcd377875fd18c9c71199295c4001fc1`（63 位），实际 returned/read hash 为 `d1c3e9d39ca87b5b9192d768ba19301fcd377875fd18c9ca71199295c4001fc1`（64 位），少一个 `a`。完整原始答案保留；见 [实际精度观察](b-native-29-v3/operator-provenance-limitations.json)。不把字段存在或核心结论正确当作精确 hash 通过。

**英文父回答限制：**parent event `032bf061-f426-461d-bad3-0d7065fbb247` 保留诊断、主要条件、Project/published/revision/section，但省略完整 source ID/hash/实际返回路径；两个 `contexts/payments-api/docs/...` 相对链接在实际 cwd 不存在，也不等于任何实际返回 file。独立 child event `1a33179d-da39-4366-9b7d-cf2513e65df4` 的完整 provenance 不能升级为父回答通过。原文、父/子输出及实际链接读回均在 [英文 observation](b-native-29-v3/B29-coverage-en-operator-observation.json)。child 正常完成与随后退出时 cancelled cleanup 事件均保留。

[中文 evidence](b-native-29-v3/B29-coverage-zh-evidence.json)、[英文 evidence](b-native-29-v3/B29-coverage-en-evidence.json) 分别连接实际原 session events、query/read/answer/metrics/observable-events 和完整保护。原 session events 在原拥有者 HOME 保留，没有复制账户、认证、reasoning 或 provider request 数据。指标按原 native metrics 记录：中文 model requests 5 / API 33527 ms / wall 296929 ms；英文 requests 7 / API 58449 ms / wall 269248 ms；code changes 均 0，包含人工许可等待。

两例新 13 business / 5 Git 仅每例第一个精确 PowerShell StartupProfileData 文件变化，旧 8/5 每例与累计均 0；两条 startup 的完整 before/after 字节均保留，生成 PID 未独立观察。对应 [中文 protection](b-native-29-v3/B29-coverage-zh-protection-readback.json) 和 [英文 protection](b-native-29-v3/B29-coverage-en-protection-readback.json)。launcher PID 23376 / 16236 实际读回均已不存在；normal exit、record、protect 六项全 0。两个起初猜测路径的 operator 只读命令 exit 1 原样保留，已改读实际 slot/guard；未触发 native/model 或产品失败。

历史中文 STOP Major（8000 / Agent9036）、旧 citation FAIL（Agent9020）、新 citation 限定接受（8000 / Agent9036）及旧 read-gap 身份边界均保留；见 [原暂停交接](b-29-two-coverage-stop-checkpoint-v1-handoff.md)。这两例是新身份一次实际观察，不宣称确定性名次、保证行为或整票通过。

实际只授权两例，其他八项仍 NOT_RUN：context、dedup-conflict、none、unbound-git、non-git、explicit-workspace-unbound-git、explicit-project-non-git、supplement-intake。没有新 setup/producer/sync/version-help/build/pack 或旧候选抽样。Shared delta NONE。等待总协调接受/纠正及明确继续时段。

[新 raw artifact index](b-native-29-v3/native-two-coverage-stop-artifact-index.json) 仅封存本次新 raw 与两个原 session events 身份；旧 257/105/222 索引未重复重验。


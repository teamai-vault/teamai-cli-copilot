# B 引用策略纠正1：不可变源码交接

本交接只证明 scoped source correction 与静态检查。旧注入消费者 Minor/硬AC3/5 FAIL保留；新revision的行为NOT_RUN。Root已释放E9，剩余10个#29实际用例仍NOT_RUN。没有新的昂贵slot。

- base: e0eb6a4734b78608709fb16398701cbbf26cae4a
- target: 8000bae22cf6a3490578e25e1af6b618e73267d5
- tree: 52d2654f7e7db6b880409a066d0351dbbf16f5f8
- branch: task/recall-29-b
- worktree: F:\agent-workspace\multiAgent\teamai-cli-customization\.tmp\recall-29-35\worktrees\b-agent-29
- prior B target: 2bb7f890a3d61ddaf32e4503a4cd3e68b86dcb8d
- accepted merge: clean worktree 后依明确派单执行 git merge --ff-only e0eb6a4734b78608709fb16398701cbbf26cae4a，normal0；已集成共享五文件随快进接受，不是本修正的写入或提交。
- only committed files: agents/teamai-recall.agent.md / docs/development/builtin-recall-agent.md（2 insertions /2 deletions）；无其他文件。

最小通用策略：优先实际观察到的section加exact excerpt，覆盖支撑语句及其限定条件。数值行号只由read显式行标签或明确确认且可靠的读取范围建立，发送前核验实际支撑语句。不能从无行号正文、整文件diff hunk或另一个语句的snippet bounds估数。无这些支撑时用section/excerpt定位，只描述本次实际限制，不宣称消费者绝无行号能力。无fixture ID/答案/特例提示。

前置read/execute aliases、#29 intent/query/dedup/stop/Scope与#33 provenance/diagnostic/read-gap/injection边界等其余Agent/专属说明字节全部原样。每份文件仅替换一个引用paragraph，原before完整字节备份/after git committed blob一致性留存。没有SDK/API/模型/服务、查询配额或公共CLI/helper/README/reference/Skill/package/version/fixtures/oracles改动。

| File | Before bytes /SHA-256 | Committed after bytes /SHA-256 |
| --- | --- | --- |
| agents/teamai-recall.agent.md | 9020 / 5d183aaa9542627065b43454df176d6ef5e0dc583b6feceff79227dcec5eebca | 9036 / 7e882003883ea008c30b9c567f77578e318077162ebbba090bcdf901fa27c48f |
| docs/development/builtin-recall-agent.md | 12761 / 7351b46a6ea685f6bb432050e6a5955837f2c4e8e65a0ee8287d61a0e7962535 | 12794 / 55b01e07dc6f560cf961298e7d6ac1fc4f03b01b843354cbff106227f93b6f6b |

实际已跑：git diff --check normal0；staged diff --check normal0；frontmatter raw exact unchanged（read/execute）；仅2文件/2段改变且其余字节原样；无fixture-specific引用提示；git show target:<file>两份raw blob与worktree精确相等；HEAD parent为base；scope local commit normal0且final status clean。精确命令、stdout/stderr原字节及正常exit分列在本目录，committed-diff.stdout是完整2文件diff。

只读precommit operator检查曾把所有active hook当作昂贵hook，实际assertion exit1发生在staging/commit前。后读源码发现仅全局prepare-commit-msg移除Co-Authored-By行，无test/build/pack/native/sync；正常保留该hook提交成功，无跳过/修改。原operator reject与具体hook disposition分开保存，不把它改写为成功。

| Acceptance item | 此修正状态 /后续 |
| --- | --- |
| #33 AC3准确定位 | 一般策略已修改并静态核验；旧header L10/L12实际错引仍FAIL；新实际query/read/final定位需root候选复验。 |
| #33 AC5只读且诚实回答 | 无执行授权/Scope边界保持，旧实际安全边界证据保留；引用准确性硬项复验NOT_RUN。 |
| #33其余read/provenance/diagnostic/read-gap/injection | 原规则全部字节保留；两旧case/元数据/正常0/原observer1/745B恢复/父层transcript limitation均不改写，不能由本静态修正升级为新行为PASS。 |
| #29意图/多角度query/去重/原文比较/后位候选/停止/中英文及unbound | 原实现全部原样；10个冻结本批实际场景NOT_RUN，待root调度。 |

未跑：unit/full tests/typecheck/build/pack/install/sync/native/model、可选direct-main/其他platform/revision-hash冲突和剩余10场景。此前11 delivery tests/最终e0eb gates属于历史证据，未重跑，也不标为本revision通过。当前旧实际已投递Agent仍属旧immutable final-v2，不自行复制或覆盖它。

Root下一步：只读源diff/静态证据接受后，统一集成、必要gates/pack、普通owned投递，再给精确新candidate/时段和受影响真实消费者复验。B不push/全局merge/发布/升版/闭票。共享delta: NONE。

不可变证据引用（包括旧root滚动handoff快照；不使用当前滚动文件作为证据身份）：
- F:\agent-workspace\multiAgent\teamai-cli-customization\.tmp\recall-29-35\handoffs\supervisor-b29-injection-citation-reject.json — 2146B / fc28d77a8747a0298e8cff3e0a90e310da8ae1fa115523b3435760e7bce52d7c
- F:\agent-workspace\multiAgent\teamai-cli-customization\.tmp\recall-29-35\handoffs\supervisor-b29-first-case-disposition.json — 8484B / f1482eca466dfe4cad42c24baedce1cacd1217ab6bbab044c9cf5e328e6aa078
- F:\agent-workspace\multiAgent\teamai-cli-customization\.tmp\recall-29-35\delivery\b-through-injection-handoff-snapshot.md — 44665B / 979f1f85a5422adc7cc79308cc4112271f38d60ae9fecbb5f0a6b8350dccee8d
- F:\agent-workspace\multiAgent\teamai-cli-customization\.tmp\recall-29-35\slots\E9-B29-final-native-v1-plan.json — 24831B / ac2bdae01f6ef5f817aaebcfac83caaf4be15dd7c05045bda2c1a9ab43f81b42
- F:\agent-workspace\multiAgent\teamai-cli-customization\.tmp\recall-29-35\handoffs\b-native-29-v1\native-through-injection-artifact-index.json — 60603B / cd0613d7a5505105aa1a6cc222fcb3e736f89fc43fedc1cfbc66a3a7fcf00f5f
- F:\agent-workspace\multiAgent\teamai-cli-customization\.tmp\recall-29-35\handoffs\b-native-29-v1\native-through-injection-artifact-index-receipt.json — 436B / 0152756c75545ad128248893944b523f3ce0f1bdcd43b554efec41a5d92871da
- F:\agent-workspace\multiAgent\teamai-cli-customization\.tmp\recall-29-35\handoffs\b-native-29-v1\B33-injection-answer.md — 4693B / d2e184d743aa5e174cba66c52b56fc891c73875614089e5fcee1ff423bd25096
- F:\agent-workspace\multiAgent\teamai-cli-customization\.tmp\recall-29-35\handoffs\b-native-29-v1\B33-injection-reads.json — 5474B / 56f551a16383896b0e6567a3eaa4617e7d0e41f2996952d37c00f8b049ee40aa

此文件及其index独立冻结。handoff-b-agent.md只提供发现入口，旧ready中的滚动pointer过期事实不改写；旧scoped raw/index/当时核验仍有效。

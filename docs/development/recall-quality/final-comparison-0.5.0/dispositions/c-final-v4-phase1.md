# C / #30 final-v4 phase1 实际交接

状态：**PHASE1_FINISHED_STOP_FOR_ROOT_ACCEPTANCE**。E17批准的四步已按顺序正常结束；C已停止实际运行，等待root owned after与独立CLI回读。未materialize新native controls，native/model/session为0，无init/rebind/新consumer/login/源码/fixture/oracle改动。昂贵slot状态仍由root管理。

路径相对 `F:/agent-workspace/multiAgent/teamai-cli-customization/.tmp/recall-29-35`。C branch `task/recall-30-c` / worktree `worktrees/c-quality-30` / HEAD `c73d27a6c33e9bdd4ad91150f3facb8a661a8ee8`；产品base仍0fb99a7/0.4.0，target `4977e40ac7e6d327f63710302bac137177f70193` / 0.5.0。

实际授权：`slots/E17-C30-sync-cli-v4-active-plan.json`，SHA `5f5b4b4973cb54422c066e5eb3d067c552a3b6ab1cf1d45c64f1e20f8b765939`。manifest仍final-v4，SHA `56f6935e691e87a0d48ede91670e12c22c41004b1fd04323606d14645f8c854e`；实际tar SHA `b1d9bf3a73525dcc289e87e8afd7a35180d98fe7a1259db7bb7607eaf6389656`，Agent SHA `03562f41201196a8272e3fbbd6997f989ba6eceb34bbae99276fe1e4359a0452`。

## 实际结果和记录

- 原prepared.root的fixed snapshot、native snapshot、既有recorder sync、既有run-final-cli四个外层步骤均normal0；stdout/stderr/exit/时段在 `handoffs/c-quality/final-comparison-v4-ready/native-v1/phase1-step{1,2,3,4}.*`。
- 正常public sync0，93167ms；projects list0，553ms；fixed after snapshot0，248ms。Agent、Skill、commands实际目标字节匹配候选，无Agent pending；**完整Skill receipt ownership/未知字段语义仍待root**，不从目标hash代推。
- 固定CLI report：`handoffs/c-quality/final-comparison-v4-ready/cli-v1/cli-report.json`。34个Recall调用串行完成：26个exit0，8个真实缺失/损坏cache返回exit1 / `CACHE_UNAVAILABLE`；34协议PASS、0协议FAIL。必要来源覆盖22PASS/0FAIL，12项NOT_APPLICABLE。三个version/help/projects观察均normal0，实际version0.5.0。
- 121个返回hit的原文/provenance/hash/snippet核对均PASS，0mismatch；固定215facts前后相同。原fixture/K/F/普通中文输入和请求5/10与0.4.0成功基线34项逐字一致。
- native保护快照190→190，raw差异6项：Agent/Skill/commands目标、Agent/Skill receipt、项目state。完整before/after哈希在 `native-protected-before-final-sync.json` / `native-protected-after-final-sync.json` 及 `phase1-report.json`；这些是同步变化的实际记录，**尚未作语义或ownership接受**。root已记录其完整owned/Startup before，after由root原方法完成。

`native-v1/phase1-report.json`补实际tarball/安装identity join、逐query必要来源位置、前5/10完整ID序列与前三弱候选、frozen quote在snippet中的可见性、cache error、耗时及与原0.4.0对照。原CLI机器report中的tarball UNVERIFIED字段不覆盖，join单独记录。

实际新旧34项中17个有序hit列表不同，同observation/同ID的snippet或行段变化102次；22项必要来源覆盖在两版均PASS，不能把排名/片段变化一概当作质量胜。C06普通英文整句仍可返回由常用词命中的无关来源，K查询为空；健康no-hit与cache errors分列。所有model原文read/最终答案/执行边界在此阶段UNVERIFIED，CLI candidate PASS不等于答案PASS。

Recall总耗时30175ms / 测量31692ms；旧成功基线28952ms / 30440ms。仅一次本机进程时间，不作性能显著性结论；无模型成本，内部读成本分解未验证。正常sync stdout实见consumer1.0.92，尚不代表新的官方稳定/fresh模型前置验收。旧真实native基线1.0.91→当前1.0.92的vendor confound继续保留。

## 后续与可复跑定位

本轮严格复用 `handoffs/c-final-comparison-v4-ready.md` / `slot-request.json` 的原四步：旧measure脚本snapshot原prepared.root到新fixed-protected-before；既有v4 recorder snapshot→sync；既有v4 run-final-cli，未重复prepare。原37调用全stream及原始保护maps保留在新cli-v1/native-v1。实际phase1索引为 `native-v1/phase1-artifact-index.json`，不重写离线准备索引或历史baseline。

请root在同一候选上执行其既有full owned after，接受真实Skill owner/version/root/unknown fields、两target bytes、所有setup delta与两exact Startup before/after，独立接受固定CLI比较，并完成fresh正常consumer前置后，再单独分配phase2原8sessions/10turns。届时以首题前当前UI/selected事件确认Recall Agent状态，caller/child分别记载，各原题一次。当前Agent prompt冻结，旧#30混合FAIL保留，其他未跑变体未验证。**phase1测量完成，#30最终真实消费者比较尚未完成。**

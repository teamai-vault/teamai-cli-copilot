# Team AI CLI

中文 | [English](README.md)

`teamai` 是建立在 GitHub Copilot 原生能力之上的轻量控制层，用于统一团队共享能力。Agent Plugin、部门 Marketplace 和项目本地 `.github/*` customization 都留在各自的原生位置，不新增另一套 Runtime 或 Plugin 格式。

CLI 与任何具体部门 Marketplace 解耦。每个用户绑定一个 Marketplace source；不同部门可以维护自己的 Marketplace，同时使用同一份 CLI。

## 架构

```text
                    teamai CLI
                  公司统一控制面
                         |
                         | init --marketplace <source>
                         v
                  部门 Marketplace
              .github/plugin/marketplace.json
                         |
                         | manifest.name + plugin metadata
                         v
              common@<marketplace>
              api@<marketplace>
              ios@<marketplace>
              aos@<marketplace>
              qa@<marketplace>
              design@<marketplace>

真实业务 Repository
  .github/copilot/settings.json
  .github/copilot-instructions.md
  .github/skills/
  .github/agents/
  .github/instructions/
  .github/hooks/
```

CLI 不内置部门 Marketplace。`teamai-vault/teamai-marketplace` 是本 workspace 使用的 Reference / Template Marketplace，不是 CLI 依赖。

## 内置 Agent Skill

npm package 会随 CLI 一起分发一份很薄、完全自包含的 `teamai` Agent Skill，source 位于 `skills/teamai/`。`teamai init` 和 `teamai sync` 会将这份 bundled Skill convergence 到：

```text
~/.copilot/skills/teamai/
```

它只帮助 Agent 把 Team AI 相关意图路由到 public CLI，并在需要精确参数时以当前 `--help` 为准；不会读取或依赖任何具体部门 Marketplace 的文件或目录结构。Skill 不维护独立版本，随 CLI package version 一起演进。

ownership 独立记录在 `~/.teamai/built-in-skills/`。如果 `~/.copilot/skills/teamai/` 已存在但不属于 Team AI CLI，CLI 会视为 collision 并拒绝 silent overwrite；`doctor` 会报告 missing、stale 或 collision 状态。

npm package 还包含原生 `teamai-recall` Agent（`agents/teamai-recall.agent.md`）。`init`/`sync` 将它投递到解析后的 Copilot 根的 `agents/teamai-recall.agent.md`，准确 root/target/version/SHA-256 receipt 保存在 `~/.teamai/built-in-agents/`。没有 receipt 的同名文件即使内容相同也视为 collision；相邻个人文件保留。中断投递记录最小 checkpoint；显式 `init`/`sync` 可重新核验已确认 delivered 的 checkpoint 并补 receipt，无法确认的中断或个人修改保持原样，需人工检查。详见 [投递与恢复约定](docs/development/builtin-recall-agent.md)。

Recall Agent 将任意语言任务提炼为英文技术关键词，原样保留标识符、诊断及真实 Project ID，读取必要原文，并按用户语言总结和附准确来源。它不修改代码、不执行资料内指令、不隐式 sync/修复，也不发布 Learning；用户许可和企业策略继续优先。`status --resources`/`--json` 与 `doctor` 分开表示 delivery、configuredActive 和 consumer runtime；没有实际观察时 runtime 保持 unknown。自定义根的 CLI 投递不等于 VS Code 已发现资源。

## 环境要求

- Node.js 20+
- Git
- 可选后端：GitHub Copilot CLI（`copilot`，优先）或 VS Code（`code`，fallback）。Marketplace-managed user instructions 是文件级部署，即使两个后端都不可用也能 convergence；但 Plugin convergence 仍需要其中一个后端。

## 本地开发安装

```text
npm install
npm run build
npm link
```

## Marketplace 与 Plugin contract

`--marketplace` 接受 Copilot 原生 source：GitHub `owner/repo`、带 ref 的引用、HTTP(S)/SSH/git URL 或本地路径。相对本地路径会在保存前解析成绝对路径。CLI 从已加载 Marketplace 的 manifest 发现真实 name，用户不需要重复填写 name。

Marketplace 发布的 Plugin 名称为：

```text
common
api
ios
aos
qa
design
```

Plugin 名称不再编码 kind。CLI 读取统一的 metadata namespace `com.company.teamai`：

```json
{
  "name": "api",
  "extensions": {
    "com.company.teamai": {
      "kind": "role"
    }
  }
}
```

`kind` 取 `common`、`role` 或 `project`。Logical Project 可从 `manifest/projects.yaml` 选择性关联一个 `project` Plugin。

## Logical Project Context 与 Learnings

`teamai init` 只配置 User Scope，不绑定 Logical Project。`teamai projects list` 读取 catalog；`teamai projects set <ids...>`（支持重复传入或逗号分隔 ID）是修改当前 Physical Git workspace 绑定的唯一命令；`sync` 只按当前 workspace 已保存的绑定重新收敛。收敛覆盖用户级 Marketplace Plugin 与 instructions，以及已绑定 Workspace 的 Logical Project context 和 manifest 选中的 Project Plugin components。

active Project instruction 文件按原始字节镜像到 `.github/instructions/teamai/<id>/`；Project docs 与 Project/shared learnings 写入 `.teamai/context/`。Team AI 只写一个 `applyTo: "**"` 的 `context.instructions.md` pointer，并通过 Git 解析后的 `info/exclude` 仅排除这两个 reserved root。即使目录为空，也不会接管未声明 ownership 的 reserved path，也不会改写 Marketplace source frontmatter。portable 或 path-specific `applyTo` 的匹配仍是后续验证事项；当前不宣称 runtime instruction injection。

## Marketplace 管理的用户级 Instructions

Marketplace 可以选择性提供任意层级的原生 Copilot instruction 文件：

```text
instructions/**/*.instructions.md
```

`teamai init` 和 `teamai sync` 会按原始字节将这些文件镜像到受 Team AI 管理的用户级目录 `~/.copilot/instructions/teamai/`，并保留相对路径。该目录属于 Team AI；个人 instructions 应放在 `~/.copilot/instructions/` 下的其他位置。文件名和目录名只用于组织内容，Team AI 不赋予 company、department、role 或 action 语义，Copilot 原生 frontmatter 也不会被改写。

这是禁止 arbitrary 或 generic resource copying/injection 的唯一窄例外：具体 use case 是部署部门批准的 Copilot 用户级 instructions。Marketplace maintainer 负责内容 ownership 与 review；Team AI 只拥有 `~/.copilot/instructions/teamai/`，并在那里镜像 frozen 的 `instructions/**/*.instructions.md` contract。CLI 只接受 regular 且单一 link count 的文件；在 filesystem check 可观察到 link-like entry 或 unsafe source/target boundary 时拒绝，使用 atomic write，并保持其他用户 instructions 不变。它不防御独立进程在操作期间替换已检查路径的竞态；该竞态不在 V1 threat model 内。

如果 Copilot CLI 和 VS Code 都不可用，`init`/`sync` 仍会 convergence 这棵文件树，但会返回明确错误说明 Plugin convergence 无法运行；命令不能伪报完整初始化或同步成功。

## 第一次初始化

首次初始化支持四种交互组合：

```text
teamai init                                             # 依次询问 Marketplace、Role
teamai init --marketplace <source>                      # 只询问 Role
teamai init --role api                                  # 只询问 Marketplace
teamai init --marketplace <source> --role api           # 不询问
```

在交互式终端中，Role picker 使用 Marketplace 暴露的 role Plugin，只选择一个 Role。在 CI、stdin 重定向或其他 non-TTY 环境中，缺少必填值时直接报错，不进入 prompt。自动化环境应显式提供：

```text
teamai init --marketplace <source> --role <role>
```

初始化会：

1. 检查 Copilot CLI；可用时优先选择 native backend；
2. 加载 Marketplace 并发现 manifest name；
3. 必要时通过 Copilot 原生操作注册 source；
4. 安装目录中所有 `kind: role` Plugin 与 `common`；
5. 只启用 `common` 和当前选择的 Role；
6. 保存 Role、Marketplace identity 和明确的 Team AI ownership；
7. 只写入 User Scope；需要绑定 Logical Project 时另行运行 `teamai projects set`。

可选 `kind: project` Plugin 只作为 Marketplace source，提供 `manifest/projects.yaml` 选中的 components。绑定 Logical Project 后，声明的 Agent 写入 `.github/agents/`、Rule 写入 `.github/instructions/teamai/<id>/`、Skill 写入 `.github/skills/`、Hook 声明及引用文件写入 `.github/hooks/`，MCP server entries 与引用的本地文件写入 `.mcp.json` 和 `.teamai/project-components/`。CLI 为文件和配置项记录精确 ownership；取消绑定时只移除这些 owned 项，并拒绝覆盖无 ownership 的同名目标。Project Plugin 不会安装或启用到用户级 Copilot state。同名用户 Plugin 会被保留；只有在相应 consumer 中实测后才能确认隔离与 runtime loading。

保存后的配置示例：

```yaml
version: 1
marketplace:
  name: payments-ai
  source: https://github.com/example-org/payments-ai-marketplace.git
role: api
managedPlugins:
  - common@payments-ai
  - api@payments-ai
  - ios@payments-ai
  - aos@payments-ai
  - qa@payments-ai
  - design@payments-ai
```

config schema 固定为 `version: 1`，唯一的 Marketplace source 字段为 `marketplace.source`。初始化后，普通命令使用已保存的 Marketplace；再次提供不同 source 时会拒绝静默切换。

## 命令

```text
teamai init [--marketplace <source>] [--role api|ios|aos|qa|design]
teamai projects [list]
teamai projects set <ids...>
teamai learning share <file> [--project <id>|--shared] [--tags <tag...>]
teamai recall <query> [--scope auto|user|workspace] [--project <id>] [--limit <n>] [--require <literal>] [--include-pending] [--json]
teamai skill list [--tag <tag>] [--owner <owner>] [--source plugin|standalone]
teamai skill show <name>
teamai skill install <name...>
teamai skill install --tag <tag> [--yes]
teamai skill remove <name...>
teamai skill contribute <path> --owner <owner> [--tags <tag...>] --target standalone|plugin [--plugin <plugin>]
teamai tags list
teamai sync
teamai role list
teamai role set <role>
teamai status
teamai doctor
```

所有写操作支持全局 `--dry-run`。首次 dry-run 会读取给定 Marketplace 并显示计划中的 Marketplace、Plugin、config 与 project 改动，不产生实际 mutation。

`learning share` 会把提供的 Markdown 正文经由 GitHub PR 加入 `learnings/<project>/<uuid>.md`。生成的 UUID 同时用作 frontmatter `id` 和已保存的 operation ID。恰有一个 active Logical Project 时默认选中它，没有 active Project 时写入 `shared`，有多个时必须给出 `--project` 或 `--shared`。贡献流程使用隔离的 bare clone 和 worktree，不会修改当前 Marketplace checkout 或 shared read cache；dry-run 只预览 branch、commit、push 与 PR 步骤。

`recall` 只在本地搜索缓存中的已发布 Learnings 和 active Project docs。当前 Git Workspace 有 active Logical Project 时，`auto` 使用 Workspace scope，否则使用 User scope；User 只搜索 shared Learnings，Workspace 搜索 shared 和 active Project 的 docs/Learnings。`--project` 可把 Workspace scope 缩到一个 active Project。`--include-pending` 只加入符合 source 与 scope 的未完成本地草稿。Learning 的 published 和 pending JSON 结果都使用 `learning:<logicalProject>:<uuid>` 作为 ID（shared Learning 的 logicalProject 为 `shared`），由 `publication` 标明状态。Recall 不访问网络或模型，也不写入状态。中文可用空格拆分关键词，例如 `teamai recall 支付 重试`；JSON 结果包含实际本地文件、source revision/hash、匹配词、原始行号和 evidence 片段。

Recall snippet 在原文连续行中选择不同 query 词覆盖最多的窗口，同分取最早位置，最多 3 行、1200 Unicode code points。过长窗口截取真实连续原文，并报告对应行号；仅派生标题命中时保留开头窗口。文件 ID、排名、source revision 和全文 hash 不变，matchedTerms 仍表示文件级匹配，即使短 snippet 没展示全部词。snippet 是检索提示，片段之外的结论仍须读取原文。

`teamai recall --help` 无需 query、绑定、知识 cache 或原生运行时即可 exit 0，帮助写入 stdout；即使带 `--json`，help 仍是人可读文本。查询按空白拆词，在 NFC 和大小写归一后做子串匹配，至少一词命中即可；shell 引号只负责传参，不开启短语匹配。未使用 required 时，query 最多 1024 Unicode code points、去重前最多 32 个空白分词；`--limit` 为 1–20，默认 5。结果按内存中的子串 BM25 分数降序排列，同分按稳定 ID 排序。title、单个 tag、body 的不重叠连续子串次数使用 3/2/1 权重，并作词频饱和与空白词数长度归一（k1=1.2，b=0.75）。语料统计来自完整已核验允许集合，在 query、required 和 limit 过滤前计算；required 仍是硬条件。排名及命中词数不代表答案正确性或语义置信度；Recall Agent 另行读取原文并按相关性筛选/重排。CLI 不翻译，也不提供语义搜索。English-first 是知识贡献约定，中文普通查询继续支持，例如 `teamai recall "Plugin discovery" --scope user` 和 `teamai recall "支付 重试" --limit 5`。

确需字面条件时，可用 `teamai recall "Plugin not" --require "Plugin not found: E_PLUGIN_42." --scope user`。`--require <literal>` 可重复指定，所有 literal 都必须满足（AND）；每个完整 literal 经 NFC 和大小写归一后，须连续出现在一个 title、单个 tag 或 body 中，不拆词、不跨字段或 tags 拼接，也不作正则扩展。query 仍必填且至少一词命中。query 与全部原始 required 值合计最多 1024 Unicode code points；query 去重前的空白词数加 required 值数量合计最多 32 项，重复 literal 逐项计数。空值、仅空白、缺值和超限均为输入错误；以 `-` 开头的 literal 使用 `--require=<literal>`。text 显示实际应用的原文值；仅在使用参数时，JSON 增加保留调用顺序和原文的顶层 `requiredLiterals`，`matchedTerms` 仍只表示 query 命中的词。required 不能扩大已核验的 source/scope/pending 集合，也不能掩盖 cache 错误；provenance、原始 hash、路径/行号和 evidence 合同不变。字面过滤不代表理解诊断关联、否定或因果。

### `teamai sync`

`sync` 表示 convergence / repair：补齐缺失的 Team AI-owned User Plugin，恢复 enablement，刷新 Marketplace 注册和 VS Code Marketplace 注册，刷新 Project machine state，并修复受管理的 personal Skill。已绑定 Workspace 只投射所选 Logical Projects 声明的兼容 components；common 和 role 内容仍由原生 User Plugins 提供。

### `teamai skill` 与 `teamai tags`

Skill read 使用已保存的 Marketplace cache。Catalog 扫描 Plugin-contained 和顶级 Skill，再从 `skills.yaml` 读取 owner/tags/standalone 治理信息。`skill install --tag` 只解析当前匹配的 name 并保存这些显式 name；tag 不是订阅。顶级 Skill 按原始字节复制到 `~/.copilot/skills/<name>/`。明确标为 standalone 的 Plugin Skill 只有在 containing Plugin 未启用时才复制到该位置。已有的 user-owned personal Skill 目录会拒绝覆盖；`skill remove` 只删除有 Team AI ownership record 的副本。

`skill contribute` 与 `learning share` 共用隔离 GitHub worktree 和 PR 流程，接收本地 Skill 目录。它要求 owner 和 target；plugin target 还要求 Marketplace 中存在该 Plugin。命令会检查 `SKILL.md`、不安全路径、名称冲突和 `skills.yaml` metadata，但不提供 Skill quality lint 命令。

### `teamai role`

```text
teamai role list
teamai role set qa
```

切换 Role 时所有 Team AI role Plugin 保持安装，只启用 `common` 与新 Role，并 disable 其他 Team AI-owned Role。用户预先安装的 Plugin 不会因为名字相似而被 claim，也不会被擅自修改。

### `teamai status` 与 `teamai doctor`

`status` 输出 Marketplace revision、选中的 Logical Projects、Project Plugin component 投影、managed personal Skills、Project context 和 Learnings projection。`doctor` 在本地已加载 cache 上复用 dry-run convergence，报告 stale context、缺失或 collision 的 owned component、无效 active Project binding 与用户级同名 Plugin override，但不修复它们。两者都不刷新远端 Marketplace cache。Hook 与 MCP 声明会以摘要显示；除非在实际 consumer 中验证，否则 runtime 保持 unknown，CLI 不会执行它们。

## Native Copilot 与 VS Code-only fallback

检测到 `copilot` 时，Team AI 使用原生 command family：

```text
copilot plugins marketplace add ...
copilot plugins marketplace list --json
copilot plugins marketplace browse <name> --json
copilot plugins install ...
copilot plugins enable ...
copilot plugins disable ...
copilot plugins update ...
```

没有 Copilot CLI 但检测到 `code` 时，Team AI 使用 VS Code-compatible fallback。Fallback 读取相同的 Marketplace/Plugin contract，把 managed Plugin materialize 到 Copilot-compatible 目录，并 merge Copilot metadata：

```text
~/.copilot/installed-plugins/<marketplace>/<plugin>
~/.copilot/config.json
~/.copilot/settings.json
```

Fallback 写入 `installedPlugins` inventory 与 `enabledPlugins` 状态；`settings.json.enabledPlugins` 是 effective enablement authority，`config.json` 中的 inventory flag 与之同步。未知字段和已有 `source_sha` 都必须保留；fallback 新建的 row 不自行计算 synthetic `source_sha`。

## Copilot 与 VS Code Marketplace 注册

User-level Copilot 注册由 `~/.copilot/settings.json` 的 `extraKnownMarketplaces` 表示。Native backend 让 Copilot 原生命令负责这项更新；fallback 只 merge 当前 Marketplace 条目，并保留未知/native 字段。

Team AI 同时在 VS Code User Settings 的 `chat.plugins.marketplaces` 中注册 source。合并使用 JSONC-safe 解析：保留 comments、trailing commas、未知 settings 和原有 entries，并将当前 source 插入或移动到数组下标 `0`。

Logical Project 投影使用 `.github/instructions/teamai/**` 和 `.teamai/context/**`；未声明 ownership 时会拒绝覆盖。manifest 选中的 Project Plugin components 写入各自原生 Workspace 位置并记录精确 ownership；`kind: project` package 不会进入用户级 installed Plugins 或 Workspace `enabledPlugins`。

## Ownership 与 Project state

`managedPlugins` 是 ownership 边界。Team AI 只能 install、enable、disable、update 或 repair 自己在 convergence 中明确安装/claim 的 Plugin。用户-owned 和第三方 Plugin 状态保持不动。

真实业务 Git Repo 就是 Project Scope。Project-specific Copilot customization 保留在 `.github/*`；Project 本身不是 Plugin 类型。Machine state 按稳定的 Git project anchor 分区：

```text
~/.teamai/
  config.yaml
  projects/
    <safe-anchor>-<hash>/
      anchor
      state.json
```

## Marketplace rename 工具

仓库中的 `scripts/rename-marketplace.mjs` 是 Marketplace maintainer utility。它只修改目标 Marketplace Repo 内的逻辑 ID，不修改通用 CLI，也不修改用户机器或业务 Repo 的 state。

```text
npm run rename:marketplace -- --from teamai --to payments-platform-ai --dry-run
npm run rename:marketplace -- --from teamai --to payments-platform-ai --display-name "Payments Platform AI"
```

详见 [`scripts/README.md`](scripts/README.md)。

## 验证与测试

```text
npm run build
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e:copilot
npm run test:e2e:fallback
npm test
```

两个 E2E 脚本都会创建隔离的临时 profile 和 Git Repo。`test:e2e:copilot` 验证投影 instruction 的原始字节，以及 native instruction list 的 name/scope/source，并验证真实 personal Skill 与已启用 Plugin Skill 的精确 native path；`test:e2e:fallback` 需要 `TEAM_AI_E2E_CODE_BIN` 或可用的 `code` 命令，并在隔离 profile 中先验证它，再验证 VS Code-only materializer 与 native 对 materialized state 的识别。资源列表不等于模型读取 ignored docs 或应用 `applyTo`；认证 model-read probe 仍未验证。当前实现状态与验证边界见 [`docs/HANDOFF.md`](docs/HANDOFF.md)。

[Recall 固定资料、测量方法与基线](docs/development/recall-quality/README.md)记录了原始 0.4.0 公开 CLI 和实际 Copilot Agent 的结果，保留回答、引用及查询方面的实际失败。支持资料进入候选不等于回答正确；后续候选比较和未运行变体单独标明。

## 当前不做

本项目不实现默认 Marketplace、多 Marketplace merge/overlay/precedence、Package Manager、另一套 Agent Runtime、通用 IDE abstraction、自定义 Plugin/Skill/Hook/MCP 格式、User instructions 与 manifest 选中 Logical Project components 之外的 arbitrary 或 generic resource copying/injection、通用 overlay engine、telemetry、dashboard，也不创建自定义业务上下文数据库。

## 项目文档

- [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md)：V3 设计与实施要求的入口。
- [`docs/HANDOFF.md`](docs/HANDOFF.md)：当前 V3 实现状态与验证边界。
- [`docs/VERSIONING.md`](docs/VERSIONING.md)：CLI、Marketplace 与 Plugin 的版本规则。

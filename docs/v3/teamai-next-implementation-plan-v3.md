# Team AI 下一阶段详细实施顺序与方案 v3

> 对应文档：`Team AI 下一阶段最终架构与设计（最新版）`  
> 更新时间：2026-09-22  
> 目标：在不推翻当前 Copilot Plugin-first 实现的前提下，分阶段加入 Logical Project、Context/Learning、Skill Catalog/Tag/Install/Contribute，明确四层 Instruction Scope，并处理大型 Marketplace 性能。

## 0. 总原则

保留当前：

```text
teamai init
teamai sync
teamai role list
teamai role set
teamai status
teamai doctor
```

以及：

- native Copilot backend；
- filesystem backend；
- Plugin ownership；
- VS Code Marketplace registration；
- Marketplace-managed instructions；
- Physical Project anchor/partition。

新增能力优先复用：

- Marketplace loader；
- config/state；
- atomic write；
- file lock；
- Git/project identity；
- dry-run。

---

# Phase 1 — Marketplace persistent cache

## 目标

当前 remote Marketplace 每次：

```text
clone --depth 1 -> temp -> delete
```

当 contexts / learnings 变多后会成为主要性能瓶颈。

## 新目录

```text
~/.teamai/marketplaces/<source-hash>/
├── checkout/
└── lock
```

## 行为

第一次：

```text
git clone --depth 1
```

后续：

```text
lock
git fetch --depth 1
git reset --hard <target>
unlock
```

local path Marketplace：

```text
直接读取，不复制
```

## State

记录：

```text
marketplaceRevision
```

revision 未变化时：

- catalog 可快速 no-op；
- context sync 可直接 no-op；
- managed skills 不重复 copy。

## Refresh Policy

shared Marketplace read cache **只有 `init` 和 `sync` 可以 refresh**：

```text
teamai init
teamai sync
```

其他依赖 Marketplace 的命令默认只读当前 cache，不触发 fetch：

```text
role list
projects list/set
skill list/show/install/remove
tags list
status
doctor
```

cache 不存在时，明确提示用户先运行 `teamai init` 或 `teamai sync`。

`skill contribute` / `learning share` 创建 PR 时可以在隔离 worktree/clone 中做必要的 Git fetch/push，但不能修改 shared read cache。

## 验证

覆盖：

- first clone；
- repeated load；
- remote update；
- ref-qualified source；
- local path；
- concurrent sync lock；
- network failure preserves previous good checkout；
- Windows/macOS paths。

暂不做 partial clone / sparse checkout。

---

# Phase 2 — Instruction scope contract + `instructions/` rename

## 目标

在新增 Logical Project Instructions 前，先把四个 Instruction/Rule scope 的 copy boundary 固定下来，并将当前：

```text
user-instructions/**/*.instructions.md
```

改为：

```text
instructions/**/*.instructions.md
```

User / Department Target 不变：

```text
~/.copilot/instructions/teamai/
```

## 四个 scope 的实现边界

```text
Plugin
  source: plugins/<plugin>/com.github.copilot/rules/**
  target: ~/.copilot/installed-plugins/<marketplace>/<plugin>/com.github.copilot/rules/**
  action: 跟整个 Plugin package 一起安装，不拆开 copy

User / Department
  source: instructions/**
  target: ~/.copilot/instructions/teamai/**
  action: Team AI mirror

Logical Project
  source: contexts/<id>/instructions/**
  target: <repo>/.github/instructions/teamai/<id>/**
  action: Team AI mirror only when project active

Physical Project
  source/target: <repo>/.github/copilot-instructions.md + .github/instructions/**
  action: Team AI 不 copy、不修改
```

## Plugin Rule regression guard

必须增加测试保证：

- filesystem backend materialize 完整 Plugin package；
- `com.github.copilot/rules/` 保持在 installed plugin 中；
- 不把 Plugin Rules 复制到 `~/.copilot/instructions/teamai/`；
- enable/disable Plugin 决定 Plugin Rule lifecycle。

## Rename 改动

更新：

- reference Marketplace；
- CLI source path；
- README / README.zh-CN；
- HANDOFF；
- tests；
- E2E fixtures。

如果没有正式外部用户，直接切换 source contract，不长期双读。

---


# Phase 2.5 — Product CLI / metadata clean break

由于当前没有正式用户，在进入 Logical Project 实现前一次性清理旧 Product 概念：

```text
teamai init --product          -> 删除
kind: product                   -> kind: project
Product-specific helper names   -> Project/Logical Project naming
productPlugins state            -> managedProjectPlugins（仅在 ownership 必要时保留）
```

同步修改：

- `src/cli.ts`；
- plugin kind type；
- catalog loader；
- project settings helper；
- machine state；
- reference Marketplace；
- unit/integration/E2E tests；
- README / README.zh-CN / HANDOFF / VERSIONING。

不保留 alias，不做旧 config migration。

如果当前 `product-teamai` 只是示例而没有真实 executable use case，优先删除；以后真实 Logical Project 需要 Plugin 时再通过 `manifest/projects.yaml -> plugin` 增加。

---

# Phase 3 — Logical Project manifest

## Marketplace

新增：

```text
manifest/projects.yaml
```

Schema：

```yaml
version: 1

projects:
  - id: payments
    name: Payments
    description: Payment domain
    owners:
      - payments-platform
    plugin: payments
```

`plugin` optional。

## CLI

新增 Logical Project loader：

- unique ID；
- safe ID；
- owners 至少一个；
- optional plugin 必须存在；
- optional plugin 必须为 `kind: project`。

不加入 arbitrary resource namespace mapping。

---

# Phase 4 — `teamai projects`

新增：

```text
teamai projects
teamai projects list
teamai projects set <ids...>
```

`teamai projects` 默认 `list`。

## `projects list`

显示：

- Marketplace projects；
- current repo active projects；
- owner；
- optional plugin。

## `projects set`

规则：

1. 必须位于 Git repo；
2. IDs 必须来自 Marketplace manifest；
3. 写 current project machine state：

```json
{
  "logicalProjects": ["payments", "risk"]
}
```

4. 支持 `--dry-run`；
5. set 后直接 converge 当前 project context，避免再手工 `sync`。

## `init --project`（已移除）

> 后续修订：`init --project` 已移除。`init` 只负责 User Scope；`teamai projects set <ids...>` 是唯一 Logical Project binding 入口；`init --project` 会直接报错。

现有：

```text
teamai init --product <name>
```

直接删除并替换为：

```text
teamai init --project <id>
```

`--project` 表示 Logical Project ID；多个 ID 可重复或逗号分隔。CLI 从 `manifest/projects.yaml` 自动解析其 optional Plugin。

由于当前没有正式用户：

- 不保留 `--product` alias；
- 不实现兼容 migration；
- tests/docs/README/HANDOFF 全部删除 Product CLI 术语。

## State schema

在当前 project state 增加：

```json
"logicalProjects": []
```

如果 machine-state schemaVersion 升版，仅迁移 machine state，不影响 `~/.teamai/config.yaml version: 1`。

---

# Phase 5 — Optional Logical Project Plugin

`manifest/projects.yaml`：

```yaml
plugin: payments
```

当：

```text
teamai projects set payments
```

时：

- validate plugin；
- validate `kind: project`；
- 在 `.github/copilot/settings.json` enable；
- project 被移除时只撤销 Team AI-owned mapping；
- unrelated plugins 保留。

多个 Logical Projects：

```text
union(optional plugins)
```

同时清理现有 Product implementation：

```text
--product                 -> 删除
kind: product             -> kind: project
productPluginName(...)    -> project/manifest-driven resolution
productPlugins state      -> managedProjectPlugins（如仍需 ownership 记录）
product-teamai demo       -> 删除或改造成真实 Logical Project Plugin；没有真实 use case 时优先删除
```

新的唯一业务上下文入口是：

```text
--project
teamai projects ...
```

不再新增任何 Product command / metadata。

---

# Phase 6 — Logical Project Instructions

## Source

```text
contexts/<project-id>/instructions/**/*.instructions.md
```

## Target

```text
<physical-repo>/.github/instructions/teamai/<project-id>/**
```

## Ownership

仅：

```text
.github/instructions/teamai/**
```

该路径为 Team AI reserved projection path。首次发现该目录已存在但不在当前 Team AI machine state ownership 中时：

```text
refuse overwrite
doctor -> collision warning/error
```

不做 silent adoption。

## Git cleanliness

使用：

```text
.git/info/exclude
```

隐藏 Team AI machine projection，不修改 committed `.gitignore`。

## Sync

根据 active logical projects：

```text
create/update/remove
```

切换 project 时删除不再 active 的 Team AI-generated instructions。

要求：

- preserve frontmatter byte-for-byte；
- path boundary checks；
- atomic writes；
- unrelated instructions untouched；
- Team AI 不根据 source folder 自动改写 `applyTo`；
- 目录位置只表达 ownership / organization，不作为 matching scope。

## `applyTo` contract

`applyTo` 始终相对于当前 Physical Project / workspace root。

推荐：

```yaml
---
applyTo: "**"
---
```

用于整个 Logical Project Context 都对当前 repo 成立的规则。

portable 文件类型也可以：

```yaml
---
applyTo: "**/*.java"
---
```

如果 source instruction 强依赖某个 repo 的具体目录，例如：

```yaml
---
applyTo: "services/payment/**"
---
```

应在文档和 contribution guidance 中提示维护者优先把它下沉到该 Physical Project 自己的 `.github/instructions/`。

Team AI 不自动重写这种规则，只负责 projection。

---

# Phase 7 — Logical Project Docs bridge

## Source

```text
contexts/<project-id>/docs/**
```

## Target

```text
<physical-repo>/.teamai/context/<project-id>/docs/**
```

`.teamai/` 加入 `.git/info/exclude`。

`.teamai/context/**` 为 Team AI reserved projection path；已有未声明 ownership 的内容时拒绝覆盖。

需要真实 E2E 验证 Copilot / VS Code 是否能稳定读取被 `.git/info/exclude` 隐藏的 context 文件；如果 native discovery/search 对 ignored files 有限制，再调整 storage strategy。

## Pointer instruction

维护：

```text
.github/instructions/teamai/context.instructions.md
```

只包含：

- active logical projects；
- context paths；
- progressive disclosure guidance。

不 inline docs。

---

# Phase 8 — Learnings source + projection

## Source

```text
learnings/
├── shared/
└── <logical-project>/
```

## Target

```text
<physical-repo>/.teamai/context/shared/learnings/
<physical-repo>/.teamai/context/<project>/learnings/
```

每个 Physical Project 同步：

```text
shared
+
all active logical projects
```

`context.instructions.md` 明确：

```text
Learnings are historical team experience, not mandatory policy.
```

V1 不做 search / votes / confidence / ranking。

---

# Phase 9 — `teamai learning share`

新增：

```text
teamai learning share <file>
```

选项：

```text
--project <id>
--shared
--tags <tag...>
```

## Routing

- exactly one active project → default；
- zero active → shared；
- multiple active → require explicit target。

## Contribution

流程：

```text
read local file
-> minimal frontmatter
-> Marketplace isolated worktree
-> branch
-> commit
-> PR
```

不直接 push main。

如果本地化 CLI 当前没有通用 Git provider abstraction，只先支持当前 GitHub 环境，不因此引入大而全 provider framework。

## 最小 frontmatter

```yaml
title:
owner:
logicalProject:
sourceRepo:
createdAt:
tags:
```

不引入 confidence/vote/status machine。

---

# Phase 10 — Unified Skill Catalog discovery

扫描：

```text
plugins/*/skills/*/SKILL.md
skills/*/SKILL.md
```

构造统一 catalog：

```text
name
description
sourceType
plugin?
sourcePath
owner
tags
```

V1 Skill name 全 Marketplace 唯一。

duplicate → catalog load error。

不新增 `skill validate` 命令。

---

# Phase 11 — `skills.yaml`

新增：

```text
skills.yaml
```

示例：

```yaml
version: 1

skills:
  java-review:
    owner: api-team
    tags: [java, review]
    standalone: true

  api-deploy:
    owner: api-team
    tags: [deploy]
    standalone: false

  release-helper:
    owner: alice
    tags: [release, experimental]
```

规则：

- every Team-managed skill 必须有 owner；
- tags arbitrary；
- plugin/source 不手写；
- 顶级 standalone skill 默认 `standalone: true`；
- Plugin-contained Skill 默认 `standalone: false`；
- Plugin-contained Skill 只有显式 `standalone: true` 才允许脱离 Plugin 单独安装；
- description 从 SKILL.md；
- source/path 由 scan 推导；
- metadata 指向 missing skill → catalog error；
- discovered skill 缺 metadata → catalog error。

---

# Phase 12 — Skill read commands

新增：

```text
teamai skill list
teamai skill show <name>
teamai tags list
```

## `skill list`

支持：

```text
--tag
--owner
--source plugin|standalone
```

显示：

```text
NAME   SOURCE       OWNER   TAGS   STATUS
```

SOURCE：

```text
plugin:api
standalone
```

## `skill show`

显示：

- description；
- owner；
- tags；
- source；
- containing plugin；
- source path；
- local availability；
- Team AI-managed personal install path。

## `tags list`

显示：

```text
tag -> skill count
```

Tag 不建立独立 registry。

---

# Phase 13 — Managed personal skills

## Config

扩展：

```yaml
managedSkills:
  - release-helper
  - test-plan
```

必要时记录 source revision/hash，但不把完整 catalog copy 到 config。

## Target

使用 Copilot/VS Code native personal skill 位置：

```text
~/.copilot/skills/<name>/
```

## Ownership

安装前：

- target absent → install；
- target exists and Team AI owns → update；
- target exists but user-owned → refuse。

不要 silent claim。

## Sync

对 `managedSkills`：

```text
resolve source
-> copy/update
-> remove no-longer-managed Team AI-owned copies
```

---

# Phase 14 — `teamai skill install/remove`

新增：

```text
teamai skill install <name...>
teamai skill install --tag <tag>
teamai skill remove <name...>
```

## Standalone source

直接 mirror：

```text
skills/<name>/
-> ~/.copilot/skills/<name>/
```

并加入 `managedSkills`。

## Plugin-contained source

如果 containing Plugin 当前 enabled：

```text
already available via plugin
```

默认不复制。

如果 Plugin disabled，先检查 `skills.yaml`：

```text
standalone: true
-> plugins/<plugin>/skills/<name>
-> ~/.copilot/skills/<name>/

standalone: false / omitted
-> refuse standalone install
-> instruct user to enable/install containing Plugin
```

这样只允许真正自包含的 Plugin Skill 跨 Role/Plugin 单独安装，避免缺失同 Plugin MCP / Agent / Hook 依赖。

## `install --tag`

Tag 只作为本次 selector：

```text
tag
-> current matching skill IDs
-> explicit managedSkills
```

不保存 `subscribedTags`。

## remove

只删除 Team AI-owned personal projection。

如果同名 Skill 同时由 enabled Plugin 提供，Plugin copy 继续可用。

---

# Phase 15 — `teamai skill contribute`

新增：

```text
teamai skill contribute <path>
```

确定：

- owner；
- tags；
- target = standalone or plugin；
- target plugin（若适用）。

流程：

```text
local skill
-> minimal structural checks
-> Marketplace worktree
-> copy
-> update skills.yaml
-> branch
-> PR
```

“不做 skill validate”表示没有独立质量验证命令。

Contribution 仍做最小 correctness 检查：

- `SKILL.md` 存在；
- name collision；
- unsafe path；
- target plugin exists。

---

# Phase 16 — `sync / status / doctor`

## `sync`

新增 convergence：

- Marketplace cache refresh（仅 `sync`；其他 command 不隐式 refresh shared cache）；
- global `instructions/`；
- Logical Project optional plugins；
- project instructions；
- project docs；
- shared/project learnings；
- managed personal skills。

## `status`

新增 compact sections：

```text
Logical projects
Managed personal skills
Project context
Learnings projection
Marketplace revision
```

## `doctor`

只检查 state consistency：

- active project exists；
- optional project plugin exists；
- skill metadata/source consistent；
- managed skill collision/missing；
- context projection stale/missing；
- cache health。

不升级成 Skill quality lint。

---

# Phase 17 — Learning promotion（后续）

在 Learning share + static context 稳定后再做：

```text
teamai learning promote <learning>
  --to skill
  --to instruction
  --to doc
```

原则：

- human-triggered；
- Marketplace PR；
- skill → 更新 `skills.yaml`；
- instruction → global 或 logical-project instructions；
- doc → logical-project docs。

LLM Wiki 可用后，promotion candidate source 可改为 Wiki。

当前不实现 confidence / vote 自动门槛。

---

# Phase 18 — Team LLM Wiki integration（未来）

Team AI 继续负责：

```text
logical project identity
source metadata
Marketplace content
Skill/MCP connector
```

LLM Wiki 负责：

```text
ingest
index
BM25/vector/hybrid
retrieval
ranking
knowledge lifecycle
```

未来可以逐步减少 workspace 中大量 Docs/Learnings copy，但保留：

- Logical Project mapping；
- Instructions；
- Skill management；
- Marketplace governance。

---

## 推荐优先级

### P0

1. Marketplace persistent cache + `init/sync`-only refresh policy
2. `user-instructions` → `instructions`
3. 删除 Product CLI / metadata，统一为 Logical Project / `kind: project`

### P1

4. Logical Project manifest
5. `teamai projects list/set`
6. Logical Project optional Plugin linkage
7. Logical Project Instructions
8. Logical Project Docs
9. Learnings shared/project projection
10. `learning share`

### P1.5

10. Unified Skill Catalog
11. `skills.yaml`
12. `skill list`
13. `skill show`
14. `tags list`

### P2

15. managed personal skills
16. `skill install`
17. `skill install --tag`
18. `skill remove`
19. `skill contribute`

### P3

20. Learning promotion
21. Team LLM Wiki integration

---

## 每阶段验收基线

至少：

```text
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
```

涉及真实 Copilot filesystem behavior：

- Windows real E2E；
- Plugin Rule 仍由 installed Plugin package 原生提供；
- Plugin Rule 不被复制进 user instruction tree；
- User / Department instruction discovery；
- Logical Project instruction discovery；
- Physical Project native instructions 原地保持不变；
- `applyTo: "**"` 与 portable glob 的真实行为 smoke test；
- VS Code personal skill discovery；
- Copilot personal skill discovery；
- no unrelated user / repo state modified。

涉及 Marketplace contribution：

- isolated worktree；
- no active business worktree mutation；
- PR creation smoke test；
- no direct push to user business repo。

---

## 完成 P0-P2 后的能力边界

```text
Team AI Marketplace
├── Agent Plugin packages
├── standalone team skills
├── unified skill governance metadata
├── global instructions
├── logical project definitions
├── logical project context
└── learnings

Team AI CLI
├── Marketplace bootstrap/convergence
├── role selection
├── logical project binding
├── context projection
├── learning share
├── skill catalog
├── skill/tag selection
├── managed personal skill installation
└── contribution/governance workflow

Copilot
├── Plugin runtime
├── native skills
├── native instructions
├── agents
├── MCP
└── hooks

Future Team LLM Wiki
└── team knowledge ingestion/search/retrieval
```

这一顺序优先解决“业务上下文”和“团队 Skill 管理”，同时避免在 LLM Wiki 尚未可用时重新造一套知识检索引擎。

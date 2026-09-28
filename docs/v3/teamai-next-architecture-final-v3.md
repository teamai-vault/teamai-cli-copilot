# Team AI 下一阶段最终架构与设计 v3

> 状态：Latest frozen direction  
> 更新时间：2026-09-22  
> 范围：仅定义下一阶段新增的 Team AI Marketplace / CLI 能力、目录模型与 Instruction Scope。  
> 基线：保留当前 Copilot Agent Plugin-first、Marketplace-first 实现，不推翻现有 `init / sync / role / status / doctor`。

## 1. 目标与非目标

下一阶段解决四个问题：

1. **删除 Product 一等概念，只保留 Logical Project**，并将现有 Product CLI/metadata 清理为 Project 语义。
2. 增强团队 Skill 管理。
3. 在 Team LLM Wiki 可用前补齐轻量 Team Context：Instructions、Docs、Learnings。
4. 控制 Marketplace 变大后的 `init / sync` 性能。

明确不做：

- `skill validate` 命令；
- 自研 Recall / BM25 / Vector / Graph 搜索引擎；
- 原版 TeamAI 式通用跨 Agent MCP / Hook / Rule 转换器；
- Member registry；
- 通用 package manager；
- Tag 的持续自动订阅语义；
- 强制 `1 Logical Project = 1 Plugin`。

---

## 2. 核心概念

### 2.1 Physical Project

**Physical Project = 真实 Git repository / workspace。**

例如：

```text
payment-service
payment-sdk
settlement-worker
```

职责：

- repo-native `.github/*`；
- `workspaceRoot / projectAnchor`；
- `~/.teamai/projects/<anchor>/state.json`；
- 与一个或多个 Logical Project 建立本地绑定。

关系允许多对多：

```text
payment-service -> payments + risk
payment-sdk     -> payments
```

### 2.2 Logical Project

下一阶段只保留一个一等业务上下文实体：**Logical Project**。

不再同时维护独立的 `Product` 与 `Logical Project` 数据模型，也不保留 Product 作为兼容 CLI 概念。

如果公司内部叫 Product、Domain、Platform、System，只是显示名称不同；底层语义统一：

```text
Logical Project
= 跨一个或多个 Git Repo 的业务 / 产品 / 领域上下文
```

由于当前没有正式用户，本次直接做 clean break：

```text
--product        -> 删除
kind: product    -> kind: project
productPlugins   -> managedProjectPlugins（如仍需 machine ownership 记录）
```

不保留长期 alias / migration。

例如：

```text
payments
risk
identity
mobile
```

因此概念收敛为：

```text
Physical Project = Git Repo
Logical Project  = Business Context
```

### 2.3 Logical Project 与 Plugin

Logical Project **不等于 Plugin**。

一个 Logical Project 可以只有：

```text
instructions
docs
learnings
```

只有确实需要可执行 Agent capability 时，才关联一个可选 Plugin：

```text
payments
  optional plugin -> payments@marketplace
```

Plugin 可提供：

- domain-specific Skills；
- custom Agents；
- MCP；
- Hooks；
- Copilot-specific rules。

所以即使未来有 50 个 Logical Projects，也不意味着 Marketplace 必须有 50 个 Project Plugins。

如果某个 Logical Project 需要 executable Agent capability，其可选 Plugin 使用 Team AI metadata：

```json
{
  "extensions": {
    "com.company.teamai": {
      "kind": "project"
    }
  }
}
```

因此 Team AI Plugin kind 最终为：

```text
common
role
project
```

不再存在 `kind: product`。

---

## 3. Logical Project Manifest

定义：

```text
manifest/projects.yaml
```

示例：

```yaml
version: 1

projects:
  - id: payments
    name: Payments
    description: Payment platform and settlement domain
    owners:
      - payments-platform
    plugin: payments   # optional

  - id: risk
    name: Risk
    description: Risk platform domain
    owners:
      - risk-platform
```

字段：

- `id`：稳定机器 ID；
- `name`：显示名称；
- `description`：说明；
- `owners`：至少一个维护者/团队；
- `plugin`：可选，对应 executable Agent Plugin。

V1 不加入 resource namespaces、inheritance、precedence、nested projects 或 permissions。

---

## 4. `teamai projects`

沿用原版 TeamAI Logical Project 的核心交互，但保持精简：

```text
teamai projects
teamai projects list
teamai projects set <ids...>
```

`teamai projects` 默认等于 `list`。

`projects list` 显示：

- Marketplace 定义的 Logical Projects；
- 当前 Physical Project active Projects；
- owners；
- optional Plugin。

`projects set`：

```text
teamai projects set payments
teamai projects set payments risk
teamai projects set
```

底层直接保存数组：

```json
{
  "logicalProjects": ["payments", "risk"]
}
```

> 后续修订：`init --project` 已移除。`init` 只负责 User Scope；`teamai projects set <ids...>` 是唯一 Logical Project binding 入口；`init --project` 会直接报错。

~~首次 `init` 同时支持直接绑定 Logical Project：~~（原设计，已废弃）

```text
teamai init --marketplace <source> --role api --project payments
```

多个 Project 可采用重复参数或逗号分隔，最终统一解析成 `logicalProjects[]`。`--project` 接收 **Logical Project ID**，不接收 Plugin 名；如果该 Logical Project 声明 optional Plugin，CLI 由 manifest 自动解析。

现有 `--product` 从 CLI 删除，不保留 alias。

不做 `projects members`，因为本地化版不维护 member registry。权限继续依赖 Git repository permissions、CODEOWNERS、branch protection 与 PR review。

---

## 5. Marketplace 目标目录结构

```text
teamai-marketplace/
├── .github/
│   └── plugin/
│       └── marketplace.json
│
├── plugins/
│   ├── common/
│   ├── api/
│   ├── ios/
│   ├── aos/
│   ├── qa/
│   ├── design/
│   └── <optional-logical-project-plugin>/
│
├── skills/
│   ├── release-helper/
│   ├── db-diagnose/
│   └── ...
│
├── skills.yaml
│
├── instructions/
│   ├── git/
│   │   └── commit.instructions.md
│   ├── release/
│   │   └── versioning.instructions.md
│   └── ...
│
├── manifest/
│   └── projects.yaml
│
├── contexts/
│   ├── payments/
│   │   ├── instructions/
│   │   │   ├── development.instructions.md
│   │   │   └── release.instructions.md
│   │   └── docs/
│   │       ├── architecture.md
│   │       └── terminology.md
│   └── risk/
│       ├── instructions/
│       └── docs/
│
└── learnings/
    ├── shared/
    ├── payments/
    └── risk/
```

---

## 6. Instruction / Rule 的 Scope 模型

Team AI 不再把 `Rule` 设计成一种自己的资源格式。

更准确的模型是：

> **Rule 是 instruction 的语义；真正决定存放位置的是 activation scope 与 lifecycle。**

四种 scope 的 source、最终机器落点与 copy boundary 固定如下：

| Scope | Marketplace / Source | 最终真实机器位置 | Team AI 是否拆开 copy | Activation condition |
|---|---|---|---|---|
| **Plugin** | `plugins/<plugin>/com.github.copilot/rules/` | `~/.copilot/installed-plugins/<marketplace>/<plugin>/com.github.copilot/rules/` | **否，整包安装** | Plugin enabled |
| **User / Department** | `instructions/` | `~/.copilot/instructions/teamai/` | **是** | 用户配置该 Marketplace |
| **Logical Project** | `contexts/<id>/instructions/` | `<repo>/.github/instructions/teamai/<id>/` | **是** | 当前 Physical Project 绑定该 Logical Project |
| **Physical Project** | Repo 自己的 `.github/copilot-instructions.md` / `.github/instructions/**` | 原地 | **否** | Repo 自身 |

核心原则：

```text
Team AI 决定 instruction 被投影到哪个 scope；
applyTo 决定它在当前 workspace 内匹配哪些文件。
```

目录层级本身只负责 ownership / organization，不决定文件匹配范围。

### 6.1 Plugin Rules

Plugin 内的：

```text
plugins/api/com.github.copilot/rules/api-review.instructions.md
```

在 filesystem backend 安装后仍留在完整 Plugin package 中：

```text
~/.copilot/installed-plugins/<marketplace>/api/
└── com.github.copilot/
    └── rules/
        └── api-review.instructions.md
```

Team AI **不能再把 Plugin Rule 拆出来复制到**：

```text
~/.copilot/instructions/
```

Plugin Rule 是 **plugin-lifecycle scoped**，并不因为 Plugin 安装在用户 Home 下就变成 user-global instruction。

`rules/` 是 Plugin component directory；承载内容仍是 instruction-style Markdown，例如 `*.instructions.md`。不引入 `rules.md` 约定。

### 6.2 `instructions/` 取代 `user-instructions/`

当前 source convention：

```text
user-instructions/**/*.instructions.md
```

下一阶段改为：

```text
instructions/**/*.instructions.md
```

Target 不变：

```text
~/.copilot/instructions/teamai/**
```

语义：

```text
Marketplace/instructions/
= 对所有使用该 Department Marketplace 的用户生效的 Team-level user instructions
```

例如 Git/Commit、PR、Versioning、安全规范、部门通用工程约束。

Team AI 不增加 action / level / priority 等自有 instruction schema。

---

## 7. Logical Project Instructions

Source：

```text
contexts/<project-id>/instructions/**/*.instructions.md
```

当前 Physical Project active：

```text
payments + risk
```

则投影到：

```text
<physical-repo>/.github/instructions/teamai/payments/**
<physical-repo>/.github/instructions/teamai/risk/**
```

Team AI 只拥有：

```text
.github/instructions/teamai/**
```

该路径是 **Team AI reserved projection path**。如果首次使用时该目录已经存在，但当前 Team AI machine state 并未声明 ownership，CLI 必须拒绝 silent overwrite，并由 `doctor` 报告 collision。

不修改其他 `.github/instructions`。

这些默认作为 machine-local projection，可写入 `.git/info/exclude`，不要求修改仓库 `.gitignore`。

Physical Project 自己正式提交的：

```text
.github/copilot-instructions.md
.github/instructions/**
```

继续原地由 repo 自身维护，Team AI 不 copy、不重写。

### 7.1 `applyTo` 的含义

`applyTo` 是相对于 **当前 workspace root** 的 native Copilot glob。

例如文件位于：

```text
.github/instructions/teamai/payments/payment.instructions.md
```

并不意味着它自动只作用于 `payments/**`。

如果规则对当前 Physical Repo 全部文件都成立：

```yaml
---
applyTo: "**"
---
```

如果规则跨多个 Repo 都可以按文件类型复用：

```yaml
---
applyTo: "**/*.java"
---
```

如果必须依赖某个 Physical Repo 的具体路径：

```yaml
---
applyTo: "services/payment/**"
---
```

这类规则优先下沉到该 Physical Project 自己的 `.github/instructions/`，而不是放在 Logical Project Context 中。

判断规则：

```text
跨 Repo 都成立
-> Logical Project Instruction

依赖具体 Repo 目录结构
-> Physical Project Instruction
```

希望自动生效的 Team AI-managed `.instructions.md` 应显式声明 `applyTo`；不要依赖文件所在目录形成隐式 scope。

---

## 8. `com.github.copilot/` 的边界

`com.github.copilot/` 是 **Agent Plugin package 内部**的 Copilot-specific component namespace。

标准结构类似：

```text
plugin/
├── plugin.json
├── skills/
├── mcp.json
└── com.github.copilot/
    ├── agents/
    ├── commands/
    ├── rules/
    ├── hooks/
    └── lsp.json
```

因此正确位置是：

```text
plugins/<plugin>/com.github.copilot/
```

用于 Plugin-scoped：

- agents；
- commands；
- rules；
- hooks；
- LSP 等 Copilot-specific components。

而 Marketplace 顶级：

```text
instructions/
contexts/
learnings/
skills/
```

属于 Team AI Marketplace 的 content/control-plane convention，不是一个 Agent Plugin package，**不应放到 Marketplace 根级 `com.github.copilot/`**。

---

## 9. Docs 与 Learnings

### Docs

正式、整理过的业务上下文：

```text
contexts/<project-id>/docs/**
```

投影：

```text
<physical-repo>/.teamai/context/<project-id>/docs/**
```

`.teamai/context/**` 同样是 Team AI reserved machine projection path；已有未被 Team AI state 管理的内容时不得 silent overwrite。

### Learnings

Learning 是尚未完全固化的经验，作为顶级一等资源：

```text
learnings/shared/**
learnings/<project-id>/**
```

投影：

```text
<physical-repo>/.teamai/context/shared/learnings/**
<physical-repo>/.teamai/context/<project-id>/learnings/**
```

Team AI 可生成极薄的：

```text
.github/instructions/teamai/context.instructions.md
```

只告诉 Agent：

- 当前 active Logical Projects；
- Docs / Learnings 在哪里；
- 按任务渐进读取；
- Learnings 是历史经验，不是强制 policy。

不把全部 Docs / Learnings inline 到 prompt。

---

## 10. Learning 模型

```text
Learning    = provisional / experiential knowledge
Doc         = curated / canonical context
Instruction = durable behavioral rule
Skill       = reusable executable workflow
```

Learning 可记录 source repo，但 Repo 是 provenance，不是 visibility scope。

示例：

```yaml
---
title: Payment token retry pitfall
owner: alice
logicalProject: payments
sourceRepo: payment-service
createdAt: 2026-09-20
tags:
  - payment
  - retry
---
```

V1 不建立 confidence/vote/search engine。

---

## 11. `learning share`

新增：

```text
teamai learning share <file>
```

可选：

```text
--project <id>
--shared
--tags <...>
```

默认路由：

- exactly one active Logical Project → 该 project；
- zero active → `shared`；
- multiple active → 必须显式 `--project` 或 `--shared`。

Contribution：

```text
local learning
  -> isolated worktree
  -> branch
  -> PR
  -> CODEOWNERS / review
```

不直接 push main。

未来 Team LLM Wiki 可将 Marketplace learnings 作为 ingest source；CLI 不实现 Recall engine。

---

## 12. Skill：物理不拍平，逻辑拍平

Skill 有两种物理来源：

### Plugin-contained Skill

```text
plugins/api/skills/java-review/
```

### Standalone Team Skill

```text
skills/release-helper/
```

不把 Plugin 内 Skill 再复制一份到顶级 `skills/`，避免两份内容漂移。

CLI 构造统一扁平 Skill Catalog。

---

## 13. `skills.yaml`

顶级：

```text
skills.yaml
```

维护所有 Team Skill 的 Team AI metadata：

```yaml
version: 1

skills:
  java-review:
    owner: api-team
    tags:
      - java
      - review
    standalone: true

  api-deploy:
    owner: api-team
    tags:
      - deploy
    standalone: false

  release-helper:
    owner: alice
    tags:
      - release
      - experimental

  db-debug:
    owner: bob
    tags:
      - database
      - troubleshooting
```

`plugin` / source path 不手工维护。

CLI 自动扫描：

```text
plugins/*/skills/*/SKILL.md
skills/*/SKILL.md
```

并计算：

```text
source = plugin:api
source = standalone
```

Skill name V1 要求 Marketplace 全局唯一。重复名称直接作为 catalog error。

`standalone` 表示该 Skill 是否可以脱离 containing Plugin 单独投影：

- 顶级 `skills/<name>`：天然 standalone，默认 `true`；
- Plugin-contained Skill：默认 `false`；
- 只有 metadata 明确 `standalone: true` 的 Plugin Skill 才允许单独安装。

这样避免把依赖同 Plugin MCP / Agent / Hook 的 Skill 拆成残缺 personal Skill。

---

## 14. Tag 与 Owner

Tag 是 Skill 的普通属性，可以是任意非空名称：

```text
experimental
java
database
release
alice
my-favorites
```

每个 Team-managed Skill 必须独立有 `owner`。

即使 tag 使用人名，也不替代 owner：

```yaml
owner: alice
tags:
  - experimental
  - alice
```

`owner` 表示维护责任；`tags` 表示任意发现/选择维度。

---

## 15. Skill Commands

不做：

```text
teamai skill validate
```

做：

```text
teamai skill list
teamai skill show <name>
teamai skill install <name...>
teamai skill install --tag <tag>
teamai skill remove <name...>
teamai skill contribute <path>
teamai tags list
```

`skill list` 支持：

```text
--tag
--owner
--source plugin|standalone
```

`skill show` 显示：

- description；
- owner；
- tags；
- source；
- containing plugin（computed）；
- source path；
- local managed status。

---

## 16. Tag 安装：支持，但不是 live subscription

例如：

```text
teamai skill install --tag experimental
```

执行时：

1. 解析当前 matching skills；
2. 展示/确认；
3. 将最终选择写成显式 skill IDs；
4. 后续 `sync` 维护这些显式 skill IDs。

不保存 `subscribedTags`。

未来新 Skill 被打上 `experimental` 不会自动安装。

这保留 tag 选择自由度，同时避免隐式 desired-state 漂移。

---

## 17. Plugin 内 Skill 的单独安装

Copilot / VS Code 原生支持 personal skills：

```text
~/.copilot/skills/<skill>/SKILL.md
```

只有 `skills.yaml` 明确标记 `standalone: true` 的 Plugin-contained Skill，才允许脱离 Plugin 单独安装。

例如：

```text
plugins/qa/skills/test-plan
  -> teamai skill install test-plan
  -> ~/.copilot/skills/test-plan/
```

### 规则

- 如果 containing Plugin 当前 enabled：Skill 已原生可用，默认不额外复制；
- 如果 Plugin disabled：Team AI 可将该 Skill 投影为 managed personal skill；
- Team AI 记录 `managedSkills`；
- 同名 user-owned personal skill 存在时拒绝覆盖；
- `sync` 更新 Team AI-owned personal copy；
- remove 只删除 Team AI-owned copy。

这允许跨 Role/Plugin 选某个 Skill，而不破坏 Plugin package 本体。

---

## 18. Standalone Team Skill

真实内容：

```text
skills/<name>/
```

安装到：

```text
~/.copilot/skills/<name>/
```

适合：

- experimental；
- 某个人/小组维护；
- 不属于任何 Role Plugin；
- 不需要 Agent/MCP/Hook package semantics；
- 希望用户自由选择。

如果一组能力与 Agent/MCP/Hook 强耦合，应升级为 Plugin。

---

## 19. Team 管理与治理

不复制原版：

```text
members/<user>.yaml
teamai members
```

当前 Team governance 使用 Git-native：

- repository permissions；
- CODEOWNERS；
- branch protection；
- PR review。

Team AI 增加：

- Logical Project `owners`；
- Skill `owner`；
- Skill contribution PR；
- Learning share PR。

只有出现“Git 权限 ≠ Team AI 权限”的真实需求时，再考虑 Member Registry。

---

## 20. 大型 Marketplace 性能

当前本地化实现对 remote Marketplace 每次会：

```text
git clone --depth 1 <source> <temp-dir>
```

command 结束后删除。

随着：

```text
Logical Projects
Docs
Learnings
Skills
```

增加，这会直接拖慢 init/sync 等命令。

因此在扩大内容前，应先改成 persistent cache。

---

## 21. Marketplace Persistent Cache

建议：

```text
~/.teamai/marketplaces/<source-hash>/
└── checkout/
```

第一次：

```text
shallow clone
```

之后：

```text
git fetch --depth 1
git reset --hard <target>
```

使用 lock。

记录：

```text
marketplaceRevision
```

revision 不变时可快速 no-op。

V1 只做 persistent shallow cache。

## Refresh Policy

只有：

```text
teamai init
teamai sync
```

允许刷新 Marketplace **shared read cache**（fetch/reset）。

其他命令默认只消费当前 cache，不隐式联网刷新，例如：

```text
teamai role list
teamai projects list
teamai projects set
teamai skill list
teamai skill show
teamai skill install
teamai tags list
teamai status
teamai doctor
```

如果 cache 尚不存在，这些依赖 Marketplace 的命令应明确提示先执行：

```text
teamai init
```

或：

```text
teamai sync
```

Contribution 命令为了创建 branch / PR 可以执行其自身隔离的 Git fetch/push，但不得借此隐式刷新 shared Marketplace read cache。

真正变得很大以后再考虑：

```text
partial clone --filter=blob:none
+
sparse checkout
```

不提前实现。

---

## 22. Team LLM Wiki 未来边界

当前：

```text
contexts/<id>/docs
learnings/*
```

提供轻量 static progressive-disclosure context。

未来 LLM Wiki 可用后：

```text
Docs + Learnings
  -> LLM Wiki ingestion
  -> Skill/MCP retrieval
```

届时：

- `instructions/` 继续由 Team AI sync；
- Logical Project binding 继续存在；
- Docs/Learnings 可以逐步从 workspace copy 迁移为 retrieval backend；
- Team AI CLI 不实现 BM25/vector/hybrid/graph engine。

---

## 23. 最终冻结原则

1. 只保留一个业务上下文实体：Logical Project。
2. Physical Project 永远表示真实 Git Repo。
3. Physical Project 与 Logical Project 多对多。
4. Logical Project 不等于 Plugin；Plugin 是可选 executable capability；不存在独立 Product entity。
5. Instruction / Rule 的四个 activation scope 明确分开：Plugin、User/Department、Logical Project、Physical Project。
6. Plugin Rule 保留在完整 Agent Plugin package 的 `com.github.copilot/rules/` 中，不拆成 user instruction。
7. User / Department Instructions 投影到 `~/.copilot/instructions/teamai/`。
8. Logical Project Instructions 投影到 `<repo>/.github/instructions/teamai/<id>/`。
9. Physical Project 自己的 `.github/copilot-instructions.md` / `.github/instructions/**` 原地保持 repo-owned。
10. `applyTo` 决定 workspace 内的文件匹配；目录层级只表达 ownership / organization。
11. Logical Project Instruction 优先使用 `**` 或 portable glob；强依赖 repo 路径的规则下沉到 Physical Project。
12. Plugin 内 Skill 与 Standalone Skill 物理不拍平，逻辑 catalog 拍平。
13. `skills.yaml` 维护 owner/tags；source/plugin 由 CLI 自动推导。
14. Tag 可任意命名，但 owner 独立且必须存在。
15. Tag 可用于当前批次 Skill 选择，不做 live subscription。
16. 允许单独安装 Plugin 内 Skill，通过 native personal skill projection。
17. `user-instructions/` 改为 `instructions/`。
18. `com.github.copilot/` 只用于 Agent Plugin package 内 Copilot-specific components。
19. Learnings 是顶级 provisional resource，按 shared / Logical Project 分区。
20. Knowledge search 继续等待 Team LLM Wiki；Team AI 不实现 Recall engine。
21. 扩展 Context/Learning 前先解决 Marketplace persistent cache。

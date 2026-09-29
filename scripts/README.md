# CLI Maintainer Scripts

[中文](#中文) | [English](#english)

## 中文

`rename-marketplace.mjs` 是 Marketplace maintainer utility，用于修改某个部门自己的 GitHub Copilot Marketplace 逻辑 ID，例如：

```text
teamai -> payments-platform-ai
```

它只修改目标 Marketplace Repo，不修改通用 `teamai` CLI、用户机器 state 或业务 Repo settings。CLI 与部门 Marketplace identity 解耦。

### 推荐流程

先 dry-run：

```powershell
npm run rename:marketplace -- `
  --from teamai `
  --to payments-platform-ai `
  --display-name "Payments Platform AI" `
  --dry-run
```

检查 Git diff 后执行：

```powershell
npm run rename:marketplace -- `
  --from teamai `
  --to payments-platform-ai `
  --display-name "Payments Platform AI"
```

如果 Marketplace Repo 不在默认 sibling 位置：

```powershell
npm run rename:marketplace -- `
  --from teamai `
  --to payments-platform-ai `
  --marketplace-repo F:\path\to\department-marketplace `
  --dry-run
```

### 参数

| 参数 | 必需 | 作用 |
| --- | --- | --- |
| `--to <id>` | 是 | 新 Marketplace ID |
| `--from <id>` | 推荐 | 必须与 manifest 当前 ID 一致，否则拒绝执行 |
| `--display-name <name>` | 否 | 同时修改 Marketplace owner/display name |
| `--marketplace-repo <path>` | 否 | 目标 Marketplace Repo；默认 sibling `../teamai-marketplace` |
| `--dry-run` | 推荐先用 | 只预览，不写文件 |
| `--help` | 否 | 显示帮助 |

### 修改范围

脚本读取目标 Marketplace 的：

```text
.github/plugin/marketplace.json
```

其中 `name` 是当前 Marketplace ID。脚本只扫描目标 Marketplace Repo，修改独立的 Marketplace identity token，例如：

```text
common@teamai
api@teamai
ios@teamai
aos@teamai
qa@teamai
design@teamai
marketplace:teamai
live-marketplace:teamai
README 中的命令和示例
```

它不会扫描或修改 `teamai-cli-copilot`，也不会把 Repo/package 名称做全局替换：

```text
teamai-vault
teamai-marketplace
```

不会因为 Marketplace ID 改名而被错误修改。

### 发布后的人工检查

该脚本只改源码 Repo。若旧 Marketplace ID 已经被注册或写入用户/业务环境，需要人工分别更新 Copilot registration、已安装 Plugin、`~/.teamai/`、`~/.copilot/` 和业务 Repo `.github/copilot/settings.json`。脚本不会擅自改动这些外部 state，因此最好在大规模 rollout 前确定最终 Marketplace 名称。

### 改名后的验证

Marketplace Repo：

```powershell
npm run validate
npm test
```

CLI Repo：

```powershell
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
npm run test:e2e:copilot
npm run test:e2e:fallback
```

最后使用真实 Copilot CLI 做 add / browse / install smoke test，并确认 VS Code Marketplace source 仍在 `chat.plugins.marketplaces` 首位。

### Learnings authority branch

`init-learnings-branch.mjs` 是管理员工具，用于初始化 Marketplace 的 `teamai-learnings` 权威分支。默认只预览：

```powershell
node scripts/init-learnings-branch.mjs --marketplace <marketplace-git-url>
```

确认目标后，显式使用 `--apply`：

```powershell
node scripts/init-learnings-branch.mjs --marketplace <marketplace-git-url> --apply
```

脚本在隔离临时 Git 仓库创建无 parent 的 root commit，只推送 `refs/heads/teamai-learnings`。分支已存在或并发创建时会停止且不覆盖；当前 checkout、`main` 和其他 refs 保持不变。分支保护与 CODEOWNERS 仍由管理员单独配置并验证。

预览和写入阶段的 Git 命令都在隔离临时 bare 仓库执行。系统、全局或环境 Git 配置若将 fetch 或 push 地址重写到其他目标，脚本会拒绝；设置 `GIT_NAMESPACE` 也会拒绝。凭据与 hooks 使用该隔离仓库可见的系统、全局和环境配置；调用 checkout 的本地 Git 配置不会参与。请确保 `user.name`、`user.email` 和所需凭据在这些配置来源中可用。

## English

`rename-marketplace.mjs` is a Marketplace maintainer utility. It renames the logical Copilot Marketplace ID inside one target Marketplace repository.

It deliberately does not modify the generic `teamai` CLI, user machine state, or business repository settings because CLI identity and department Marketplace identity are separate concerns.

Recommended workflow:

```powershell
npm run rename:marketplace -- `
  --from teamai `
  --to payments-platform-ai `
  --display-name "Payments Platform AI" `
  --dry-run
```

Inspect the Git diff, then run the real rename:

```powershell
npm run rename:marketplace -- `
  --from teamai `
  --to payments-platform-ai `
  --display-name "Payments Platform AI"
```

Use `--marketplace-repo <path>` when the target is not the default sibling `../teamai-marketplace`.

The tool renames identity tokens such as `common@teamai`, `api@teamai`, `ios@teamai`, `aos@teamai`, `qa@teamai`, `design@teamai`, `marketplace:teamai`, and `live-marketplace:teamai`. It preserves repository/package identities such as `teamai-vault`, `teamai-marketplace`, and `teamai-cli-copilot`.

After a real rename, validate both repositories. For the CLI repository:

```text
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
npm run test:e2e:copilot
npm run test:e2e:fallback
```

The two E2E commands use isolated temporary state. The native check exercises real Copilot; the fallback check hides Copilot CLI, materializes plugins into `~/.copilot/installed-plugins`, merges Copilot metadata, and checks native recognition afterward.

### Learnings authority branch

`init-learnings-branch.mjs` is an administrator tool for creating the Marketplace `teamai-learnings` authority branch. It previews by default:

```powershell
node scripts/init-learnings-branch.mjs --marketplace <marketplace-git-url>
```

After confirming the target, pass `--apply` to write:

```powershell
node scripts/init-learnings-branch.mjs --marketplace <marketplace-git-url> --apply
```

The script creates a parentless root commit in an isolated temporary Git repository and pushes only `refs/heads/teamai-learnings`. It stops if the branch already exists or another initializer wins the race; it does not overwrite refs or change the caller's checkout. Branch protection and CODEOWNERS remain separate administrator work.

Preview and apply run all Git commands in an isolated temporary bare repository. The operation stops if system, global, or environment Git configuration rewrites either fetch or push to a different target, and it rejects `GIT_NAMESPACE`. Credentials and hooks come from the system, global, and environment configuration visible to that isolated repository; the caller checkout's local Git configuration is not loaded. Ensure `user.name`, `user.email`, and required credentials are available from those configuration sources.

If the old Marketplace ID is already deployed, update Copilot registrations, installed Plugin specs, `~/.teamai/`, `~/.copilot/`, and `.github/copilot/settings.json` separately. This source-repository utility never changes those external locations.

## Real Copilot E2E

After building the CLI, run:

```text
npm run test:e2e:copilot
```

`smoke-teamai.mjs` creates an isolated temporary Copilot profile and Git repository, runs `teamai init --marketplace <sibling-marketplace-path> --role api` and `teamai projects set teamai`, installs the real standalone `release-helper` Skill, switches to `qa`, runs `sync`, `status`, and `doctor`, then verifies projected Logical Project instruction bytes plus native instruction name/scope/source listing, and exact personal-Skill and enabled Plugin-Skill paths. It removes the personal Skill and confirms the Plugin Skill remains discoverable before deleting temporary state in `finally`.

## VS Code-only fallback E2E

Run after building the CLI:

```text
npm run test:e2e:fallback
```

`smoke-fallback.mjs` hides Copilot CLI from PATH and requires either `TEAM_AI_E2E_CODE_BIN` or a working `code` discovered on PATH. It verifies `code --version` with the isolated profile before running initialization/role/sync/doctor against the local Marketplace, then verifies `~/.copilot/installed-plugins`, merged `config.json`/`settings.json`, enablement authority, and native recognition of the materialized plugins. It never substitutes a fake `code` shim.

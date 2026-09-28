---
name: teamai
description: Use Team AI CLI when a user wants to initialize or sync Team AI, change role or Logical Project bindings, discover/install/remove/contribute Team Skills, filter Skills by tag, share a Learning, inspect status, or diagnose Team AI. Route Team AI state changes through public `teamai` commands and consult `--help` for current syntax.
---

# Team AI

Use the public `teamai` CLI as the control surface. Translate the user's intent into a CLI command; let the CLI own discovery, validation, projection, and state.

## Core concepts

- **Physical Project** - the current Git repository/workspace.
- **Logical Project** - a business/domain context that can span repositories.
- **Role** - the user's selected team role.
- **Plugin** - an Agent Plugin package managed as a unit.
- **Standalone Skill** - a Team Skill that can be installed independently.
- **Plugin-contained Skill** - a Skill whose independent installability is decided by Team AI.
- **Tag** - a Skill selection/filter attribute, not a live subscription.
- **Learning** - provisional team experience shared through the CLI contribution flow.

## Route intent through the CLI

- Initialize Team AI for the user -> `teamai init` (user scope only)
- Refresh/converge Team AI state -> `teamai sync`
- Inspect or change role -> `teamai role ...`
- Inspect or bind Logical Projects for the current repository -> `teamai projects ...`
- Discover/install/remove Team Skills -> `teamai skill ...`
- Browse Skill tags -> `teamai tags ...`
- Share team experience -> `teamai learning share ...`
- Inspect health -> `teamai status`, then `teamai doctor` for diagnostics

When exact syntax or flags matter, read [references/commands.md](references/commands.md) and run `teamai <command> --help`. Treat current CLI help as the syntax source of truth.

## Ownership

Use Team AI commands instead of editing Team AI-managed state or projections directly. In particular, let the CLI manage machine state, installed Plugin packages, Logical Project bindings, managed personal Skills, and the reserved project projections `.github/instructions/teamai/**` and `.teamai/context/**`. Use the CLI contribution commands for Skill and Learning contributions rather than editing team content to simulate an install or share.

Do not assume a Plugin-contained Skill can be detached from its Plugin; ask Team AI to install it and let the CLI enforce its metadata and dependencies.

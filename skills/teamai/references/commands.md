# Team AI command map

Use this as an intent map, not as a cached CLI manual. Run `teamai <command> --help` before relying on exact flags.

| Command | Use it for |
| --- | --- |
| `teamai init` | First-time user setup: configure the team source and role. It never binds Logical Projects. |
| `teamai sync` | Refresh and converge Team AI-managed state. |
| `teamai role list` / `role set` | Inspect or change the selected Role. |
| `teamai projects list` / `projects set` | Discover Logical Projects, or bind the current Physical Project (the only binding command). |
| `teamai skill list` / `skill show` | Discover Team Skills and inspect their metadata/source. |
| `teamai skill install` / `skill remove` | Manage personal Team Skills. The CLI decides whether a Plugin-contained Skill can be installed independently. |
| `teamai skill contribute` | Contribute a Skill through the supported Team AI contribution workflow. |
| `teamai tags list` | Browse current Skill tags. |
| `teamai learning share` | Share a Learning through the supported contribution workflow. |
| `teamai status` | Read the current Team AI state summary. |
| `teamai doctor` | Diagnose inconsistent, stale, missing, or conflicting Team AI-managed state. |

## Routing examples

- "Bind this repo to payments and risk." -> `teamai projects set payments risk`
- "Show experimental skills." -> `teamai skill list --tag experimental`
- "Install the experimental skills." -> use `teamai skill install` with the current tag-selection syntax reported by `--help`
- "Share this troubleshooting note with the team." -> `teamai learning share`
- "Bring Team AI up to date." -> `teamai sync`
- "Why is Team AI inconsistent?" -> `teamai status`, then `teamai doctor`

All team-source discovery and mutation stays behind public `teamai` commands. This Skill does not require or inspect a particular team's repository layout.

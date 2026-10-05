# Team AI command map

Use this as an intent map, not as a cached CLI manual. Run `teamai --help` to read the supported command forms and flags before choosing a command.

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
| `teamai learning retry <id>` | Resume a saved Learning contribution without creating a new operation. |
| `teamai learning pending` | Read saved contribution states without submitting them. |
| `teamai recall <query>` | Search verified local knowledge read-only; the bundled `teamai-recall` Agent can translate a task into English technical search terms and read original evidence. |
| `teamai status` | Read the current Team AI state summary. |
| `teamai doctor` | Diagnose inconsistent, stale, missing, or conflicting Team AI-managed state. |

## Recall query behavior

`teamai recall --help` returns human-readable stdout with exit 0 without a query, binding, knowledge cache, native backend or network; `--json` does not turn help into JSON. Missing queries without help and malformed flags still fail explicitly. Help reads no knowledge cache, creates no product context and writes no product state.

Recall splits queries on whitespace and matches any NFC/case-normalized substring in a title, tag or body. Shell quotes only pass arguments; they do not request phrase matching. Query limits are 1024 Unicode code points and 32 whitespace-separated terms before deduplication. Results currently sort by distinct matched-term count, then summed title/tag/body weights (3/2/1), then stable ID. This is lexical ranking, not evidence of answer correctness or semantic confidence. The Recall Agent separately converts any-language tasks to English technical terms, reads original evidence and filters/reranks for relevance before answering in the user's language. English-first is a knowledge contribution convention; ordinary Chinese query terms remain supported. The CLI performs no translation or semantic search.

`auto` uses Workspace scope only when the current Git Workspace has active Logical Projects; otherwise it uses User scope. User searches shared Learnings. Workspace searches shared Learnings and active Project docs/Learnings; an explicit Workspace scope or `--project <id>` requires a binding, and the Project must be active. `--project` is incompatible with User scope. `--limit` is 1-20, default 5. Pending drafts are excluded by default; `--include-pending` includes only incomplete drafts matching source/scope, with current-origin Workspace drafts and shared drafts from any origin in User scope. JSON results preserve local paths, source revision/hash, matched terms and original snippet line numbers. Recall verifies the complete allowed corpus, makes no network/model calls, writes no persistent index/state and never implicitly refreshes or repairs a cache.

Examples: `teamai recall "Plugin discovery" --scope user`; `teamai recall "支付 重试" --limit 5`. Neither quoted query requires the whole phrase to occur.

## Routing examples

- "Bind this repo to payments and risk." -> `teamai projects set payments risk`
- "Show experimental skills." -> `teamai skill list --tag experimental`
- "Install the experimental skills." -> use `teamai skill install` with the current tag-selection syntax reported by `--help`
- "Share this troubleshooting note with the team." -> `teamai learning share`
- "Resume saved Learning operation <id>." -> `teamai learning retry <id>`
- "Bring Team AI up to date." -> `teamai sync`
- "Why is Team AI inconsistent?" -> `teamai status`, then `teamai doctor`

All team-source discovery and mutation stays behind public `teamai` commands. This Skill does not require or inspect a particular team's repository layout.

# Team AI command map

Use this as an intent map. Consult current public CLI help when syntax is unknown. Recall reuses this task's confirmed, still-valid help and state; repeat inspection only for an actual gap or a change affecting that information.

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
| `teamai recall <query>` | Search verified local knowledge read-only; the bundled `teamai-recall` Agent handles research and original evidence. Default to `auto` unless the task specifies a permitted Scope; use the actual returned Scope and Project. Preserve explicit unbound Workspace/Project errors without guessing a Project or changing Scope. |
| `teamai status` | Read the current Team AI state summary. |
| `teamai doctor` | Diagnose inconsistent, stale, missing, or conflicting Team AI-managed state. |

## Recall query behavior

`teamai recall --help` returns human-readable stdout with exit 0 without a query, binding, knowledge cache, native backend or network; `--json` does not turn help into JSON. Missing queries without help and malformed flags still fail explicitly. Help reads no knowledge cache, creates no product context and writes no product state.

Recall splits queries on whitespace and matches any NFC/case-normalized substring in a title, tag or body. Shell quotes only pass arguments; they do not request phrase matching. Without required literals, query limits are 1024 Unicode code points and 32 whitespace-separated terms before deduplication. Results sort by descending in-memory substring BM25 score, then stable ID; term-frequency saturation and document-length normalization reduce repetitive and long-content bias. This is lexical ranking, not evidence of answer correctness or semantic confidence. The Recall Agent separately converts any-language tasks to English technical terms, reads original evidence and filters/reranks for relevance before answering in the user's language. English-first is a knowledge contribution convention; ordinary Chinese query terms remain supported. The CLI performs no translation or semantic search.

For each deduplicated NFC/case-normalized query term t, tf(t,d) = 3 × count(title,t) + 2 × sum(count(each individual tag,t)) + count(body,t), where count is the number of non-overlapping continuous substring occurrences within that field. The normalized document length dl is the sum of whitespace-separated word counts in the title, each tag and body, with a minimum of 1. N is the number of all verified allowed candidates, df(t) counts those candidates containing t, and avgdl is their average dl. Compute N, df and avgdl before query-match, required-literal or limit filtering; required literals still act as hard conditions. The internal score uses k1=1.2 and b=0.75:

```text
idf(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
score(d,q) = sum(t in q) idf(t) * ((k1 + 1) * tf(t,d))
             / (tf(t,d) + k1 * (1 - b + b * dl(d) / avgdl))
```

This is a substring BM25 variant: whitespace word counts supply length normalization without adding a word tokenizer, translation or semantic matching. Query eligibility remains at least one ordinary term substring; required literals cannot widen it. Rank and internal scores are not confidence or probability, and the public JSON fields remain unchanged.

Use repeatable `--require <literal>` only when the task needs a literal condition, for example `teamai recall "Plugin not" --require "Plugin not found: E_PLUGIN_42." --require "BuildGraph.findNode" --scope user`. Each entire NFC/case-normalized literal must occur continuously within one title, one individual tag or body; literals are not split into words, joined across fields/tags, stripped of punctuation or expanded as regex. All literals are required (AND), and the query remains mandatory with at least one ordinary term match. Required literals filter only the complete verified allowed scope, before query ranking and limit; they cannot expand source/Project/pending access or turn cache errors into zero hits. Query plus every raw required value allows at most 1024 Unicode code points before normalization; query whitespace terms before deduplication plus required value count allows at most 32 items. Repeated literals count separately. Empty, whitespace-only, missing or over-limit values are input errors; use `--require=<literal>` for a value beginning with `-`. Text reports the applied original values, and JSON adds top-level `requiredLiterals` in caller order only when used; `matchedTerms` still describes ordinary query terms. File IDs, provenance, raw hashes, paths, line numbers and snippets retain the existing contract. This is literal filtering and does not claim diagnostic association, negation or causal understanding. Agents should use it only for an actual literal requirement, not every diagnostic task.

`auto` uses Workspace scope only when the current Git Workspace has active Logical Projects; otherwise it uses User scope. User searches shared Learnings. Workspace searches shared Learnings and active Project docs/Learnings; an explicit Workspace scope or `--project <id>` requires a binding, and the Project must be active. `--project` is incompatible with User scope. `--limit` is 1-20, default 5. Pending drafts are excluded by default; `--include-pending` includes only incomplete drafts matching source/scope, with current-origin Workspace drafts and shared drafts from any origin in User scope. JSON results preserve local paths, source revision/hash, matched terms and original snippet line numbers. Recall verifies the complete allowed corpus, makes no network/model calls, writes no persistent index/state and never implicitly refreshes or repairs a cache.

Snippets are retrieval hints from the original file. Select the consecutive original window covering the greatest number of distinct actual query terms after NFC/case normalization; equal coverage keeps the earliest original position. Normal windows contain up to three original lines, with shorter windows only at source boundaries. Windows over 1200 Unicode code points are clipped to a continuous original span near the earliest actual match, with lineStart/lineEnd marking only its corresponding original lines; line characters stay unchanged and the existing LF newline presentation also applies to CRLF sources. A hit only from a derived filename title, with no query term in the raw text, keeps the deterministic opening window. matchedTerms remains file-level query matches even when the bounded snippet omits a term; required literals, file eligibility/order/limit and source/path/revision/full-file hashes retain their contract. A snippet does not establish negation, causality or that an Agent has read the source; conclusions outside it still require reading original evidence.

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

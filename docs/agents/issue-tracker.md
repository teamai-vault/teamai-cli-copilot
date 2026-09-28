# Issue tracker: GitHub

Issues and specs for this repo live in GitHub Issues at `teamai-vault/teamai-cli-copilot`. Run `gh` from this repository.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments`; add label and state filters as needed.
- Comment: `gh issue comment <number> --body-file <file>`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

When a skill says “publish to the issue tracker,” create a GitHub issue. When it says “fetch the relevant ticket,” read that issue and its comments.

## Pull requests as a triage surface

**PRs as a request surface: no.** Set this to `yes` only if external PRs should enter the triage queue.

## Wayfinding operations

For `/wayfinder`, keep the map in one issue labelled `wayfinder:map` and its tickets in child issues. Use GitHub sub-issues when available; otherwise link tickets in the map body and add `Part of #<map>` to each ticket. Mark ticket types with `wayfinder:<type>`.

Use GitHub issue dependencies to record blockers when available; otherwise add `Blocked by: #<n>` to the ticket body. The next ticket is the first open, unassigned child without an open blocker. Claim it with `gh issue edit <n> --add-assignee @me`. Resolve it by commenting, closing the issue, and adding a short decision link to the map.

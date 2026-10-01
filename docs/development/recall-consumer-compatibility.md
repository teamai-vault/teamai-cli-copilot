# Recall consumer compatibility

This version-limited investigation records [CLI #25](https://github.com/teamai-vault/teamai-cli-copilot/issues/25) against CLI revision `ac2cbd7605b4d31a6b185c14ffe0cc9e35a76644`. The controlling contract is [Spec #14](https://github.com/teamai-vault/teamai-cli-copilot/issues/14). The offline public Recall command passed the isolated positive and negative controls for both homes. Consumer tool execution and original evidence reading remain **unverified**. These results do not satisfy the consumer support gate for [#26](https://github.com/teamai-vault/teamai-cli-copilot/issues/26).

## Tested versions and boundary

Observed on 2026-10-02: Windows NT 10.0.26200.0, x64/AMD64, Node 24.15.0, Git 2.54.0.windows.1, TypeScript 5.9.3 and TeamAI CLI 0.3.0. The isolated build matches the accepted base's Recall build bytes. The actual standalone interactive producer was Copilot 1.0.83; the outer default version command reported 1.0.89. VS Code was 1.140.0 (`07f806f999227108933c2e30515b26eecc1fda74`), with built-in Copilot Chat 0.68.0. The observed Agent Host launched the bundled `@github/copilot-sdk-win32-x64` runtime; its version flag was unsupported, so its version is unknown.

Temporary Agents were manually placed in isolated roots. Native/fallback Agent delivery, formal bundled Agents/Skills, npm packaging, non-English acceptance and macOS ARM were not exercised. The synthetic source and published-learning authority were local Git repositories, with no business remote. Recall did not launch a model or network backend. Native consumers may normally use a model, but no model request completed here.

## Support matrix

“Supported” below covers only the stated observation. “Unverified” includes capabilities stopped before invocation by native authentication or Restricted Mode. No negative discovery observed under those conditions establishes general lack of support.

| Consumer | Copilot root | Agent discovery/profile | `read` / `execute` invocation | Consumer runs Recall | Original source / ignored-doc reading | Actual root evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Standalone Copilot CLI | Default | Unverified; native agent-not-found before login | Unverified | Unverified | Unverified | Native session-state written under default root; resource discovery/consumption unverified |
| Standalone Copilot CLI | Custom | Unverified; native agent-not-found before login | Unverified | Unverified | Unverified | Native session-state written under custom root; resource discovery/consumption unverified |
| VS Code Local | Default | Supported: unique Agent listed, selected and definition opened | Unverified; definition contains both aliases | Unverified | Unverified | Unique default-root Agent discovery supported |
| VS Code Local | Custom | Unverified; probe absent in observed list | Unverified | Unverified | Unverified | Custom-root discovery/consumption unverified |
| VS Code Copilot Agent Host | Default | Unverified; probe absent in independent Host list | Unverified | Unverified | Unverified | Launcher roots recorded; actual Host resource root unknown |
| VS Code Copilot Agent Host | Custom | Unverified; probe absent in independent Host list | Unverified | Unverified | Unverified | Launcher roots recorded; actual Host resource root unknown |

Every consumer cell has no completed native tool request, tool return or model final provenance. UI profile parsing is separate from alias execution. A selected Agent carried across a Session Target change is also insufficient: Host discovery was checked by opening its own Agent list. Local and Copilot Host are distinct selected consumers within VS Code; extra windows are not proof of independent Hosts.

Standalone native output explicitly required `/login`. VS Code retained Restricted Mode, showed models unavailable and disabled Send. A generic sign-in/add-model banner and a saved HydraFusion model name do not establish that every backend needs GitHub login; authentication and usable models remain unverified under Restricted Mode. Default and custom runs used successive fresh main processes, with native Host logs and custom Host/SDK descendant PIDs recorded. Those process identities do not prove the Host inherited or consumed `HOME` / `COPILOT_HOME`.

## Roots and evidence semantics

The isolated run root was `F:/agent-workspace/multiAgent/teamai-cli-customization/.tmp/v4-round-25/investigation`. Its Workspace was `fixture-workspace`. Default `HOME` and `USERPROFILE` were `fixture-workspace/.isolate/default-home`, with `COPILOT_HOME` unset and the Agent in `.copilot/agents/teamai-recall-default-probe.agent.md`. Custom `HOME` and `USERPROFILE` were `.isolate/custom-home`, with `COPILOT_HOME` set to `.isolate/custom-copilot-root` and the Agent in that root's `agents/teamai-recall-custom-probe.agent.md`. No Agent was copied into the custom home's default `.copilot/agents` path.

VS Code reused the authorized isolated test user-data `F:/agent-workspace/codex/.tmp/v4c19/closeout/profile/AppData/Roaming/Code` and extensions `F:/agent-workspace/codex/.tmp/v4c19/closeout/profile/Extensions`. No credentials were read or copied. Full command arguments and isolated environment roots are retained in the evidence report. The broken global `code.cmd` shim was bypassed with the actual `D:/soft/Microsoft VS Code/Code.exe`; it was not repaired.

The public command was:

```text
teamai recall "backoff calibration" --scope workspace --project recallprobe --json
teamai recall "NO_MATCH_9bdba826f45044359d0c" --scope workspace --project recallprobe --json
```

The owned `teamai.cmd` invoked `node <run-root>/runtime/dist/cli.js`. Both positive returns contained the document and published learning, with actual readable paths and byte hashes; both negatives contained no hits. Source revision was `f4e4eb92f871b81de2dba898d9e0cc9c010e4e75`; learning revision was `8ad2924ed028904e5835fc5bfce78c692aec670a`. Document SHA-256 was `79ae996372b4fd7fcae8ee4ae9dcd8eb817bbc1b0bba06c8797af76356edfa92`; learning SHA-256 was `19796c712c7a27efa52e28a1ab059a6ce4a7535e7c1ca5dba1ae896979cd86cd`.

The unique answer markers were on original line 102; Recall snippets covered lines 1–3 and did not contain either answer. Tasks and Agent profiles did not expose answers. The investigator verified returned file bytes, provenance, line ranges and actual outer-Workspace ignored status. This establishes CLI evidence correctness and local filesystem readability, not consumer original-file reading. Source docs were tracked inside the nested source repository; both returned paths were ignored by the consuming outer Workspace through `.isolate/`. That precise ignore boundary must be retained in future comparisons.

Source, authority refs/objects, selected TeamAI homes/cache, Agent files and Workspace Git fingerprints remained unchanged across Recall and after the consumer harness. Native session files and VS Code user-data writes are expected harness state and excluded from Recall's read-only assertion. The public CLI checks showed no execution of a fixture instruction to write a file or run sync, and protected files remained unchanged. This is a CLI-only observation. No consumer model request completed, so model handling of recalled instructions and model injection acceptance remain unverified.

## Repeatable acceptance method and recovery

1. Freeze the CLI revision/build, source revisions, exact file hashes, consumer versions and complete roots. Prepare non-sensitive local fixture state before the Recall measurement. Keep custom and default roots separate, without migration or dual writing.
2. Run the existing public command in both homes with a positive query and a unique no-hit query. Verify returned revisions/hash/file paths and fingerprint protected state. Keep answer markers outside snippets and out of tasks/profiles.
3. In each actual consumer, select the unique temporary Agent, record its independent discovery and profile, and send a bounded task. Capture the native executable request and return, then a separate native file-read request/return for the returned originals around the answer line, including ignored paths. Require final provenance and the negative control; a model claim alone is insufficient.
4. Establish the actual consumer resource root independently of launch arguments. Record Host process/session identity; a launcher environment or additional window does not establish root adoption. Preserve unknowns when this cannot be measured.
5. Retain raw failures and distinguish discovery, tool alias invocation, executable invocation, source reading and root behavior. Mark gated operations unverified rather than inferring support from successful CLI subprocesses.

To resume the native checks, a human must resolve any required authentication and Workspace trust/security in the exact isolated profiles, then repeat the bounded consumer controls. Computer Use guidance prohibits automating authentication dialogs or acting on in-app security permission requests; no trust, policy or auto-approval settings were changed. The investigation can close with these classifications after independent review, while the affected #26 support gate stays blocked and the limitations/recovery gate are recorded in Spec #14. No Spec behavior was changed by this report.

The frozen run evidence is under `<run-root>/evidence`: `investigation-report.json`, `public-report.json`, per-case public returns, per-consumer launches, selected native UI/log/session fragments and `candidate-manifest.json`. The parent coordinator's `../coordination/runtime-source-check.json` independently binds the temporary build to the accepted base. Raw single-run evidence remains temporary; this document preserves the version limits and acceptance method.

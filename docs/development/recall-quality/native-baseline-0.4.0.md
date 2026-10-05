# Original 0.4.0 native baseline: setup recorded, discovery/auth blocked

This is the preserved historical pre-login stage. The [later actual consumer baseline](native-baseline-after-login-0.4.0.md) records successful selection and eight sessions/ten frozen turns after normal human sign-in, with mixed quality PASS/FAIL. Its later observations do not change the failures or zero counters below.

The actual public setup and original Agent delivery passed in the new native v2 profile. The normal Copilot 1.0.91 client could not select `teamai-recall` and required human sign-in. One C01 session was attempted; **zero model queries, native original reads or answers ran**. The remaining seven sessions/nine question turns were not attempted. All ten intended model turns remain unverified. Exit 0 records normal `/exit`, and does not make discovery, answer quality or #30 pass.

The [public CLI baseline](baseline-0.4.0.md) retains both its v1 setup failure and v2 source-coverage results. This native stage adds actual setup/discovery/auth evidence. No native quality, multi-query, Agent ordering, BM25, snippet improvement or final-candidate comparison is claimed.

## Bound identities

| Fact | Actual binding |
| --- | --- |
| Product source / CLI | `0fb99a7b065de71eb683d774231b518971b57e8c` / `0.4.0` |
| Original tarball SHA-256 | `dea321f1fc9fb030fc18af398bcdb796d8cec7473c085e23be97eb3ca59aded6` |
| Compiled CLI SHA-256 | `dc1fae834fb9933c1d702d99bee3196e578f661079046dfa10a97e2acc0426a2` |
| Bundled and actually delivered Agent SHA-256 | `7e8edba317dde8758d3f238e1845fecb6206d93c00667df4ab8cbe72e7f270e4` |
| Frozen fixture Git tree / 22-file raw manifest | `d185a284718659d296afa2f93cea7f225bfb41b5` / `37c2bbb2264b11755d05710ecaba1a3f94d10217cae6c6c556c18abd533fbeb7` |
| Native-only resource main | `7dbb74107cc4c457a5043619090b11a38b74a7a0` |
| Native-only sourceHash | `7e0deb60b0e77e11643d034e10200e61d1958eb86359e60263677cd50c7ad096` |
| Published Learning revision | `cf573d619178f5b29773ac7c616a231e789eeb75` |
| Actual consumer / process platform | Copilot `1.0.91`; Node `v24.15.0`; Windows `win32` / `x64` |

Paths below are relative to `F:/agent-workspace/multiAgent/teamai-cli-customization/.tmp/recall-29-35`. The installed package is `runtime/baseline-installed/node_modules/teamai-cli-copilot`. The actual `teamai` resolution is that installation's `.bin/teamai.ps1`. Native v2 source/authority are `runtime/c/native-baseline-v2/resource` and `origin.git`; home and consumer are `home` and `home/.copilot`, with workspace `workspaces/C01` under the same v2 root. HOME/USERPROFILE/APPDATA/LOCALAPPDATA/COPILOT_HOME, XDG directories, TEMP/TMP and npm cache were explicitly set to new F paths. No native auth/profile was copied.

The coordinator approved the native-only addition `owner: { name: "Recall Quality Fixture" }` after the actual current consumer rejected the frozen minimal Marketplace scaffold. The exact before/after manifest bytes, hashes, new main/ref/source path, authority setup and 16 original checks were recorded **before consumption** in `native-source-before-consumption.json`. All 16 original hashes match the fixed fixture; 15 are declared allowed for `atlas-payments`. The new local authority contains both that native main and the fixed published ref. Actual sync produced all three cached published Learning files with matching raw hashes. The public projects list marks `atlas-payments` active and leaves `atlas-other` inactive. No native Recall response exercised the allowed set, so native filtering remains unverified.

## Actual setup history, including failures

| Run / operation | Actual exit / elapsed | Result |
| --- | --- | --- |
| Native v1 first public init | null / 120,021 ms; SIGTERM / ETIMEDOUT | FAIL at recorder deadline; only Marketplace discovery printed; no receipt. Normal duration versus waiting/hang remains unverified. |
| Native v1 first no-deadline continuation | 1 / 43,179 ms | FAIL: empty new operation lock remained. |
| Native v1 continuation after recovery | 1 / 104,134 ms | Actual original Agent/Skill delivered; Copilot marketplace add then rejected `owner: Required`. Partial delivery, config/binding/cache not prepared. |
| Native v2 public init | 0 / 90,665 ms | PASS: original Agent/Skill, common/quality plugins and isolated VS Code registration. |
| Native v2 public sync | 0 / 123,903 ms | PASS: fixed published cache prepared. Authorized setup, before measurement. |
| Native v2 public projects set | 0 / 2,961 ms | PASS: `atlas-payments`. |
| Native v2 public projects list | 0 / 527 ms | PASS: active star observed. |

The three failed v1 init attempts total 267,334 ms. The four v2 public setup operations total 218,056 ms. These are setup process durations, not model or Recall latency. Native phase also ran two public version observations, for nine actual TeamAI setup/version processes in total; it added **zero Recall queries**. Copilot version/help, Git fixture operations and protected snapshots are separately recorded in the raw setup summaries.

Correction 3 removed the recorder deadline. The completed own init/retry interval had no remaining processes, established by an independent join of raw UTC timestamps. The prescribed `Remove-AgentTemp.ps1` removed only the confirmed empty new C lock. Unknown earlier/later processes were untouched. The flawed local-time comparisons and DateTime coercion were retained and rejected; `correction-3-process-end-independent.json` is authoritative. Correction 4 uses fresh v2 roots and owner metadata. No frozen file, expected answer, baseline CLI profile/ref, product file, native approval policy or original failure log was changed.

## C01 real consumer attempt

The actual launch used `--agent teamai-recall`, a fresh UUID, an F log/usage output location, and `-i` with exactly the frozen Chinese C01 question. It supplied no oracle, English keywords, source list or expected ranking. At the normal folder prompt, option 1 **Yes for this session** was selected. The future-folder option was not selected, and no blanket tool/path permissions, model override or discovery setting was added.

The raw PTY then reports:

~~~text
Custom agent "teamai-recall" not found. Available agents: none
Please use /login to sign in to use Copilot
~~~

These are independent observed prerequisites. The delivered file and receipt establish bytes/ownership, while actual selection failed. Sign-in alone has not been shown to resolve selection. C stopped the dependent session with the client's normal `/exit`; it returned exit 0. The native usage file records `totalUserRequests: 0` and API time 0, and no conversation `events.jsonl` exists for this session. The question argument therefore does not establish a model question, query, read or answer.

| Measurement | Observed state |
| --- | --- |
| Session process attempts / question launch arguments | 1 / 1; C01 Chinese attempted |
| Actual selected Agent | FAIL: not found; available agents none |
| Actual model/user requests, Recall queries, native original reads, answers | 0; task behavior remains UNVERIFIED |
| C01 English/pronoun, C02–C06 Chinese, missing/damaged controls | Nine question turns / seven further session launches unattempted |
| Native top 5/10, first three weak candidates, source dedup/order/support and final answer | UNVERIFIED; no native query or answer |
| Native no-hit/cache/injection/execute/read boundary behavior | UNVERIFIED; CLI evidence does not substitute |
| Actual model identity / USD price | UNVERIFIED; model/agent metrics are empty |
| Observable native usage | Premium-request cost 0; user requests 0; NanoAiu 0; API duration 0; last-call input/output tokens 0; code changes 0 |

Zero counters belong to this blocked attempt. They do not estimate the cost or latency of any successful task.

## Protection and raw evidence

All 215 fixed CLI baseline facts remain identical through v1/v2 setup and C01. Native business file content, source/authority facts and workspace Git facts are also equal before/after C01. **Strict native filesystem equality is FAIL** because the client created an empty `home/.copilot/installed-plugins` directory. No file content changed there. The initial snapshot label fallback incorrectly printed ABSENT for a missing file-fact key; both raw assessments remain preserved, and `native-directory-readback.json` / `native-independent-readback.json` distinguish the observed empty directory from unchanged content.

Native session workspace/checkpoint/file/research directories and logs are platform writes excluded from business fingerprints. Their existence is not evidence of original reads. Credential/account configuration and session metadata contents were not read or copied. No old guard, ACL, authority or ref was touched. The injection marker stays absent, but C05 is unrun, so this does not establish injection resistance.

The sibling `native-baseline-0.4.0/` contains byte-identical copies of selected actual stdout/stderr, raw PTY chunks, receipt/source bindings, usage, snapshots and independent readback, with a raw manifest. Full originals remain in `handoffs/c-quality/baseline-native-v1` and `baseline-native-v2`. The raw terminal transcript and default native logs remain there; they are not silently replaced by prose. This report does not manufacture native tool events or answers.

Local attributes in that raw directory preserve original LF/CRLF bytes and recognize CR at end of line during whitespace checks. All 34 staged raw blobs match their original SHA-256. The initial four EOL-normalized staged mismatches are retained as recording RED; originals were preserved.

## Scheduling and human continuation

C released E1-NATIVE after the process exited, through `handoffs/c-quality/E1-NATIVE-release.json`. The coordinator handles acceptance, human help and further consumer scheduling. No further C native/model/public-query run is allocated.

The prepared-only `handoffs/c-quality/native-auth-baseline-v2.ps1` sets the same explicit F environment and invokes the official `copilot login`. It has not been executed by C. The actual window's `/login` is also the observed normal operation. After normal sign-in, the coordinator must establish real Agent discovery and allocate a new immutable candidate/owner slot before replaying the frozen cases. This stage leaves seven session launches/nine turns unattempted and C01's attempted model turn unexecuted; clean replay and the final integrated candidate comparison remain pending. No variant or platform can inherit PASS from this stage.

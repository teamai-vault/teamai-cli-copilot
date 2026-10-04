# Windows and macOS package portability

Repository text uses UTF-8 without BOM and LF. `.gitattributes` fixes checkout
line endings independently of `core.autocrlf`; `.cmd` and `.bat` use CRLF.
`.editorconfig` guides editing. Do not renormalize an entire existing worktree.
Use a fresh checkout, or refresh only clean, reviewed source paths.

The `prepare` lifecycle builds the CLI and checks authored package text for
`npm ci`, actual `npm pack`, and Git dependency installation. Missing build
dependencies or CRLF/BOM package text are errors. `--ignore-scripts` bypasses
preparation, and `npm pack --dry-run` skips `prepare`; neither proves an unbuilt
package works. Installing the resulting tarball needs runtime
dependencies, not TypeScript. CI additionally installs the actual tarball,
checks the `teamai` bin entry, and checks default/custom-root bundled delivery.
That delivery fixture does not establish model or VS Code consumption.

Git installation tests pin a task-owned local repository revision. npm 12
requires an explicit per-command Git opt-in (`--allow-git=root`); verification
uses the registry already recorded in the lockfile and does not change the
user's global npm policy. A locked mirror URL can otherwise be rejected by
npm 12 when its host differs from the configured registry.

Keep two kinds of comparison distinct:

- A semantic text comparison may normalize CRLF to LF in a separate copy.
- Package identity, installed targets, ownership/checkpoints, `source_sha`,
  Learning provenance, frozen contribution payloads and original line numbers
  are checked against the actual bytes. Never rewrite them to satisfy a hash.

Published Learnings are read from Git blobs, rather than text-filtered resource
checkouts. Contribution staging disables `core.autocrlf` and verifies the exact
staged payload; conflicting attributes/filters must fail explicitly. The
`learnings/**` attribute exception is a preservation rule, not permission to
add files to the authority branch or migrate existing evidence.

The earlier 0.4.0 CRLF Agent and an LF source checkout can have identical text
and different raw hashes. Existing receipts keep their recorded hash; a later
owned delivery can converge to the reviewed bundle using the existing checks.
Personal modifications and interrupted plans remain protected.

Run the sequential repository gate, `package:test`, native/fallback E2E and
the public joint verifier in separate profiles. Include paths with spaces,
Unicode, `#` and `%`, and inspect both `core.autocrlf=true` and `false` fresh
checkouts. Keep Windows/macOS/CPU and backend/consumer results separate. macOS
CI, discovery or a fixture cannot establish macOS ARM/model acceptance.

## Supported path policy

Windows long paths are unsupported. Operational commands reject an absolute
workspace, home directory or applicable `COPILOT_HOME` longer than 240 UTF-16
code units before initializing the backend or writing state. This is a product
limit with headroom for Windows/Git, not a universal filesystem guarantee.
Generated cache and Git paths can hit tool limits sooner; filename-length,
Git-directory-length and OS home-directory-length failures return exit 1 with
guidance to shorten the home or workspace path. JSON commands retain their
existing error envelope. Help and version do not initialize the profile.
Use short writable roots for test profiles and temporary directories. Do not
move existing receipts, ownership or pending operations automatically.

## Current platform acceptance

On 2026-10-04, macOS testing for this patch is explicitly skipped because no
macOS test environment is available. Keep this recorded as skipped, rather
than passed. Earlier macOS CI results apply to their earlier revisions.
Actual model and VS Code extension consumption remain unverified.

References: [Git attributes](https://git-scm.com/docs/gitattributes),
[npm lifecycle scripts](https://docs.npmjs.com/cli/v12/using-npm/scripts/).

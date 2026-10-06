# Recall 0.5.0 validation

CLI Scope, allowed sources, hard literal filters, input limits, original snippets and provenance validation are deterministic. The bundled Agent interprets uncertain questions, reads originals and compares their applicability using the current native session model. It does not guarantee exact semantic recall, a fixed model ranking or exact transcription in every answer. Failures below remain failures.

## Runtime and source identity

The actual local package was built and packed from `4977e40ac7e6d327f63710302bac137177f70193`, version 0.5.0. Its tarball SHA-256 is `b1d9bf3a73525dcc289e87e8afd7a35180d98fe7a1259db7bb7607eaf6389656`; compiled CLI SHA-256 is `79f64b93f5b477254d1f6697348603740d13bb7e1b5b33f8a5c75fa7447c20be`; Agent SHA-256 is `03562f41201196a8272e3fbbd6997f989ba6eceb34bbae99276fe1e4359a0452`.

Subsequent report commits change development documentation only. They do not replace this runtime identity with a new native run. The source/package bridge records the final source revision separately and confirms unchanged production, package/version, lock, test, fixture and shipped authored bytes. This is source delivery, without an npm or Marketplace release.

## Executed evidence

- [Compiled CLI observations](recall-cli-validation/README.md): 35 installed-executable observations, with the independent expectations and 20 original documents frozen before queries. The compiled CLI is byte-identical to the current package. Expected input and state errors are recorded individually.
- [Agent observations](recall-agent-validation/README.md): ten original current-package tasks run once, with raw reads, child/parent answers, normal endings and protection. Diagnostic/hash transcription and the first-context routing limit are retained. Earlier injection/citation and STOP failures remain at their original identities; they are not converted into current-package runs.
- [Quality measurement](recall-quality/README.md): the fixed 0.4.0 CLI/native baseline retains its mixed failures. Both versions cover all 22 applicable required-source groups in the 34 fixed CLI calls; 17 result orders and 102 same-ID snippets/line spans changed. Eight expected cache errors remain errors. One timing sample (28,952 vs 30,175 ms) establishes no performance significance. The final native observation completed the original eight sessions / ten questions once: 12 queries, 13 views (12 original reads), 23 provenance-checked hits and normal process endings. Complete-diagnostic truncation in the English answer and citation omissions remain failures/limitations; no whole-product accuracy PASS is inferred.

The full local gate at `e0eb6a4734b78608709fb16398701cbbf26cae4a` passed 37 files / 253 tests, with one skip, after an identical-source retry using a shorter task TEMP. The original Windows path-length failures remain recorded. Unchanged TypeScript and delivery tests retain actual typecheck and 11-test evidence at `8000bae22cf6a3490578e25e1af6b618e73267d5`. At current runtime source `4977e40`, actual build, pack/install, shipped byte equality and two owned Agent/Skill deliveries passed. No repeated full local suite was added for prompt or report-only edits.

Independent Standards/Spec reports, actual Windows/macOS CI and remote source retrieval are recorded with the delivery PR and must be checked there. Local Windows native sessions do not establish macOS native, VS Code, other models or unrun hash/revision variants. Vendor CLI changed from 1.0.91 in the original native baseline to 1.0.92 in the final observation. Auto also selected different models within the context case; comparisons cannot attribute every difference solely to TeamAI.

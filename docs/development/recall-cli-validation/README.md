# Compiled Recall CLI observations (#31 / #32 / #34 / #35)

The accepted observation ran the installed compiled executable on Windows with Node 24.15.0. It covers 13 entry/parser observations, 18 original-snippet scenarios, two repeated hard-literal cases and two cached User Scope ranking/filter cases. Expected error exits are recorded individually. The 20 original documents and the independent expectations frozen before queries retain their raw bytes, including CRLF and Unicode cases.

The observed source is `740f5d0cadf6dfec0533e64442a61b0ac88e21b7`. Its compiled CLI SHA-256 is `79f64b93f5b477254d1f6697348603740d13bb7e1b5b33f8a5c75fa7447c20be`, identical to the later actual 0.5.0 runtime package at `4977e40ac7e6d327f63710302bac137177f70193`. This byte bridge reuses the CLI observations; the earlier Agent hash in the original report does not establish behavior of the later Agent.

See [the original report](report.json), [expectations frozen before queries](expected-before-queries.json), [root acceptance](root-compiled-acceptance.json) and [raw-byte manifest](raw-manifest.json). Individual process arguments, actual output and exit status are in `observations/`; originals are under `originals/`.

The initial missing-catalog/cache failure remains in `history/`. Root acceptance also records the rejected LF clone of a deliberately CRLF source and the subsequent separate fixture preparation. These were fixture preparation problems, not passing compiled observations. No old payload or failed result was rewritten.

Production integration tests and committed independent BM25/snippet/literal fixtures supply the broader deterministic cases. This report adds an actual installed-executable seam. It does not claim native/model behavior, universal performance improvement or unrun platform coverage. Native observations and fixed quality comparisons have separate reports.

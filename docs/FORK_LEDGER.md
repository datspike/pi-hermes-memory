# Fork compatibility ledger

This ledger records the local contracts carried forward onto upstream, including changes that upstream already supersedes. An implementation is not accepted merely because Git merges it or a source file exists: every retained contract needs current evidence.

## Baselines and authority

- User request: start from `upstream/main` in a separate worktree, record our changes in a ledger, allow Pi sessions and model tests, run `implementation-closeout`, preserve the current `main` in a backup branch, deploy the verified version to our local `main`, and verify the user's real Pi setup with its existing folder-based package registration.
- Managed completion contract: goal `2e17876d-faa6-4a82-bd55-9ccf0461e519`.
- Approved search-policy decision: use upstream trigram and query normalization for `session_search`/`memory_search`, including broader results; retain full message and embedded tool-result text, and migrate FTS in bounded resumable steps.
- Upstream baseline: `7ab4f10e212684331f5d63dac534bf61fca6f96a` (version `0.9.9`, including post-tag fixes).
- Local baseline: `ee04178de40c830fac753d7c582b69a2044707e5`.
- Common ancestor: `26f0acaa7741a81ea28eb992ab7ffcfdb7b50a0c`.
- Backup branch: `backup/main-before-upstream-forwardport-20261001-ee04178`, pointing to the local baseline.
- Integration branch: `feat/upstream-forwardport-20261001`, created directly from the upstream baseline.
- The original checkout's uncommitted `package.json` and `NOTICE` are not part of the local baseline and must not be overwritten or silently committed.

Statuses: `pending` means no current proof; `ported` means implementation exists but verification is incomplete; `verified` requires a linked current result; `superseded` requires proof that upstream satisfies the same contract. Historical test results are regression inputs, not proof for this version.

## Local contracts

| ID | Contract and source commits | Main implementation / regression inputs | Decision | Status / current evidence |
|---|---|---|---|---|
| F01 | Preserve extended memories during database corruption handling, transactional recovery and concurrent startup; fence obsolete handles (`12a05a2`). | `src/store/db.ts`, `atomic-lock-coordinator.ts`; recovery-fencing and old-release-compat tests. | Retain; isolate startup integrity scans without weakening recovery fences. | verified: Node suite; copied-table hashes unchanged through migration and old-main open/search/close. |
| F02 | Physical message keys differ from canonical session-scoped entry IDs; preserve kinds, parents, ordinals and tool diagnostics (`12a05a2`). | `schema.ts`, `db.ts`, `session-parser.ts`; schema and logical-parser tests. | Retain schema and canonical source authority. | verified: Node schema/logical-parser tests. |
| F03 | Repair migration is durable and restartable, with metadata checks and integrity handling (`12a05a2`). | Repair handler, DB and FTS worker; repair and FTS migration tests. | Retain; copy full payloads inside SQLite, persist phase/cursor atomically under the fence. | verified: isolated copied-database migration, restart/cancellation/reaping, readiness/coverage and shutdown evidence; pass 13 found no P0/P1/P2 regression. Production remains readonly. |
| F04 | Canonical session/file ownership, project boundaries, stale evidence rejection and exact identity validation (`12a05a2`, `a4c5c91`). | Parser/indexer/search; ownership, reader and search tests. | Retain; SQLite candidates are not canonical evidence. | verified: descriptor-bound readers, pinned roots, canonical metadata paths, stale/ownerless rejection and exact/prefix identity regressions pass; pass 13 accepted the current snapshot. |
| F05 | `session_get` resolves exact or unambiguous identities, preserves source anchors and fails closed on ambiguous/stale input (`12a05a2`). | `session-get-tool.ts`; tool and logical-parser tests. | Retain public tool and result contract; an irreducibly oversized identity returns `session_get_response_limit`, never a shortened ID or anchor. | verified: exact/ambiguous/stale identity, anchor round-trip, bounded output, oversized identity and symlink/traversal regressions pass; pass 13 accepted the current snapshot. |
| F06 | Incremental live indexing safely falls back on truncation, replacement, malformed tails and logical entries (`9a7421e`). | Indexer and live-index handler; indexer and logical-parser tests. | Retain canonical fidelity and default-disabled retention. | verified: bounded discovery cursor/reservation/wrap, scoped-owner preservation and replacement/malformed-tail regressions pass; pass 13 accepted the current snapshot. |
| F07 | Isolated rebuild proof validates restoration without writing production state (`cc02c92`). | `scripts/rebuild-proof.ts`, rebuild-proof tests. | Retain proof runner. | verified: Node suite; production excluded from migration tests. |
| F08 | Recover missing prior context through narrow retrieval before guessing or requesting repetition (`62e4dd3`). | `constants.ts`, prompt-context tests. | Retain prompt policy. | verified: Node suite. |
| F09 | Host-provided SDK/TUI/TypeBox avoid duplicate runtime packages (`b0ca8b3`). | Package manifest, minimum-SDK, production-install and installed-Pi loader checks. | Upstream supersedes the TUI dependency move; retain wildcard peers and test the SDK floor. | verified: SDK 0.80.6 type-check, restored SDK 0.80.10, production-only install and Pi 1.0.0 loader. |
| F10 | Bound SQLite payload and canonical-reader allocations before JavaScript decoding (`629b1c9`). | Search/parser; memory and reader tests. | Retain scoped budgets and explicit error contracts. | verified: Node suite and Bun profile. |
| F11 | Bound metadata while preserving canonical matches beyond stored/truncated candidate text (`5da3324`). | Search/parser; memory and review-regression tests. | Retain full index text; reject upstream truncation. | verified: Node suite and FTS middle match in an 8077998-byte copied message. |
| F12 | Budget aggregate candidate identities before loading payloads (`0b918a0`). | Search; memory tests. | Retain aggregate key budget and bounded metadata projection. | verified: Node suite. |
| F13 | Stop after the highest-priority valid canonical owner (`5910efb`). | Canonical parser/search; memory and reader tests. | Retain deterministic ownership and scan budget. | verified: Node suite and Bun reader tests. |
| F14 | All search modes run outside the parent event loop; native work cancellation/deadline settles after child close (`ee04178`). | Search async/worker/tool; responsive tests. | Retain isolation, Node 256 MiB heap guard and Node/Bun/compiled paths. | verified: Node suite, Bun profile, installed-Pi loader and compiled Bun search/cancellation. |
| F15 | Search workers open the indexed database readonly/query-only and validate state without managed initialization, recovery or backfill (`ee04178`). | Search worker and readonly opener; responsive/owned-candidate tests. | Retain; require recognized complete repair state and current schema. Canonical legacy uses a separate, one-row in-memory matcher, never a writable indexed connection. | verified: Node suite and compiled Bun rejection of unknown repair state. |
| F16 | Streaming anchors preserves JSON grammar, decoded duplicate keys, physical lines and Unicode on large valid input (`ee04178`). | `session-anchor-*`; JSON/member/anchor/responsive tests. | Retain; no new input limit or relaxed heap guard. Native buffers are not an RSS limit. | verified: Node suite and Bun profile. |
| F17 | Aggregate anchors response is at most 1 MiB, with explicit failure and no partial success (`ee04178`). | Search output and responsive tests. | Retain `SESSION_SEARCH_RESPONSE_LIMIT`. | verified: Node suite and compiled Bun response-limit rejection. |
| F18 | Commit verified work coherently without unrelated files, secrets or generated evidence (`c2ebafe`). | Git workflow and closeout. | Retain; no push or history rewrite. Preserve the user's package metadata patch and untracked NOTICE outside integration commits. | closeout-ready: pass 13 accepted, full checks rerun on the frozen snapshot; integration commit and deployment remain pending. |

## Upstream integration boundaries

| ID | Boundary | Decision / evidence | Status |
|---|---|---|---|
| U01 | FTS tokenizer/query semantics. | Approved trigram/normalization; resumable process-isolated copying. Real corpus retains all five source-table hashes, matching docsize coverage and complete integrity verification; old main can open/search/close the migrated copy. | verified; code rollback retains trigram rather than restoring unicode61 semantics. |
| U02 | Message truncation and tool-result omission. | Reject both omissions; retain full text. Indexer/parser tests preserve middle matches and embedded tool records; real copied message middle match also passes. | verified |
| U03 | Retention and reindex. | Default remains disabled; opt-in retention keeps sessions with any fresh owner and checks eligibility/deletion in one transaction. Fixture tests cover multiple owners and the no-file-metadata fallback. No production pruning or forced rebuild/backfill used as a test shortcut. | verified: config/indexer/backfill Node tests. |
| U04 | Policy-only capacity, BM25 and memory synchronization. | Retain public mutation behavior, scope and count-only reporting. Markdown remains the durable source. Startup sync covers global/current-project scopes. Recent failure injection uses that same boundary; consolidation separates scopes and parent-applies shrinking JSON plans without child write tools or project reassignment. `memory_search` normalizes limits to 1–20. | verified: Node suite covers scoped sync, malformed attribution, stale mirror cleanup, supplied slices and policy-only behavior; full closeout suite passed. |
| U05 | Lifecycle and model transport. | Retain shared compact timeout, reload behavior, cancellation, thinking-text extraction and provider auth. Check production-only direct completion paths against loopback fixtures; preserve model receipts. Shutdown settles repair cancellation before close and reports failure to close. | closeout evidence verified in Node/Bun/compiled and production-install paths; real registered deployment and current-session reload remain pending until post-commit transfer. |
| U06 | Optional startup/consolidation features. | Lazy initialization and chunked consolidation remain opt-in; inherited defaults and relevant paths tested. | verified: config/lazy-startup/consolidation Node tests. |
| U07 | Native SQLite and SDK compatibility. | Node, supported Bun/compiled paths, production-only install, SDK floor and real installed Pi loader pass without replacing global Pi. DB test fixtures that directly load better-sqlite3 remain Node-only. | verified; the broader Bun attempt crashed in a Node-native fixture and is not a passed gate. |

## Release gates

1. Every local contract and integration boundary above has a disposition and current evidence; no required behavior is inferred from historical PASS results.
2. Repository tests and relevant Node/Bun/compiled/minimum-SDK/production-loader paths pass on the final snapshot.
3. Migration from the local baseline and rollback compatibility are demonstrated on isolated databases, including copied real data where appropriate; sensitive contents never enter public artifacts.
4. `implementation-closeout` completes with fresh independent review, bounded correction cycles, updated documentation and a snapshot-bound receipt.
5. The backup ref remains intact; the original checkout's unrelated files are preserved while the integrated history is moved into local `main` without rewriting published ancestors.
6. The real folder-registered Pi package loads the integrated source and required tools behave correctly; hot reload of the current session is not assumed from a fresh-process test.
7. No external publication occurs without a separate request.

Integration evidence and model receipts are stored outside the published package in `.pi/forwardport/`. This ledger must be updated as evidence is produced.

## Current verification evidence

- `.pi/forwardport/node-review-cycle-7-final.log`: 1395 tests, all 79 files after the final source/test change. The test runner clears only `PI_PACKAGE_DIR`, preserving SDK resource isolation.
- `.pi/forwardport/bun-review-cycle-7-after-scan-split.log`: 265 tests in ten supported files. `compiled-review-cycle-7-after-scan-split.log`: compiled FTS migration, healthy reopen without rebuild, bad-trigger repair/native defaults, three search modes, cancellation and explicit guards.
- `.pi/forwardport/check-min-sdk-review-cycle-7-after-scan-split.log`, `check-review-cycle-7-after-scan-split.log`, `check-production-review-cycle-7-after-scan-split.log`, `pi-loader-review-cycle-7-after-scan-split.log`: SDK floor 0.80.6, development SDK 0.80.10, production peers, four loopback completions and isolated installed Pi loading. TypeScript uses 512 MiB; search workers retain 256 MiB. Isolated profiles are not original-folder or hot-reload proofs.
- `.pi/forwardport/db-fts-revalidation-cycle-7.json/.log`, `db-fts-revalidation-cycle-7-attempt-2.log`, `db-copy-after-cycle-7.json`, `rollback-copy-cycle-7.json`: fresh full copied FTS rebuild, cancellation/reaping and resumed completion; all five source-table hashes match, including 573692 messages and 240 memories. The full pass took 2095.5 seconds. Its 853.8 ms aggregate timer peak is retained without claiming its cause or keyboard latency. The first 60-second recreation timeout remains a failure. Initial shadow recreation now allows five minutes; ordinary chunks and search retain their 60-second deadlines.
- `.pi/forwardport/healthy-coverage-timing-cycle-7-after-scan-split.json`: healthy large-copy reopen takes 25.4 ms, exact coverage/foreign-key verification 8.83 seconds, and the operation timer peak 29.35 ms. Schema version and FTS catalog/root pages remain unchanged. Healthy coverage excludes duplicate full `quick_check`; post-rebuild verification and configured startup scans retain it. The previous 710-second healthy check remains separate.
- `.pi/forwardport/copied-corpus-search-cycle-7.json/.log`: fresh readonly copied-corpus matrix 4/0/3/0/3 and cancellation. Structured cases took approximately 28–58 seconds; maximum parent timer interval was 14.23 ms, not keyboard latency. `db-middle-match-proof.json` is historical full-text evidence; preserved complete source hashes and current synthetic middle-match regressions bind its payload preservation.
- `.pi/forwardport/deployment-memory-preflight-cycle-6.json/.log`: historical current-Markdown/240-row isolated reconciliation proof; reconciliation sources are unchanged in cycle 7. Production opens readonly/query_only only. Live rows/files can still change before deployment.
- `.pi/forwardport/review-pass-1/` through `review-pass-13-result.md` and provenance files: independent review history and current pass-13 acceptance. Pass 13 freshly closed the ownerless-window and exact/prefix evidence gaps with `59 pass`, `0 fail` across four targeted files. Commit, deployment and real registered Pi verification remain incomplete.
- `.pi/forwardport/model-search-4/receipt.json` and `functional-result.json`: historical marked public four-tool trial, not a fresh model test of this source. Current Node/Bun/loader/compiled profiles cover public synthetic behavior. `proposal-sdk-offline-cycle-5.log` retains isolated CLI tool-disable contracts on SDK 0.80.2/0.80.10 and Pi 1.0.0; its transport implementation is unchanged.
- `.pi/forwardport/review-cycle-7-verification.json`: current source/evidence hashes, original-file guards and cycle counts. Earlier failures are retained and never promoted to successful gates.

## Cycle 8 disposition before independent acceptance

+ Pass 8 findings were reproduced independently before implementation: pathname replacement of `sessionsDir`, unbounded public `memory_search` output, and the `project: null` schema mismatch.
+ Root fencing now pins the directory descriptor and `(dev, ino)` generation; all canonical readers share the pin and cleanup does not remove a valid owner after a failed generation check.
+ `memory_search` now enforces a 1 MiB UTF-8 public output budget with explicit truncation/error markers while retaining full admissible content in SQLite and Markdown. `project: null` is an explicit global-only schema value and is tested through the registered tool.
+ Focused RED/GREEN, full Node/Bun, SDK, production-install, loader, compiled and `git diff --check` evidence is recorded in the forwardport artifacts. Later passes closed the remaining owner-window, exact-prefix and wildcard-prefix regressions.

## Cycle 9 disposition before independent acceptance

+ Pass 9 independently confirmed one P1 in structured scoped `session_search`: ownerless/stale indexed candidates could consume the bounded candidate window and hide a canonical hit behind a successful empty response.
+ The RED reproduction and GREEN fix are recorded in `.pi/forwardport/history-cycle-9.md`. Structured SQL now excludes ownerless rows when a canonical root is active; unresolved canonical evidence counts as a rejected bounded candidate, and the existing ownerless regression now expects the canonical result.
+ The reviewer also identified a documentation mismatch in `docs/0.7/PLAN.md`; it now documents `target=project` and `project: null` global-only semantics.
+ Passes 10–13 closed the remaining bounded-window, exact identity and literal-prefix regressions. Pass 13 verdict is `ACCEPTED_FOR_CLOSEOUT`; implementation-closeout is now complete for the pre-commit snapshot, while commit, transfer and real registered Pi verification remain release gates.

## Pass 13 and implementation-closeout

+ The exact review snapshot is bound to `review-pass-13-snapshot.json` and `review-pass-13-freeze.json`: 198 files, snapshot SHA256 `426c5f1a36afa4760c145ad5e66684f6ce37c10f87d6b4e96668c1dd1b22b14b`, diff SHA256 `db20e1022391d2e12a2d86f7405add6395e00ff8c2f57a1fae0d11d05cd8a24e`, and status SHA256 `9b49f27dc94ab45741d433169b062b7af414b22c3cf9dab38343617496c5a942`.

+ Independent pass 13 verdict: `ACCEPTED_FOR_CLOSEOUT`; no confirmed P0/P1/P2 findings. Fresh targeted evidence: `59 pass`, `0 fail`, four files, 9.17 seconds. The unsupported Bun `--reporter=verbose` option was a command syntax error, not an implementation finding.

+ Closeout documentation was checked in the repository: `AGENTS.md`, `README.md`, `docs/0.7/PLAN.md`, and this ledger. `.task_files/` is absent. Humanizer-ru found no errors; `docs/0.7/PLAN.md` is clean, the two ledger warnings are technical punctuation, and English technical documentation was left unchanged.

+ Fresh project gates on this snapshot: `npm run check`, `npm test`, `npm run check:min-sdk`, `npm run check:production`, `bash tests/run-all.sh`, and `git diff --check` passed. The full runner reported all 81 test files passed. Production DB and Markdown were not modified; production migration and deployment are still excluded.

# Chat On Steroids v2.1.31 update worklog

Date: 2026-10-10

## Source

- Local source before merge: `f8ec9b81e53f59cb8fcd386905ec8bf414257f6b`
- Stable upstream tag: `v2.1.31` at `7933265bed6faa239b6d6a35e009748b85a348b2`
- Result: staged, uncommitted merge in the existing checkout.
- Version checks: app and extension both report `2.1.31`.

## Merge decisions

Kept local Supervisor Shunt control service, project-only command sandbox, browser isolation fixes, and related tests. Integrated upstream control API, command allowlist, model defaults, pet/runtime updates, image save support, release metadata, and native packaging updates. Resolved nine conflicts without resetting or overwriting unrelated work.

## Verification

- Focused Vitest suites: 357 passed, 13 skipped, 7 files passed.
- `tsc --noEmit -p tsconfig.json`: passed with safe system PATH.
- `npm run build`: passed.
- Public-history privacy check: passed, 230 commits and 12 tags.
- Third-party notices check: passed, 159 packages and 7 catalog entries.
- Native source packaging check: passed, 730 archives and patches.
- Full verify reached host-sensitive macOS window matching, then failed because Swift could not compile against this SDK/toolchain pair. Error included `The SDK is built with ... 6.0.3.1.5 ... compiler is ... 6.0.3.1.10` and a restricted module-cache write.

## Packaging

Attempted `npm run dist:dir:mac:arm64`. Electron, ripgrep, tunnel, and dependency staging completed. macOS desktop helper compilation stopped before electron-builder because the host Swift SDK/toolchain mismatch remained. No new candidate package was produced. Existing `release/mac-arm64` is an older `2.1.14` artifact and is not a v2.1.31 candidate.

## Limits

No commit, push, `/Applications` install, app restart, live ledger change, or secret change was performed. Final arm64 bundle and GUI smoke remain blocked by host Swift tooling and available disk space.

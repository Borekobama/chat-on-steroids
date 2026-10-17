# Local fork update to CoS 2.1.40

Integrated stable upstream v2.1.40 (429df1cdc7d4e0f7b47d8659af0f72037ec2b310), retaining local Supervisor Shunt control tasks, exact completion acknowledgements, project-only command sandbox integration, and Helium support. Upstream release ancestry is retained in Git.

## Integration

Resolved overlapping browser, config, MCP tool, and command-runtime changes. Both Firefox and Helium remain selectable. PowerShell exit-status handling is preserved inside local sandbox preparation. Config migration uses upstream's preference recovery and backup path. Core exposes both upstream usage and local supervisor completion tools. Helium's brand is untranslated; missing Helium-specific setup pictures stay absent.

The pet-overlay acceptance probe now compares its titlebar minimum in window coordinates by applying the renderer zoom factor to DOM bounds. Native drag-region and uncovered-hit checks remain unchanged.

## Evidence

- Typecheck, public-history privacy, production notices and native source inventory passed.
- macOS arm64 packaging and production native-stack smoke passed.
- macOS bundle metadata, sealing and isolated GUI startup passed. Installed app and extension payload hashes matched the package.
- Installed app and Helium companion report 2.1.40. Existing settings and sessions loaded. Local control health reports ready.
- A live GPT-6 chat sent from CoS returned its requested fixed smoke-test response and was recorded in CoS. This does not imply a Codex worker or command-containment probe.
- Initial broad verification found three merge-integration assertion failures. Corrected tool count, Helium label handling, and config preference recovery all passed targeted reruns.
- The broad rerun completed 370 suite files without failures. Renderer-state separately completed 134 cases. Renderer-timeline was rerun with verbose progress to distinguish its several-minute runtime from a teardown hang. All 316 timeline cases passed in 258.91 seconds; no teardown hang reproduced. MCP shutdown passed six cases; platform-gated native computer tests skipped.
- Real-Electron UI verification initially passed 54/55 checks. After the zoom-aware pet assertion correction, that final check passed. No production renderer change was required for the pet check.

## Network recovery

Helium initially failed DNS while system resolution worked. Selecting standard Cloudflare encrypted DNS and cleanly restarting Helium restored signed-in ChatGPT loading and successful CoS model discovery. Secure DNS remained enabled. The combined repair was verified; neither step alone was established as sufficient.

## Scope limits

No Windows/Linux runtime verification or paid Codex worker execution was performed. Slopo's automated duplication check was unavailable because its local database schema did not match the installed CLI. Historical patch references retain their original revision context.

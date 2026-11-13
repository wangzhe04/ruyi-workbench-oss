# Mac local/internal trial deployment, upgrade and recovery

Applies to Ruyi3.0.1, Apple Silicon arm64, local/internal trial channel. The current tested host runs macOS27.0.1. macOS14 remains a target pending runtime qualification. Windows follows its existing deployment instructions. This channel uses ad-hoc signing without Developer ID, Apple notarization or stapling; a checksum does not authenticate the publisher.

## Installation and first launch

Obtain a matching DMG and SHA256 from a trusted sender. Verify the checksum, open the image, copy the complete `Ruyi.app` to `/Applications` or personal `~/Applications`, wait for completion, eject the image, then open the installed App. The target machine needs no separate Node, Python, Homebrew or Xcode installation.

Downloaded applications may trigger Gatekeeper. After checking the source and checksum, follow the actual Open Anyway workflow offered in Privacy & Security, subject to device-management policy. Do not remove quarantine or disable Gatekeeper/SIP. Successful local installation under the current account does not qualify first approval of a downloaded application.

Screen recording, accessibility and microphone access require OS/user authorization. A denied permission disables the corresponding capability. A different ad-hoc build can request permissions or Keychain access again. An initialized window does not prove all desktop capabilities are authorized and ready.

## Variants and compatibility

| Capability/dependency | Full | Slim |
|---|---|---|
| Native App, bundled Node, core workbench, controlled bash and rg | Included | Included |
| Standalone Python, ACC, Office/PDF/chart dependencies | Included | Not bundled |
| Chromium/Playwright automation | Included; select bundled | Not bundled |
| Mac desktop automation | Requires ACC and actual OS permission/readiness | ACC dependencies omitted; full automation not promised |
| Models, Git, official Claude Code/Kimi Code CLI | Configure/install separately | Configure/install separately |
| Windows PowerShell overlay updates | Unavailable on Mac | Unavailable on Mac |

The system browser mode only hands off URLs. Navigation and DOM operations require correctly configured bundled/managed/custom/CDP mode and matching dependencies. Mapping a path does not make Windows or Linux executables runnable on Mac. Cloud APIs require a network; offline use requires a local or intranet model endpoint. Model weights and official agent CLIs are not included.

## Whole-App upgrade

1. Save work, stop active tasks, and quit every Ruyi instance using the data directory through Quit or Cmd-Q. Closing the window normally leaves the service running. Stop separately launched CLI services normally as well.
2. Retain the previous App and its provenance/checksums. Data normally lives in `~/.ruyi-workbench` or the explicit `RUYI_HOME`; `WIN_CLAUDE_WORKBENCH_HOME` is a compatibility input. Identify the actual data root and copy it completely to a separate protected backup location. Verify the copy and keep backups outside the App.
3. If credential encryption is enabled, separately retain the password-protected credential recovery export and recovery password. A data-directory snapshot does not include system Keychain entries, TCC grants, external workspace files or global CLI configuration. Protect backups as sensitive business data.
4. Verify the new DMG, copy the complete App to a new staging location, eject the image and check the App. Keep the previous App in a dedicated pre-upgrade folder, then put the complete new App at the installation location. If copying fails, retain the previous App and retry. Never merge App internals. This is a manual replacement workflow, not an atomic replacement guarantee.
5. Start the installed new App and check initialization, workspaces, sessions, configuration and required tools. The product version can remain the same across builds: retain the application/packager commits from `trial-manifest.json` and the DMG checksum from `distribution.json` and `.dmg.sha256`. Switching Full/Slim changes dependencies. Review absolute old-package references in the migration center.

Administrators may use system `ditto` after every instance has exited to copy the actual data directory to a **new, nonexistent destination**, then verify the files and backup inventory. A copy made while the application is running is not a consistent snapshot. Do not automatically overwrite a user directory during recovery.

## Rollback and recovery

Replacing the App alone does not roll back data. An older build may not understand data written by a newer build. An older App starting successfully does not establish backward schema compatibility.

Quit the new App, retain its complete current data and App, then restore the complete pre-upgrade snapshot into a fresh data directory. An administrator can launch the retained previous App with that directory as `RUYI_HOME` to verify sessions, settings and required capabilities before switching. Retain newer data; post-upgrade changes require separate export or reconciliation. Never let two instances write the same data root.

The current drill covers different builds of3.0.1, representative schema12-to14 forward normalization, and recovery through a complete pre-upgrade snapshot. It does not promise direct backward reading of arbitrary future schemas. Credential errors require the password-protected recovery package or re-entering credentials, without a silent plaintext fallback.

## Windows and old-directory migration

Copy workspaces to Mac and establish an explicit mapping, for example `D:\Work\Project` to `/Users/your-account/Work/Project`. Select the real workspace in Settings and review MCP commands, arguments, cwd, environment and CLI paths individually. The migration center previews old Ruyi package references with matching relative resources, backs up affected configuration files and supports undo. It does not blindly rewrite arbitrary Windows executables, drive letters or external scripts.

Mac cannot directly decrypt Windows DPAPI records. Export through the existing password-protected recovery flow in the original Windows environment, then import and rewrap with Keychain on Mac. Re-enter credentials if an export is unavailable. Retain the source directory and avoid overwriting existing Mac data. Compatibility with `~/.win-claude-workbench` and legacy data-root environment variables does not convert Windows paths or ciphertext automatically.

Windows overlay operations return an explicit unsupported-platform result on Mac; force cannot bypass it. Follow the whole-App workflow above.

## Old-package cleanup and uninstall

Retain previous Apps and backups until rollback is no longer needed. Quit the App and move the complete installed App to Finder Trash to uninstall while keeping business data. The migration center uses native Mac Trash for eligible old packages, moving the entire enclosing App for a logical workbench package. It rejects referenced/running/current packages, targets containing data or home, and unverified App layouts. Failure never falls back to permanent deletion. Inspect and restore the exact App from Finder Trash when needed; do not empty Trash prematurely.

## Administration and qualification limits

Distribute the matching DMG, `.sha256`, `distribution.json` and `trial-manifest.json` for the same variant/build. Licenses, dependency versions and native inventories ship with the App. Obtain a fresh trusted copy if verification, mounting or copying fails. Do not edit signed App internals.

Local trial qualification does not establish clean-standard-user or separate-machine readiness, macOS14 runtime support, Developer ID/notarization, downloaded-origin Gatekeeper approval, stable formal-identity Keychain/TCC upgrades, same-candidate Windows regression or the original unverified P5 environments. Consult the candidate's delivery record for actual full-regression failures, skips and applicability; this guide alone is not evidence that every gate passed.

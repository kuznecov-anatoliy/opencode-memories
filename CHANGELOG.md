# Changelog

## [1.1.0] — 2026-07-18

### Added
- Unattached session detection (syntheticName flag) — POST-COMPACTION no longer created for unnamed sessions
- Safety timer cancellation — compact timer cancels on normal completion, no unnecessary 120s wait
- Conditional compact prompt — unattached sessions get "What shall we do next?" instead of broken MEMORY link
- Defense-in-depth disposal guards — isDisposed check in systemTransform and messagesTransform handlers
- Pending state cleanup on session operations (detach, new, switch)

### Fixed
- cleanupSessionState now fully clears all timers and flags (systemTransformCalled, pendingPostCompact, isCompacting)
- systemTransformCalled map cleared on plugin dispose — prevents stale entries
- Detach now properly removes pendingPostCompact timer

## [1.0.0] — 2026-07-18

### Added
- v1.0 release — stable API, full English translation
- All plugin strings and prompts translated to English
- Comprehensive OSS documentation (README, SECURITY, CONTRIBUTING, CoC)
- CI pipeline with npm audit

### Fixed
- Type safety annotations for SDK type mismatches
- SECURITY.md contact email added
- CI: removed strict type check (known SDK incompatibility)

## [0.1.0] — 2026-07-17

### Added
- Initial release of opencode-memories plugin
- Session management with SESSION-START / SESSION-SELECT protocol
- POST-COMPACTION protocol for context preservation after session compaction
- AUTO-SAVE proposal after logical milestones
- Tool commands: state, add-decision, resolve-decision, add-problem, close-problem, rename, new, switch, attach, detach, delete, sql, cleanup
- SQLite-based storage with FTS5 full-text search
- MEMORY file generation in markdown format
- Per-session state isolation

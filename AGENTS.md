# AGENTS.md — paidan maintainer handbook

This repo is maintained mostly by AI agents. This file is your onboarding: the invariants you must not break, and the procedures for common changes. If you are an AI agent, read this whole file before editing anything.

## Invariants (do not break)

1. **Terminal judgment is evidence-first.** Deliverable evidence outranks process exit codes. `exit 0` never counts as success by itself. `unknown` is a legal terminal state. Endpoint refusal signals (e.g. agy `denied_actions`, empty final text) go into terminal evidence, not automatic failure.
2. **No cross-connection fallback.** If a model/connection fails on quota, never silently switch to another billing path. Refuse and report.
3. **Never touch user credentials.** No copying, staging, or proxying of credential material. Endpoints run against the agent's own native config.
4. **paidan never writes to an agent's native home.** If a required native setting is missing, refuse with a doctor-style repair hint; do not silently patch user config.
5. **Data never flows into the repo.** The repo contains zero machine paths and zero credentials. Machine config lives in `%APPDATA%\paidan\`.
6. **Zero runtime dependencies.** Node stdlib only (usage DB = `node:sqlite`). DevDependencies limited to `typescript` + `@types/node`. Consequence: cancel is `taskkill /T /F` on Windows — Node cannot create Job Objects without FFI, so orphaned grandchildren after a force-kill are an accepted limitation, not a planned feature.
7. **All CLI output is JSON** on stdout; human prose goes to stderr.
8. **No daemon, no telemetry, no auto-update.**

## Architecture

```
src/engine/     run-store, supervisor, terminal judgment, reconcile, redactor, usage-db, config,
                models-cache, init-plan (UI-free init/probe decisions a console GUI can reuse),
                skill-install (host skill registry + atomic copies)
src/endpoints/  per-endpoint parser code (registry.ts + spawn.ts own shared rules;
                parsers evaluated by function, one protocol per file — the retired ≤200-line
                cap is recorded in git history; current max ~260, split by concern when it
                stops being single-purpose)
                spawn.ts owns layered endpoint spawn resolution (override → PATH → npm layout → cmd shim)
endpoints/      per-endpoint data manifest (JSON): detection, command template, permission map,
                prompt delivery, output parsing type, model discovery, capability flags (+verified_at)
src/cli.js→ts   argument parsing (node:util parseArgs), one handler per verb
src/tty-select.ts  raw-mode checkbox/menu widgets for the init wizard (clack-style grammar;
                reducers are pure and unit-tested, rendering is covered by fake-TTY shell tests)
docs/contracts.md  run record schema, manifest schema, terminal state rules
```

Layering rule: engine never imports from endpoints except through the manifest registry; CLI is the only entry point; there is no global mutable state.

## How to add an endpoint

1. Create `endpoints/<name>.json` from an existing manifest as template. Fill every capability flag honestly; mark unmeasured ones `unverified` with today's date. The registry enforces these rules at load (violations = `ManifestError`): `name` must equal the filename; `command.argv[0]` must be `{bin}`; argv prompt delivery must contain `{prompt}`; `resume_argv` must start with `{bin}` and contain `{session}`; `detect.known_paths` templates must start with `{home}`/`{env:NAME}` and contain no `..`.
2. If output parsing differs from existing types, add `src/endpoints/<name>.ts` (parser only, one protocol per file).
3. Run the contract probes: `paidan probe --endpoint <name>` (P1 write / P2 read-only refusal / P3 resume). All must pass or be explicitly marked unsupported.
4. Update README endpoint notes if behavior surprises users.

## How to verify a change

- `npm run build` must be clean; `npm test` (node:test, golden fixtures for parsers + run-store round trips) must pass.
- Test isolation hooks (never point tests at the real machine config): `PAIDAN_HOME` (config+data root), `PAIDAN_DATA_DIR`, `PAIDAN_ENDPOINTS_DIR` (manifest dir), `PAIDAN_HOST_HOME` (host homes for skill install). The CLI must be run as `node dist/cli.js` — `npm run build` first, dist/ is gitignored.
- Behavior changes to an endpoint path require re-running that endpoint's probes.
- No test may require governance/CI infrastructure; probes run against locally installed agents only, and are skipped when the agent is absent.

## Version drift policy

Behavior conclusions always carry a version + date. After upgrading an agent CLI, run `paidan probe --endpoint <name>` and refresh `verified_at` fields. A parser that meets unknown output must degrade to terminal state `unknown`, not crash.

## Recalibration SOP (endpoint upgrades)

The goal is not permission governance for its own sake — it is an honest, current record of how each agent behaves when delegated, plus code/manifests that match the installed version. This loop is designed to be driven by an AI agent end to end; the agy 1.2.0 calibration (2026-09-10) is the reference execution.

1. **Detect drift**: `paidan doctor` — any endpoint version newer than its manifest `version` fields is drift.
2. **Probe**: `paidan probe --endpoint <name>` (P1 write / P2 read-only refusal / P3 resume). All pass → probe already refreshed `verified_at`; stop here.
3. **Diagnose evidence-first**: read the failed run's `result.json` (refusals / notes / final_text) from the run store, then reproduce directly with the endpoint's own binary in a tmp cwd. Never change paidan code for an upstream behavior change without a direct repro.
4. **Hypothesis-matrix the native surface**: for permission/config drift, live-test the small matrix of plausible rule/flag forms (e.g. unscoped / scoped glob / exact dir / drive-letter) and record every variant's verdict. Only forms observed working may be recorded as working.
5. **Repair with consent**: changing an agent's native home requires explicit user approval; back up beside the original (`.bak-<date>-<tag>`), change minimally, keep unrelated keys byte-identical.
6. **Record honestly**: update manifest entries with the new `version` + `verified_at` and the true status (`supported | soft | unsupported`); put capability losses in `via` and the README endpoint row (EN+ZH). Commit with the probe/repro evidence in the message.
7. **Regress before closing**: `npm test` green plus one real delegation end-to-end.

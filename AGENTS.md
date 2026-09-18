# AGENTS.md — paidan maintainer handbook

This repo is maintained mostly by AI agents. This file is your onboarding: the invariants you must not break, and the procedures for common changes. If you are an AI agent, read this whole file before editing anything.

## Invariants (do not break)

1. **Terminal judgment is evidence-first.** Deliverable evidence outranks process exit codes. `exit 0` never counts as success by itself. `unknown` is a legal terminal state. Endpoint refusal signals (e.g. agy `denied_actions`, empty final text) go into terminal evidence, not automatic failure.
2. **No cross-connection fallback.** If a model/connection fails on quota, never silently switch to another billing path. Refuse and report.
3. **paidan does not manage credentials.** The runtime never copies, stages, or proxies credential material; endpoints use their own native config. Installation-only exception: after the user approves the ZCode changes described in `INSTALL.md`, the installing agent may use the reviewed setup command to create a dedicated native provider JSON containing only the selected API provider, its model rules and default selection. Credentials and backups remain in ZCode's native directory, never in paidan config, the repo, prompts, command arguments or extra logs; paidan stores only the profile path. Why: support the requested isolated print setup without adding credential custody to the runner.
4. **Native-home writes require the user's selected scope.** paidan writes user-selected host skill files, the dedicated ZCode file from invariant 3, and explicitly selected DSH native default-model fields through setup --apply after a reviewed preview. The runtime dispatch path never writes native configuration. Agent-guided installation submits choices and location hints to the program. Shared installation logic owns persistent configuration/skill writes, backups and receipts; unsupported native changes use native settings mechanisms, never ad hoc agent-authored configuration patches (INSTALL.md). Credential transfer remains limited to the installation-only ZCode exception in invariant 3; other login/setup uses native flows. Missing settings are never silently patched by the runtime. A current-host skill destination can be approved in the combined setup summary. Why: keep setup concise while preserving control over native configuration.
5. **Data never flows into the repo.** The repo contains zero machine paths and zero credentials. Machine config lives in `%APPDATA%\paidan\`.
6. **Zero runtime dependencies.** Node stdlib only (usage DB = `node:sqlite`). DevDependencies limited to `typescript` + `@types/node`. Consequence: cancel kills in two phases (graceful `taskkill /T` or process-group SIGTERM, forced `/F` or SIGKILL after grace) — Node cannot create Job Objects without FFI, so orphaned grandchildren after a force-kill are an accepted limitation, not a planned feature.
7. **All CLI output is JSON** on stdout; human prose goes to stderr.
8. **No daemon, no telemetry, no auto-update.**

## Architecture

```
src/engine/     run-store, supervisor, terminal judgment, reconcile, redactor, usage-db, config,
                run-control (shared wait/launch/cancel settlement), errors (structured failures),
                models-cache, init-plan (UI-only question helpers), installation-files (bounded installation writes + receipt),
                skill-install (host skill registry + payloads), approved-write (shared bounded backup/atomic writer)
src/worker.ts   the detached worker: spawns the endpoint, streams stdout/stderr into the parser,
                owns events/state/result and the terminal judgment path
src/endpoints/  per-endpoint parsing and native metadata adapters;
                *-models.ts owns native discovery/defaults for Codex, Claude, Kimi, OpenCode, OMP, DSH and AGY;
                parser modules re-export the discovery hooks for the existing adapter convention;
                registry.ts = manifest types, loading, validation and probe metadata writes;
                invocation.ts = pure permissions, argv/env and substitution rules;
                adapters.ts = convention module loading and native launch preparation;
                spawn.ts = layered executable resolution (override → PATH → npm layout → cmd shim)
endpoints/      per-endpoint data manifest (JSON): detection, command template, permission map,
                prompt delivery, output parsing type, model discovery, capability flags (+verified_at),
                optional effort block (argv `arg` and/or env `env` delivery — e.g. kimi has no CLI
                flag and rides KIMI_MODEL_THINKING_EFFORT)
src/installation.ts shared installation survey/choices/plan/apply; composes endpoint metadata and engine writers
src/endpoints/installation-discovery.ts setup-only installed-app/npm-cache/location-hint discovery
src/endpoints/*-setup.ts limited native profile/settings transformations (no file writes)
src/cli.ts      entry routing, help/version, startup reconcile and error presentation
src/commands/  run.ts = run/get/cancel/list; inspect.ts = doctor/models;
                probe.ts = explicit live contract tests; setup.ts = noninteractive CLI envelope for installation.ts;
                init.ts = optional terminal UI over the same installation planner/writer;
                context.ts = CLI context and JSON envelopes. Command workflows do not import one another.
src/endpoints/inspection.ts  version/native-default reads and fresh model discovery + history snapshots
src/endpoints/selection.ts   shared model/effort/native-context checks for run and probe
src/endpoints/native-metadata.ts  bounded native queries, metadata-only binding and catalog validation
src/tty-select.ts  raw-mode checkbox/menu widgets for the init wizard (clack-style grammar;
                reducers are pure and unit-tested, rendering is covered by fake-TTY shell tests)
docs/contracts.md  run record schema, manifest schema, terminal state rules
```

Engine storage/lifecycle modules have no runtime imports from endpoints; the models cache shares only metadata types. Command workflows and the worker compose these modules with endpoint rules and adapters. There is no global mutable state.

The CLI routes to independent command workflows. Setup and init share installation.ts without importing one another. Other workflows use endpoint inspection/selection and the engine's run lifecycle; the worker uses endpoint adapters and engine storage. Engine and endpoint modules do not import command handlers. This keeps changes to inspection or installation out of normal delegation, and shares selection checks between delegation and probes instead of duplicating them.

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

1. **Detect drift**: `paidan doctor` — drift = the installed version is **not in** a manifest's verified version set (not merely "newer than"); doctor does detection + version comparison, `probe` does behavior verification.
2. **Probe**: `paidan probe --endpoint <name>` (P1 write / P2 read-only refusal / P3 resume). All pass → **confirm the `verified_at_refresh` receipt in the probe result before stopping** (manifest writes can fail); only then is the refresh done.
3. **Diagnose evidence-first**: read the failed run's `result.json` (refusals / notes / final_text) from the run store, then reproduce directly with the endpoint's own binary in a tmp cwd. Never change paidan code for an upstream behavior change without a direct repro.
4. **Hypothesis-matrix the native surface**: for permission/config drift, live-test the small matrix of plausible rule/flag forms (e.g. unscoped / scoped glob / exact dir / drive-letter) and record every variant's verdict. Only forms observed working may be recorded as working.
5. **Repair with consent**: changing an agent's native home requires explicit user approval; back up beside the original (`.bak-<date>-<tag>`), change minimally, keep unrelated keys byte-identical.
6. **Record honestly**: update manifest entries with the new `version` + `verified_at` and the true status (`supported | soft | unsupported`); put capability losses in `via` and the README endpoint row (EN+ZH). Commit with the probe/repro evidence in the message.
7. **Regress before closing**: `npm test` green plus one real delegation end-to-end.

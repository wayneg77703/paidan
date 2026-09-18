# paidan contracts

Normative schemas. Engine and adapters are written against these; changes here are breaking and require a `schema_version` bump note.

Implementation boundaries: `cli.ts` routes to `commands/run.ts` (delegation), `commands/inspect.ts` (metadata checks), `commands/probe.ts` (explicit live verification), `commands/setup.ts` (agent-guided installation), or `commands/init.ts` (optional legacy wizard). These workflows share only CLI context and lower-level functions, not one another's handlers. `engine/run-control.ts` owns shared waiting, launching and cancellation settlement; `endpoints/selection.ts` owns submission model/effort/context checks. Endpoint-specific metadata/protocols stay under `endpoints/`, while run persistence and terminal judgment stay in `engine/`. A metadata check does not dispatch a task; a probe explicitly does. This separation does not alter the CLI or persisted run schema.

Endpoint adapters may expose `validateSelection` for explicit model/effort choices when their manifest declares model discovery. Both delegation and probes call it through `endpoints/selection.ts` before creating a run, reusing the returned native snapshot instead of reading configuration again. Kimi uses this to validate current native aliases and refuse ineffective effort overrides; no validation invokes a model task or changes a user's selected route. Its `kimi-models.ts` owns discovery/default metadata, while `kimi-print.ts` owns stream parsing. Optional model metadata `effort_selectable` identifies verified adapter delivery capability, `thinking_required` identifies always-thinking models, and `native_defaults.thinking_enabled` exposes the native toggle. Declared effort options alone do not imply that the adapter can override effort for that protocol.

## 1. Run store layout

Root: `<dataDir>/runs/<run_id>/` (default `<APPDATA>/paidan/runs`).

| file | writer | contents |
|---|---|---|
| `request.json` | CLI at submit | immutable run request (schema below) |
| `state.json` | worker (also CLI cancel fallback / reconcile) | current state record, **atomic write** (tmp + rename), idempotent transitions |
| `events.jsonl` | worker | append-only event log (spawn/stdout-chunk meta/terminal judgment evidence) |
| `result.json` | worker (also CLI cancel fallback / reconcile adoption) | terminal result + evidence, written once, atomic |
| `cancel.request` | CLI at cancel | cancel marker; the worker's watcher (500 ms poll) turns it into a tree kill |
| `prompt.txt` | worker | delivered task text, only for `prompt_delivery: "file"` endpoints |

`run_id`: `run_<yyyymmdd>_<8hex>` (date = submit date, local). Idempotent submit: request fingerprint = sha256(endpoint + cwd + task text + mode); a second submit with an identical fingerprint while a non-terminal run exists returns that run instead of creating a duplicate.

## 2. request.json

```json
{
  "schema_version": "1.0.0",
  "run_id": "run_20260910_a1b2c3d4",
  "fingerprint": "sha256:...",
  "endpoint": "kimi-code",
  "cwd": "D:/work/thing",
  "add_dirs": [],
  "task_file": null,
  "task_text": "...",
  "mode": "workspace-write",
  "model": null,
  "effort": null,
  "resume_session": null,
  "run_timeout_sec": 1800,
  "deliverables": [{ "path": "probe-write.txt", "expected": null }],
  "created_at": "ISO-8601",
  "warnings": ["permission:fs.read is soft on this endpoint, verified_at 2026-09-09"]
}
```

`mode` is one of the presets `read-only | workspace-write | unattended`, or an explicit capability set `{"fs.read": {"roots": [...]}, ...}` (CLI: `--capabilities '{"shell.exec":true,"fs.write":true}'`, mutually exclusive with `--mode`). A capability whose value is `true` or an options object is required; `false`/`null` keys are not. Submit-time rule: any required capability mapped `unsupported` in the endpoint manifest → reject with `PERMISSION_UNSUPPORTED` naming the missing capabilities; `soft` → warning recorded in request.warnings. An explicit set runs the endpoint WITHOUT its preset tier flags (`command.mode_args`/`mode_env` stay unspliced — the engine cannot map an arbitrary set onto native tiers); `cwd_arg` still applies. The fingerprint canonicalizes sets (deep key sort), so key order never duplicates a run.

`run_timeout_sec` is the engine wall-clock cap for the run: the effective value is `--run-timeout` ?? config `defaults.run_timeout_sec` ?? 1800, resolved at submit and stored here; `0` disables the cap. On expiry the worker kills the endpoint tree through the cancel termination path and the terminal state is `failed` with an evidence note `run timeout after Ns`.

Optional additive fields (request schema remains 1.0.0): `native_selection` records the read-only submission-time `{connection, model, effort, profile}` configuration snapshot, not actual execution evidence. `selection_context` records the endpoint routing-context digest when model/effort overrides are used. The worker rechecks it before spawning; a change fails without execution. Older requests without these fields remain readable. `get` returns optional `recovery` on failed/unknown/attention runs or a reported selection mismatch: requested overrides, submission snapshot, and targeted diagnostic commands. It never diagnoses, switches or retries automatically.

## 3. state.json

```json
{
  "schema_version": "1.0.0",
  "run_id": "run_...",
  "state": "pending | running | completed | failed | cancelled | unknown | attention",
  "worker": { "pid": 1234, "started_at": "ISO", "pid_start": "platform start token or null", "endpoint_pid": 5678, "endpoint_pid_start": "platform start token or null" },
  "session": { "handle": "native session id or null", "resumable": true },
  "created_at": "...", "updated_at": "...", "terminal_at": null
}
```

- Terminal states: `completed | failed | cancelled | unknown`. `unknown` is legal and means "evidence insufficient; judge by result.json evidence".
- `attention` is assigned only by reconcile (see §5): a non-terminal run whose worker is gone. Reconcile never restarts anything.

## 4. result.json

```json
{
  "schema_version": "1.0.0",
  "run_id": "run_...",
  "state": "completed",
  "exit_code": 0,
  "final_text": "..." ,
  "evidence": {
    "deliverables": [{ "path": "probe-write.txt", "expected": "...", "found": true }],
    "refusals": [],
    "parser": { "type": "kimi-print-json", "degraded": false },
    "notes": []
  },
  "usage": { "input_tokens": 1, "output_tokens": 2, "cached_input_tokens": null, "cost": null, "source": "provider | endpoint-ledger | unavailable" },
  "session_handle": null,
  "terminal_at": "ISO"
}
```

Judgment order (terminal.js): deliverable evidence → endpoint refusal signals → parser-degraded flag → exit code last. A non-zero exit with complete deliverables can still be `completed` only when the endpoint manifest explicitly declares that shape; default is failed/unknown per evidence.

## 5. Supervisor & reconcile

- Submit spawns a **detached worker** (`node dist/worker.js <run_id>`); the worker spawns the endpoint process and owns events/state/result. CLI never babysits.
- Endpoint spawn resolution (Windows EINVAL-safe) is layered: machine-config override (`endpoints.overrides.<name>.bin`, may point at a JS bundle — spawned via `process.execPath`) → PATH scan (`.EXE` preferred over `.CMD` in one directory) → manifest npm layout (`detect.npm_exe` native binary preferred, then `detect.npm_entry` JS entry via node) under the shim's `node_modules` or the standard npm global roots → manifest well-known install locations (`detect.known_paths`, `{home}`/`{env:NAME}` templates so the repo stays free of machine-absolute literals) → last resort `cmd.exe /d /s /c` with caret-escaped verbatim argv (CR/LF and empty arguments are rejected outright). Doctor, probe and the worker share this one resolution path.
- Cancel: explicit only, three layers. An unconfirmed tree kill never reports `cancelled`: the run is left/kept in `attention` with `needs_attention:true` and the failure note (a `taskkill` failure once reported a phantom cancellation). ① The CLI writes a `cancel.request` marker into the run dir; the worker's watcher (500 ms poll) turns it into `terminateEndpointTree` — two phases everywhere: graceful first (`taskkill /PID <pid> /T` without `/F` on Windows, process-group SIGTERM elsewhere), forced after a 5 s grace window. ② If the worker does not reach a terminal state within 15 s of the marker, the CLI kills the endpoint tree itself (after re-verifying the recorded start token) and writes the cancelled terminal record directly (`writeCancelledDirect`; a worker that later finishes the same record wins by content, loses silently otherwise). ③ Reconcile backstops orphaned runs. Accepted limitation: Node stdlib cannot create Windows Job Objects (no FFI) and zero runtime dependencies is an invariant, so a force-killed endpoint may leave orphaned grandchildren; no native helper will be introduced for this.
- Run timeout: the worker enforces `request.run_timeout_sec` as a wall-clock cap on the endpoint process (0 = disabled); expiry reuses the cancel termination path and ends the run `failed` with the note `run timeout after Ns`.
- Reconcile runs at CLI start: scan non-terminal states, worker pid dead → state `attention` with evidence note (a 30 s spawn grace window protects just-launched runs; when the worker is gone but `result.json` already holds a terminal record, reconcile **adopts** that terminal state instead of marking `attention`). Never auto-restart.
- PID-reuse identity: a live pid does not prove the recorded process still exists. The worker records platform start tokens for itself (`pid_start`) and the endpoint (`endpoint_pid_start`) — win32 CIM `CreationDate`, linux `/proc/<pid>/stat` field 22, macOS `ps lstart`; equality is identity, formats are never parsed. Reconcile re-verifies before marking `attention` (mismatch = the recorded worker is gone); cancel re-verifies before any direct `taskkill` (mismatch = already gone, never killed). Query failure or an old record without tokens degrades to pid-only liveness, with a note in events/result — never a crash.

## 6. Endpoint manifest (`endpoints/<name>.json`)

```json
{
  "schema_version": "1.0.0",
  "name": "kimi-code",
  "family": "kimi",
  "detect": { "bin": "kimi", "version_args": ["--version"], "version_re": "kimi[^0-9]*([0-9.]+)",
              "npm_exe": "@scope/pkg/.../bin/real.exe", "npm_entry": "@scope/pkg/cli.js",
              "known_paths": ["{env:ProgramFiles}/App/resources/cli.cjs", "{home}/.tool/bin/cli.js"] },
  "command": {
    "argv": ["{bin}", "-p", "{prompt}", "--output-format", "stream-json"],
    "prompt_delivery": "stdin | argv | file",
    "resume_argv": ["{bin}", "exec", "resume", "{session}", "-"],
    "mode_args": { "workspace-write": ["--some-native-write-flag"] },
    "cwd_arg": null,
    "prompt_cwd_hint": true,
    "env": { "KIMI_CODE_HOME": "{native_default}" }
  },
  "permission": {
    "fs.read":    { "status": "supported", "via": "...", "verified_at": "2026-09-09", "version": "0.42.0" },
    "fs.write":   { "status": "supported", "via": "..." },
    "shell.exec": { "status": "supported", "via": "..." },
    "net.fetch":  { "status": "supported" },
    "interact.ask": { "status": "unverified" },
    "presets": { "read-only": "unsupported", "workspace-write": "supported", "unattended": "supported" },
    "denial_evidence": { "status": "supported|soft|unsupported", "via": "..." }
  },
  "resume": { "kind": "flag", "args": ["--resume", "{session}"], "cross_process": true, "notes": "..." },
  "models": { "command": null, "parse": "kimi-native-config", "connections": [] },
  "effort": { "options": ["low", "high"], "arg": ["--effort", "{effort}"], "default": null,
              "status": "supported", "verified_at": "2026-09-10", "version": "2.1.260" },
  "parser": "kimi-print",
  "native_preflight": { "file": "{home}/.tool/settings.json", "require_allow": ["read_file(*)"] },
  "capabilities": { "background_native": false, "cancel_native": false, "max_run_sec": 1800 }
}
```

`native_preflight` (optional) declares a native settings file and the allow rules an endpoint needs (`{"file": "{home}/.../settings.json", "require_allow": [...]}`; `file` follows the `known_paths` template rules). The engine only ever reads it: `doctor` reports `ok | {missing: [...]} | unreadable` per endpoint, and `run` records a request warning when rules are missing — never a refusal, never a write (invariant 4).

`models` governs model discovery: `parse` is only a provenance label stored in the cache entry's `source` — the discovery code always lives in the endpoint's `parser` module (`discoverModels()`), never in a separate `<models.parse>` module. `models.command` is documentation-only (no code reads it; discovery implementations choose their own mechanism — native config read, CLI query, etc.).

`{model}` and `{session}` argv substitutions are charset-validated before splicing (`/^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,127}$/`, which also rules out a leading `-`): a model alias from discovery/cache or a session handle from endpoint output that fails the check is rejected (`MANIFEST_INVALID` at submit, run `failed` with a note in the worker) instead of being spliced into argv. Models additionally accept a trailing `[1M]`/`[200K]` context suffix (case-insensitive); session validation is unchanged. No arbitrary bracket expressions or shell syntax are allowed. Model discovery results failing the model-specific check are dropped with a note.

`capabilities.max_run_sec` (optional number|null) is documentation-only: the endpoint's own total-time cap (omp's native 30m → `1800`; dsh has none → `null`, the engine cap backstops). The enforcing timeout is always the engine's `run_timeout_sec` (§2).

`effort` (optional object) declares an effort/intensity selection: `{"options": [...], "arg": ["--effort", "{effort}"], "env": {"VAR": "{effort}"}, "default": null, "status", "verified_at", "version", "notes"}`. `options` are the accepted values (each must survive argv substitution), except when `allow_custom: true` explicitly permits other safe names. OpenCode uses this for provider/model-defined variants; the list is then examples, not a model compatibility guarantee. `doctor.effort_accepts_custom` / `effort_options_scope` explain the distinction. Delivery is argv (`arg`, spliced with `{effort}` replaced after `model_arg`, fresh and resume alike) and/or env (`env`, values contain `{effort}`, applied by buildEnv on top of `command.env`/`mode_env`) — at least one form must exist. Absent block = the endpoint has no effort selection and any configured effort is an error. The effort resolves as `--effort` ?? `defaults.efforts[endpoint]` ?? null (native default; no global fallback key either); submit rejects an endpoint without a block (`EFFORT_UNSUPPORTED`) or a value outside `options` (`EFFORT_INVALID`). Declared today: claude-code `--effort` (low/medium/high/xhigh/max), codex `-c model_reasoning_effort=` (minimal/low/medium/high/xhigh, argv form; the local config may additionally enable quota-heavy max/ultra — live-verified once, kept out of the picker), kimi-code `KIMI_MODEL_THINKING_EFFORT` (low/high/max, env form — 0.42.0 has no CLI flag; the env var overrides the native config's `[thinking]`-section `effort` key), omp `--thinking` (off/minimal/low/medium/high/xhigh/max/auto), opencode `--variant` (provider/model-specific, including custom names from native configuration). AGY model IDs can encode effort; its newer independent native flag remains unverified and is not exposed by paidan. DSH and ZCode have no paidan effort overrides. ZCode choices live in native provider JSON.

`status` ∈ `supported | soft | unsupported | unverified`. `soft` = endpoint claims it but enforcement is doubtful (e.g. intent-only modes); always surfaces as a submit warning.

`command.mode_args` splices per-preset flag fragments (e.g. codex `-s read-only` vs `-s workspace-write`, claude `--permission-mode …`); a manifest that declares `mode_args` must cover every preset its permission map marks supported. `command.cwd_arg` (optional array, `{cwd}` → run cwd) is consumed by buildArgs and spliced **after** `mode_args`, so a subcommand riding in `mode_args` (codex `exec`, opencode `run`) stays left of the cwd flag — the "security-critical flags never land in the wrong position" invariant. `command.mode_env` (optional per-preset env map, e.g. dsh `read-only` → `DSH_PERMISSION_MODE=read-only`) is spliced by buildEnv on top of static `env`; partial coverage is normal (only tiers needing an env override declare it).

`command.model_arg` (optional array, `{model}` → the configured model) is the endpoint's **headless model selection**: when present, a configured model is spliced with it (after validation); when **absent**, the endpoint takes no model on its command line (its native config owns the model — dsh, zcode) and any configured model is a submit-time `MODEL_UNSUPPORTED` error naming the repair, not a silent drop. The init wizard reads the same flag: `model_selectable = model_arg !== undefined` gates the per-endpoint default-model prompt and validation. The `effort` block (defined below) follows the same pattern: an absent block means no headless effort selection (`EFFORT_UNSUPPORTED` when configured).

`command.env` value sentinels: `"{native_default}"` = never set the variable; `"{unset}"` = delete the inherited variable (opencode strips `PWD`, which otherwise re-anchors the project root). Keys starting with `_` are documentation and are never exported to the child process.

ZCode runtime preparation locates the public bundled provider catalog relative to the selected entry and, only when no explicit value exists, supplies `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` to the child. It never searches another installation or changes native settings/credentials. Doctor exposes `runtime_resources`; a missing/invalid explicit path is reported, not replaced. Version probes alone do not exercise this runtime dependency. Failed/unknown runs retain at most 4096 characters of redacted stderr in evidence notes; redaction occurs before truncation.


`command.prompt_cwd_hint` (optional boolean, default false): the worker appends one fixed line — `The current working directory is <request.cwd>. Use absolute paths for all file operations.` — to the delivered task text on every delivery form (argv/stdin/file) and equally on resume (`resume_argv` `{prompt}`). `request.json` stores the original text and the fingerprint is unchanged (cwd is already inside it); `events.jsonl` records a `prompt_cwd_hint appended` note. For endpoints whose tools ignore the spawn cwd — agy 1.2.0 `run_command` starts in its own scratch dir, so deliverables only land reliably via absolute paths.

`command.prompt_max_bytes` (optional positive number, default 24000): only for `prompt_delivery: "argv"`. At submit the engine builds the final argv (hint included) and rejects with `TASK_TOO_LONG` when the command line (bin + space-joined args) exceeds the limit in UTF-8 bytes — Windows CreateProcess caps it at 32767 chars and a 26 KiB prompt has died in practice. The error names the endpoint's delivery form and the limit and suggests a shorter task or a stdin/file-delivery endpoint.

`command.resume_argv` (optional) fully replaces `command.argv` on resume runs: `{session}`/`{prompt}` are substituted and `model_arg` is still spliced, but `mode_args`/`add_dir_arg` are not (a resumed session restores its original tier — e.g. `codex exec resume` accepts neither `-s` nor `--add-dir`). Without `resume_argv`, `resume.args` flags are spliced and `mode_args` are re-passed (claude semantics). `detect.npm_exe`/`npm_entry` are package-relative paths under the npm install tree (never machine-absolute), used when PATH exposes only a script shim. `detect.known_paths` (optional) lists well-known per-platform install locations as templates that must start with `{home}` or `{env:NAME}` and contain no `..`; unset env tokens skip the candidate, and a hit resolves with `resolved_from: "known-path"`.

Parser modules are convention-loaded: `parser: "<name>"` resolves to `src/endpoints/<name>.ts` exporting `createParser()` + `detectRefusals(stderrText, exitCode)` (+ optional `discoverModels()`). Parse results carry `refusals: string[]` for in-band refusal evidence (claude `permission_denials`, codex in-band error items); the worker merges them with `detectRefusals` output into `result.json` evidence — refusal is evidence, never automatic failure. Adding an endpoint = one manifest + one parser module + golden fixtures; no engine file changes.

ZCode always uses print. endpoints.overrides.zcode.provider_config is an optional absolute path to an approved native provider JSON, captured as request.provider_config at submission and passed only through child ZCODE_PERSONAL_PROVIDER_CONFIG_FILE. It contains no credential material in paidan config. Missing/invalid profiles fail without native fallback. Explicit run --native bypasses the profile and model/effort defaults for that invocation; a prior failed task is never automatically resubmitted. models --native surveys original native configuration without running ZCode. Former zapi_ handles cannot resume through print.

result.evidence.selection reports expected, actual provider/model/effort, source (native-ledger or unavailable), matches_expected, and notes. Actual rows are correlated by sessionId + traceId + turnId, including resume. Unknown schemas/missing evidence remain unknown; no historical/config-only inference. Native mismatch is reported independently of task/deliverable completion and never described as verified pinning. The installer alone may create a selected-provider copy in the native directory after approval; runtime code never copies credentials.

## 7. CLI verbs (output always JSON)

`run | get [--wait] [--timeout s] | cancel | list | models [--refresh] | doctor | probe | init [--yes [--effort <level>] [--hosts <names>]] | help [<verb>] | --version`

`run` selects the permission tier with `--mode <preset>` (explicit flag → `defaults.modes[endpoint]` → manifest `permission.default_mode` → legacy workspace-write fallback) or `--capabilities '<json>'` (explicit set; mutually exclusive with `--mode`, see §2), bounds wall time with `--run-timeout <秒>` (`0` disables, see §2), and refuses over-long argv prompts with `TASK_TOO_LONG` (§6 `prompt_max_bytes`). The model resolves as `--model` ?? `defaults.models[endpoint]` ?? endpoint native default (there is deliberately NO global fallback key — it poisoned endpoints with no headless model selection; never a cross-connection fallback) — a resolved model against an endpoint with no `command.model_arg` is refused with `MODEL_UNSUPPORTED` naming the repair (the endpoint's native config owns the model). The effort resolves as `--effort` ?? `defaults.efforts[endpoint]` ?? null (native default; `EFFORT_UNSUPPORTED` when the endpoint declares no effort block, `EFFORT_INVALID` for a value outside its `options`, §6). "Native default" is a real, observable value, not a black box: `doctor` and the init wizard carry a **read-only native-defaults probe** (`native_defaults` / `InitEndpointInfo.native`; parser modules may export `readNativeDefaults()` — top-level config keys only, never written). **It is a snapshot implemented for a subset of endpoints** — `null` can mean unimplemented or read failure, not necessarily the effective value; Kimi includes the inherited KIMI_MODEL_THINKING_EFFORT override; Claude reports relevant home/environment defaults and unresolved conflicts. OMP reports the inherited profile and queried native thinking default while its model role remains unresolved. OpenCode explicitly reports unresolved effective defaults rather than selecting the first catalog entry. DSH reports the file snapshot, not merged profile/plugin state. The wizard's first effort choice renders it, e.g. `(native default, currently max)`. A run whose endpoint would spawn through a cmd.exe shim is refused with `SPAWN_UNSUPPORTED` when `prompt_delivery` is `argv` — npm `.cmd` shims pass arguments through a bare `%*`, which re-splits them on spaces and lets the task text smuggle real CLI flags (verified empirically); the refusal names the repair (`endpoints.overrides.<name>.bin` pointing at the native binary/JS bundle, or installing so a native exe is on PATH). The same check backstops inside the worker (run ends `failed` with a `spawn-refused` event) for paths that bypass submit. Fingerprint dedup (§1) covers endpoint+cwd+task+mode only: a re-submit that changes model/effort/resume-session/add-dirs/deliverables/run-timeout returns the original run with a warning naming every differing field (cancel it first if the changes matter).

Error codes (CLI envelope `error.code`; worker fail codes land in `result.evidence.notes` as `<code>: <message>`):

| CLI | worker | meaning |
|---|---|---|
| `ARGS_INVALID` | | flag/positional misuse (incl. parseArgs rejections) |
| `ENDPOINT_REQUIRED` / `ENDPOINT_UNKNOWN` / `ENDPOINT_DISABLED` | | no usable endpoint (flag/config/enabled) |
| `CONFIG_INVALID` | `MANIFEST_LOAD_FAILED` | config.json invalid / a manifest failed to load |
| `PERMISSION_UNSUPPORTED` | | mode/capabilities the endpoint cannot enforce |
| `MODE_INVALID` / `TASK_REQUIRED` / `TASK_TOO_LONG` | | mode name / missing task / argv over the byte guard |
| `MODEL_UNSUPPORTED` / `MODELS_QUERY_FAILED` / `UNSUPPORTED` | | model the endpoint cannot take / discovery failed / no such feature |
| `EFFORT_UNSUPPORTED` / `EFFORT_INVALID` | | endpoint has no effort block / value outside its options |
| `SPAWN_UNSUPPORTED` | `SPAWN_UNSUPPORTED` | cmd-shim + argv delivery refused (submit / worker backstop) |
| `RUN_NOT_FOUND` | | no such run_id |
| `WORKER_SPAWN_FAILED` | `SPAWN_FAILED` / `ENDPOINT_BIN_NOT_FOUND` | worker failed to launch / endpoint failed to spawn |
| `INIT_INTERACTIVE_REQUIRED` / `INIT_ABORTED` | | init needs a TTY / init aborted by user (exit 130) |
| `MANIFEST_INVALID` | `MANIFEST_INVALID` / `WORKER_ERROR` | manifest rule violated / worker crashed |
| `INTERNAL` | | anything unclassified (report it) |

**Installation ownership:** setup and init share `installation.ts` for discovery and scoped configuration planning, and `engine/installation-files.ts` for writing/recording. Omitted endpoint fields preserve saved values and bindings; explicit choices update only that endpoint. `init --yes` adds uniquely resolved endpoints and preserves the existing default/model/effort/context; `--effort` is an explicit change, not a reset. Interactive deselection disables only endpoints shown in that UI. Unavailable endpoints and unrelated configuration remain intact.

- `doctor [--endpoint <name>]...`: endpoint detection results (all manifests by default, or only the selected names, each with an `enabled` flag; unknown names are rejected before probing). Filtering skips unselected endpoints' version/native-state probes while retaining global configuration and host diagnostics. Results include versions, **drift** (installed version ∉ any manifest-declared version — the recalibration trigger), permission map status, effort options, native_preflight outcome, **native_defaults** (read-only probe: the model/effort each endpoint's own home currently carries, plus `credential_ready` where a precheck exists; zcode reports `null` (unverified), because a model string or config/env presence does not prove authentication), host skill install state, config/data dir paths, db status, models-cache ages, and a human-readable `issues` summary. `ok:true` only means the doctor ran — read the per-endpoint fields. `spawn_supported` covers launch-method compatibility only (in particular cmd-shim + argv is false), not authentication or task success; version failures and launch refusals carry `repair_hint`. `model_selectable` and `configured_defaults` support agent-guided configuration; `issues` also reports unknown endpoint names, disabled defaults, and unsupported model/effort defaults. `package_root` and `hosts[].source` / `target` locate the exact packaged skill variants for independent installation. This is the compatibility-matrix generator.
- `probe`: per endpoint, P1 write / P2 read-only refusal / P3 resume contract probes against the installed agent; verdicts are `pass | fail | skip | indeterminate` (P2 "no file" alone proves nothing — pass requires a terminal task AND attributable refusal evidence; auth failures/timeouts/parser misses are indeterminate). Each leg reports its `run_ids`; a wait timeout cancels the run before reporting and keeps the scratch cwd while anything may still execute; `--timeout` is validated. `verified_at_refresh` in the receipt records whether the manifest write actually happened (a global npm install dir may be read-only).
- `models`: queries the current discovery source on every call; `--refresh` remains accepted but is no longer necessary. Successful queries write a historical snapshot to `<dataDir>/models-cache/<endpoint>.json` (`{schema_version, endpoint, fetched_at, version, source, models, connections?, notes}`) and return `from_cache: false`. A failed query reports `MODELS_QUERY_FAILED` rather than serving candidates from a possibly different previous connection; the historical snapshot is not deleted. A successful empty result replaces it. Codex uses the selected CLI's `debug models` visible catalog with per-model efforts, plus `native_defaults`, `configured_defaults`, and `selection_context`. Native catalog/config sources are labelled; custom providers without their own native catalog expose only configured candidates. Unsupported profile resolution remains unknown, and auth.json presence alone never implies login type. Candidates are not authentication/quota/access guarantees. Native query failure exposes only labelled current configuration candidates and a diagnostic note, never historical paidan cache entries.
  Model entries retain `alias` / `connection` and may add `source` (`native-config`, `desktop-config`, `native-catalog`, `static-alias`), `effort_options`, `default_effort`, and `resolved_model`. Missing/null effort options mean unknown; an explicit empty list means no declared selectable levels. `connections` describes native IDs/labels, source and configuration-only auth/access type; it never contains keys/tokens or guarantees readiness. Kimi whitelists native provider JSON instead of guessing alias prefixes; OMP preserves per-model thinking; OpenCode parses verbose model variants. ZCode keeps CLI and desktop scopes separate and uses newer desktop rules instead of reviving legacy entries when rules exist; rule inventories are incomplete overlays, not an effective CLI catalog. Claude aliases can be remapped; AGY catalog IDs do not prove Google OAuth.

- `get --wait`: blocks until terminal, `--timeout`, or `attention` — attention means the worker is gone and reconcile flagged it (or the waiting loop saw the worker pid die); it returns immediately with `terminal:false` instead of hanging. Nothing ever auto-restarts.
- Agent-guided setup is the primary installation flow; see `INSTALL.md`. The agent asks once which endpoints to connect, adopts a single valid candidate after showing it, asks about multiple installations, and pins full entry paths in `endpoints.overrides`. Native model/effort defaults are the normal path (existing explicit fixed choices are preserved); current model menus and per-model effort choices are queried and shown during installation. It merges approved choices and copies the current host skill from one confirmation, then performs grouped basic checks. Real model calls are opt-in, not an installation gate; skipping verification or pending login/quota does not disable the endpoint. ZCode dedicated profile creation is an installation-only setup operation after explicit approval of its preview, not a runtime dispatch feature. It does not call init to install skills or reselect defaults.
- `init`: optional terminal UI using the same discovery, planner and writer as setup. It offers endpoint/default/model/effort/host choices and accepts an exact entry for unresolved installations; ambiguous installations are never selected by version. No TTY returns INIT_INTERACTIVE_REQUIRED and a read-only inventory. Aborting writes no configuration, model caches or receipts. Both setup and init skip startup run reconciliation. `--yes` adds uniquely resolved endpoints, preserving saved choices; `--hosts` restricts host skills. New fixed choices are validated through the shared planner. Custom differing skills are refused before application, and backup/write failures are reported with completed operations. UI question helpers live in engine/init-plan.ts; it no longer constructs or merges config.json independently.

## 8. usage.db (node:sqlite)

Table `usage(run_id TEXT PRIMARY KEY, endpoint TEXT, connection TEXT, model TEXT, input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER, cost REAL, source TEXT, recorded_at TEXT)`. `source` ∈ `provider | endpoint-ledger | unavailable` — three-state, never fabricate zeros. `provider` = the endpoint's own output stream carried usage; `endpoint-ledger` = observed from the endpoint's native on-disk ledger (kimi: `<KIMI_CODE_HOME|~/.kimi-code>/session_index.jsonl` → `<sessionDir>/agents/*/wire.jsonl` `usage.record` rows, summed). Resume runs are summed from a pre-spawn byte cursor the worker captures per wire file (bytes after the cursor are this run's delta; wires created during the run are summed whole); a resume run without a cursor stays honestly `unavailable`. No cross-connection aggregation games: accounting is per connection. `connection` is derived from the model alias: the segment before the first `/` (e.g. `deepseek/deepseek-v4-flash` → `deepseek`), NULL when the alias has no `/` (claude/codex-style aliases today) — no cross-connection inference beyond that prefix. `cost` mirrors `result.json` usage.cost: the provider-reported total (claude `total_cost_usd`), NULL for endpoints without a cost concept (kimi ledger and every other endpoint today).

### Headless permission defaults

“Follow native” refers only to connection/model/effort. Permissions and interactive approval handling are separate. Each built-in manifest declares permission.default_mode and headless_notes: workspace-write for seven endpoints, unattended for ZCode. Native interactive defaults such as Codex on-request must not replace the adapter’s noninteractive invocation (Codex approval_policy=never; Claude permission-prompts=none). Other adapters retain their native headless mappings, including DSH’s environment-only read-only option and absence of unattended, and AGY’s native allow-rule prerequisites. No automatic approval bridge is provided.

User config defaults.modes maps endpoint names to read-only/workspace-write/unattended. It is preserved by init along with other machine preferences; it is not a wizard-owned key. Explicit --mode wins; --capabilities remains a separate explicit selection and does not inherit this preset. Unsupported configured/explicit modes are rejected, never replaced by a broader default. Doctor reports permission.default_mode, default_mode_source and headless_notes, plus configured_defaults.mode. Codex resume still restores the prior session sandbox; changing a default does not rewrite an existing session.

### Maintenance and existing user files

INSTALL.md / INSTALL.en.md define agent-led package update, upstream CLI adaptation and uninstall. They do not rerun init. The shared writer maintains install-receipt.json next to config.json, merging actual completed files and their ownership/hashes/versions/backups. The config entry also records selected CLI paths, discovery sources and CLI versions. Partial failures retain completed writes, other entries survive scoped maintenance, and malformed receipts are refused before application. Agents never assemble the receipt; it contains no credentials and never constitutes deletion authorization. Native configurations/data/history are preserved by default; rollback is field-scoped and refuses uncertain later edits.

The legacy skill installer leaves identical files unchanged and refuses different existing content unless its caller supplies the SHA-256 of the specifically approved old bytes. Approved replacement first makes a unique backup and checks for intervening changes. Target paths must stay within the selected host skill root and links inside that tree are refused. New-file installation uses an exclusive hard link to publish complete bytes without replacing a competing file. Installation stops before writing on a skill conflict, and reports completed operations if a later write fails. Agent-led installation uses the program writer rather than manual copies.

Claude permission-prompts=none suppresses questions without revoking existing allow rules. Its read-only preset is unsupported and rejected before spawning, including when native/project settings already allow writes. The adapter preserves those settings; only workspace-write and unattended have callable mappings.

### Bound selection and one-run native defaults

`models.bind_selection: true` opts an endpoint into configuration binding (currently Codex, Claude Code, OpenCode, OMP and AGY). `defaults.selection_contexts.<endpoint>` is the opaque `sha256:<64 hex>` context from the current `models` response, approved alongside `defaults.models.<endpoint>` / `defaults.efforts.<endpoint>`. It covers readable native routing fields, config home, selected entry, profile routing fields, explicit auth-mode markers and routing environment, excluding credential values. Changed or unbound fixed defaults fail with `SELECTION_RECONFIRM_REQUIRED` before creating a run. The explicit `--selection-context` flag confirms a current one-run choice; it never persists or silently updates the saved baseline. Explicit overrides that do not consume saved defaults bind to the current snapshot. Partial overrides still consume any remaining saved default and must pass its context check. The context is configuration evidence, not a guarantee of actual provider/account/model use; unresolved policy/project/profile layers remain noted.

`run --native` is available to every endpoint and bypasses saved model and effort defaults together. For ZCode it also bypasses the dedicated provider JSON. It is incompatible with model/effort/context flags and never changes saved configuration or permissions. Old requests remain readable; existing fixed defaults on these endpoints without a context require one explicit user re-selection after upgrade. Agent-guided installation writes the approved context with the selection.

OpenCode and OMP validate fixed model/effort pairs against their current native catalog before dispatch. AGY validates the full native model ID, whose suffix may already encode effort; it does not add an effort flag. Their native metadata binding excludes credential values and runs again before worker spawn; task-directory context is preserved. DSH displays a limited, explicitly configured settings snapshot and leaves selection in native custody. OMP native fallback/account rotation is reported, not silently overridden; these snapshots do not prove the actual billing account. Upstream references: [OpenCode providers](https://opencode.ai/docs/providers/), [OMP native model roles](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/config/model-roles.ts).

### Agent-facing setup

setup --endpoint <name> (repeatable) inventories every known installation, realpath-deduplicated, and queries menus only for a unique or explicitly chosen valid entry. It skips startup reconciliation and does not write paidan configuration or model caches. setup --choices <file> previews a scoped merge. choices has endpoints (bin/locations/enabled/native/model/effort/provider/mode/native_settings), optional default_endpoint and hosts; provider is ZCode-only. Exact IDs or unique native display names resolve; fuzzy guesses never do. Omitted fields preserve existing settings, null model/effort follows native, native:true clears the endpoint overrides as a group. Only selected endpoints are enabled/changed; unrelated configuration survives. Skill-only choices use endpoints:{}. enabled:false disables only that endpoint without dropping its saved selection; default_endpoint:null clears the default. mode writes a validated permission preset, null restores its native adapter default. DSH native_settings explicitly edits provider/model/reasoningEffort in an ordinary settings.yaml block and discloses the effect on other native sessions; unsupported YAML is refused, and these are not paidan runtime overrides.

The preview lists nonsecret decisions/file actions and an opaque confirmation. After user approval, --apply --expect <confirmation> rechecks current inputs/targets, backs up replacements and publishes files atomically. An already applied choice is a no-op. Custom differing skills require an explicit replace:true choice. ZCode creation copies only the selected enabled API provider and both provider-specific model rule arrays inside its native directory. Source/desktop settings remain untouched, credentials never appear in preview/config/logs. Source/target links are refused with SETUP_UNSAFE_TARGET. This is not a multi-file transaction: a later I/O failure returns completed writes and backups without deleting user files. The run workflow and worker do not depend on setup. Existing cmd/bat entries are supported for stdin delivery, matching dispatch; argv delivery requires a native binary or Node entry.

`setup --location <directory-or-file>` (repeatable for one endpoint) accepts agent/user search hints. Discovery normalizes and deduplicates actual entries, leaving multiple installations for user choice. ZCode searches Windows installation records/shortcuts and validates companion resources relative to the selected bundle; custom drives are supported. DSH checks the native home, npm package layouts and the actual npm cache’s _npx packages, verifying package identity and entry presence. Discovery never downloads or switches to a replacement cache entry. Runtime continues to use the exact saved bin. The installation record preserves its original discovery source.

An entry whose version command fails remains selected and carries version_error; application returns SETUP_VERSION_FAILED, distinct from ambiguous or missing entry selection. Candidates that disappear during path resolution are skipped without aborting the remaining inventory. Windows installation target ancestry comparisons follow the platform's path casing rules and terminate at the filesystem root.

# paidan contracts

Normative schemas. Engine and adapters are written against these; changes here are breaking and require a `schema_version` bump note.

## 1. Run store layout

Root: `<dataDir>/runs/<run_id>/` (default `<APPDATA>/paidan/runs`).

| file | writer | contents |
|---|---|---|
| `request.json` | CLI at submit | immutable run request (schema below) |
| `state.json` | worker | current state record, **atomic write** (tmp + rename), idempotent transitions |
| `events.jsonl` | worker | append-only event log (spawn/stdout-chunk meta/terminal judgment evidence) |
| `result.json` | worker | terminal result + evidence, written once, atomic |

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
  "created_at": "ISO-8601",
  "warnings": ["permission:fs.read is soft on this endpoint, verified_at 2026-09-09"]
}
```

`mode` is one of the presets `read-only | workspace-write | unattended`, or an explicit capability set `{"fs.read": {"roots": [...]}, ...}`. Submit-time rule: any required capability mapped `unsupported` in the endpoint manifest → reject with an error naming the missing capability; `soft` → warning recorded in request.warnings.

## 3. state.json

```json
{
  "schema_version": "1.0.0",
  "run_id": "run_...",
  "state": "pending | running | completed | failed | cancelled | unknown | attention",
  "worker": { "pid": 1234, "started_at": "ISO", "endpoint_pid": 5678 },
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
  "usage": { "input_tokens": 1, "output_tokens": 2, "cached_input_tokens": null, "source": "provider | endpoint-ledger | unavailable" },
  "session_handle": null,
  "terminal_at": "ISO"
}
```

Judgment order (terminal.js): deliverable evidence → endpoint refusal signals → parser-degraded flag → exit code last. A non-zero exit with complete deliverables can still be `completed` only when the endpoint manifest explicitly declares that shape; default is failed/unknown per evidence.

## 5. Supervisor & reconcile

- Submit spawns a **detached worker** (`node dist/worker.js <run_id>`); the worker spawns the endpoint process and owns events/state/result. CLI never babysits.
- Endpoint spawn resolution (Windows EINVAL-safe) is layered: machine-config override (`endpoints.overrides.<name>.bin`, may point at a JS bundle — spawned via `process.execPath`) → PATH scan (`.EXE` preferred over `.CMD` in one directory) → manifest npm layout (`detect.npm_exe` native binary preferred, then `detect.npm_entry` JS entry via node) under the shim's `node_modules` or the standard npm global roots → manifest well-known install locations (`detect.known_paths`, `{home}`/`{env:NAME}` templates so the repo stays free of machine-absolute literals) → last resort `cmd.exe /d /s /c` with caret-escaped verbatim argv (CR/LF and empty arguments are rejected outright). Doctor, probe and the worker share this one resolution path.
- Cancel: explicit only. v0 transition: `taskkill /PID <pid> /T /F` on Windows, process-group kill elsewhere; Windows Job Object-based reaping is the planned replacement (documented gap, not a bug).
- Reconcile runs at CLI start: scan non-terminal states, worker pid dead → state `attention` with evidence note. Never auto-restart.

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
  "models": { "command": ["{bin}", "..."], "parse": "kimi-models", "connections": [] },
  "parser": "kimi-print",
  "capabilities": { "background_native": false, "cancel_native": false }
}
```

`status` ∈ `supported | soft | unsupported | unverified`. `soft` = endpoint claims it but enforcement is doubtful (e.g. intent-only modes); always surfaces as a submit warning.

`command.mode_args` splices per-preset flag fragments (e.g. codex `-s read-only` vs `-s workspace-write`, claude `--permission-mode …`); a manifest that declares `mode_args` must cover every preset its permission map marks supported. `command.cwd_arg` (optional array, `{cwd}` → run cwd) is consumed by buildArgs and spliced **after** `mode_args`, so a subcommand riding in `mode_args` (codex `exec`, opencode `run`) stays left of the cwd flag — the "security-critical flags never land in the wrong position" invariant. `command.mode_env` (optional per-preset env map, e.g. dsh `read-only` → `DSH_PERMISSION_MODE=read-only`) is spliced by buildEnv on top of static `env`; partial coverage is normal (only tiers needing an env override declare it).

`command.env` value sentinels: `"{native_default}"` = never set the variable; `"{unset}"` = delete the inherited variable (opencode strips `PWD`, which otherwise re-anchors the project root). Keys starting with `_` are documentation and are never exported to the child process.

`command.resume_argv` (optional) fully replaces `command.argv` on resume runs: `{session}`/`{prompt}` are substituted and `model_arg` is still spliced, but `mode_args`/`add_dir_arg` are not (a resumed session restores its original tier — e.g. `codex exec resume` accepts neither `-s` nor `--add-dir`). Without `resume_argv`, `resume.args` flags are spliced and `mode_args` are re-passed (claude semantics). `detect.npm_exe`/`npm_entry` are package-relative paths under the npm install tree (never machine-absolute), used when PATH exposes only a script shim. `detect.known_paths` (optional) lists well-known per-platform install locations as templates that must start with `{home}` or `{env:NAME}` and contain no `..`; unset env tokens skip the candidate, and a hit resolves with `resolved_from: "known-path"`.

Parser modules are convention-loaded: `parser: "<name>"` resolves to `src/endpoints/<name>.ts` exporting `createParser()` + `detectRefusals(stderrText, exitCode)` (+ optional `discoverModels()`). Parse results carry `refusals: string[]` for in-band refusal evidence (claude `permission_denials`, codex in-band error items); the worker merges them with `detectRefusals` output into `result.json` evidence — refusal is evidence, never automatic failure. Adding an endpoint = one manifest + one parser module + golden fixtures; no engine file changes.

## 7. CLI verbs (output always JSON)

`run | get [--wait] | cancel | list | models [--refresh] | doctor | probe | init [--yes]`

- `doctor`: endpoint detection results, versions, permission map status, config/data dir paths, db status, models-cache ages. This is the compatibility-matrix generator.
- `probe`: per endpoint, P1 write / P2 read-only refusal / P3 resume contract probes against the installed agent; refreshes `verified_at` fields on success (local calendar date).
- `models`: cache-first against `<dataDir>/models-cache/<endpoint>.json` (`{schema_version, endpoint, fetched_at, version, source, models, notes}`); `--refresh` forces a live query and writes through. A failed refresh serves the last successful cache with `stale: true`; a successful empty list overwrites (never borrows the old cache).
- `init`: first-run wizard. Interactive on a TTY (enable per endpoint, pick default endpoint/model, writes config.json; existing config is backed up first). Non-TTY callers get `INIT_INTERACTIVE_REQUIRED` plus current state JSON; `--yes` enables all detected endpoints with the first discovered model as default. The decision logic lives in `engine/init-plan.ts` (UI-free) so a console GUI reuses it. After the config write, init offers to install the paidan skill (`skills/paidan/SKILL.md`, payload listed in `skills/hosts.json`) into each detected host's user-scope skills dir — per-host checkbox on a TTY, all detected hosts under `--yes`; installs are atomic copies reported as created/updated/unchanged, and only ever happen on explicit selection (invariant 4: no silent writes to an agent's native home).

## 8. usage.db (node:sqlite)

Table `usage(run_id TEXT PRIMARY KEY, endpoint TEXT, connection TEXT, model TEXT, input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER, cost REAL, source TEXT, recorded_at TEXT)`. `source` ∈ `provider | endpoint-ledger | unavailable` — three-state, never fabricate zeros. `provider` = the endpoint's own output stream carried usage; `endpoint-ledger` = observed from the endpoint's native on-disk ledger (kimi: `<KIMI_CODE_HOME|~/.kimi-code>/session_index.jsonl` → `<sessionDir>/agents/*/wire.jsonl` `usage.record` rows, summed; fresh runs only — a resumed session's wire contains earlier turns and stays `unavailable` until a pre-spawn cursor exists). No cross-connection aggregation games: accounting is per connection.

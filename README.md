# paidan（派单）

Delegate a task to an AI CLI agent already installed on your machine.
Every task is a **durable run**: you can wait for it, cancel it, and verify its result after a reboot.

```
npm i -g paidan
paidan init                                   # first-run wizard (detect endpoints, pick defaults)
paidan doctor                                 # what agents are installed and usable?
paidan run --endpoint kimi-code --cwd . --task "summarize this repo"
paidan list
paidan get <run_id> --wait
paidan cancel <run_id>
paidan models --endpoint kimi-code            # cache-first; --refresh re-queries
```

All CLI output is JSON. There is no daemon: each run is supervised by a detached worker process, and the on-disk run store is the single source of truth.

## What it is / is not

paidan is a local dispatch desk ("派单" = dispatching an order). It does three things and no more:

1. A **local tool** that hands tasks to AI CLI agents on this computer.
2. Every task is a **persistent run** — waitable, cancellable, verifiable after restart.
3. Configuration and discovery, with an optional console UI (planned).

It deliberately does **not** do: orchestration / multi-agent pipelines, daemons, multi-tenancy, multi-machine scheduling, chat UI, plugin system (v1), credential custody (it never proxies or copies your credentials), telemetry (none, ever).

## Data zones

| Zone | Location | Contents |
|---|---|---|
| code repo | this repository | zero machine paths, zero credentials |
| machine config | `%APPDATA%\paidan\config.json` | endpoints enabled, defaults, data dir override, per-endpoint bin overrides |
| data plane | `%APPDATA%\paidan\runs\` + `usage.db` + `models-cache/` | one directory per run (request/state/events.jsonl/result), usage accounting (provider / endpoint-ledger / unavailable, never fabricated), model discovery cache, TTL self-cleaning |

Data never flows back into the code repo. Move the data dir anywhere via config; nothing is pinned to one machine.

## Endpoints

An endpoint is a **data manifest** (`endpoints/<name>.json`) plus a small parser (≤200 lines). The manifest declares: how to detect the agent binary, command template, permission capability map, prompt delivery, output parsing type, model discovery command, and capability flags with the date they were last verified.

Permission presets (`read-only` / `workspace-write` / `unattended`) are conveniences only — each endpoint maps them to its native permission model, and an endpoint that cannot enforce a preset says so honestly (`soft` or `unsupported`) instead of pretending. See `docs/contracts.md`.

| endpoint | presets (ro/ww/ua) | user-visible surprises |
|---|---|---|
| kimi-code | – / ✅ / ✅ | no headless read-only tier at all (`-p` fixes auto permission; probe-verified). Usage comes from the native session ledger (`endpoint-ledger`). |
| codex | ✅ / ✅ / ✅ | resume restores the session's original sandbox tier (`exec resume` takes no `-s`/`--add-dir`). |
| claude-code | ✅ / ✅ / ✅ | read-only = default tier + `--permission-prompts none`; shell.exec needs bypassPermissions (unattended). |
| zcode | – / – / ✅ | yolo-only by design (non-yolo tiers wait forever headless). Desktop installs no PATH binary — set `endpoints.overrides.zcode.bin` to the CLI bundle, or make a shim. |
| opencode | ✅ / ✅ / ✅ | project root anchors to the inherited `PWD` if present — paidan pins `run --dir <cwd>` and unsets `PWD`. `add_dirs` unsupported in v0 (needs a computed-env permission projection). |
| omp | ✅ / ✅ / ✅ | workspace-write tier has **no shell.exec** (bash/eval fail closed); shell needs unattended (yolo). |
| dsh | ✅ / ✅ / – | no PATH shim — set `endpoints.overrides.dsh.bin` to `<dsh home>/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js`. No resume (headless returns no session handle). read-only rides `mode_env` (DSH_PERMISSION_MODE) because any extra argv fragment would merge into the prompt. |
| agy | ✅ / ✅ / ✅ | shell.exec is **soft**: the shell leg sits outside path governance (suite-recorded `run_command` off-location starts) and needs a native `command(*)` allow rule. fs.read needs a native `read_file` allow rule — and on Windows only the unscoped `read_file(*)` form currently takes effect (upstream limitation). No `--sandbox` flag exists; enforcement is carried by native `~/.gemini` permission settings, which paidan never patches (invariant 4). |

Legend: ✅ supported · – unsupported · soft = claims it, enforcement doubtful (submit warning).

## Maintenance mode

This project is **maintained by AI agents** (with human oversight at a low bandwidth). Responses may be slow. Forks are welcome and encouraged — the repo is designed to be self-explanatory: read `AGENTS.md` for the invariants and how to add an endpoint.

Compatibility claims carry dates: agent CLIs drift, and `paidan doctor` / `paidan probe` re-measure the real behavior of your installed versions instead of trusting documentation.

## Status

Early (0.x). The engine works; kimi-code, codex, claude-code and zcode manifests pass their contract probes (zcode headless is yolo-only by design). More endpoints land as their manifests pass the contract probes. MIT licensed.

## Platform support

| platform | engine | notes |
|---|---|---|
| Windows 10/11 | ✅ tested daily-driver | cancel = taskkill tree-kill (Job Object reaping planned) |
| Linux | 🟡 designed, untested | config at `$XDG_CONFIG_HOME/paidan` (default `~/.config/paidan`); cancel = POSIX process-group signals |
| macOS | 🟡 designed, untested | same POSIX path (`~/.config/paidan`, deliberately not `~/Library/Application Support` — one code path) |

The platform-specific surface is intentionally tiny (config dir, binary resolution, process kill) and each has a POSIX branch; what is missing is real-machine verification. Unit tests and golden fixtures run everywhere; contract probes self-skip when an agent is not installed. A three-OS CI matrix lands before public release (P3). Requires Node ≥ 24 on every platform.


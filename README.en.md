# paidan（派单）

[简体中文](README.md) · English

Delegate a task to an AI CLI agent already installed on your machine.
Every task is a **durable run**: you can wait for it, cancel it, and verify its result after a reboot.

**Recommended setup: give this repository link to an AI agent with local shell access** and ask it to follow [INSTALL.en.md](INSTALL.en.md). It asks once which endpoints to connect, inspects only those, adopts a single valid entry after showing it, and lets you choose between multiple installations. Model/effort follow native settings by default; the current host skill goes into one configuration confirmation. Basic checks finish setup without calling a model. Pending login/quota or skipped verification keeps the configuration for later use.

Already configured? Use the core commands:

```
paidan doctor                                 # what agents are installed and usable?
paidan run --cwd . --task "summarize this repo"
paidan list
paidan get <run_id> --wait
paidan cancel <run_id>
paidan models --endpoint kimi-code            # current candidates, not guaranteed model access
```

Manual shortcut: `npm i -g paidan` (Node >= 24), then optionally `paidan init`. The wizard uses first-match discovery; it does not choose between multiple installed versions. Agent-guided setup does not need init.

All CLI output is JSON. There is no daemon: each run is supervised by a detached worker process, and the on-disk run store is the single source of truth.

New here in one breath: a **host** is the agent that dispatches (you, or an AI agent you ask); an **endpoint** is the agent that executes; a **run** is one task's durable record — save its `run_id`. `effort` is the endpoint's reasoning-intensity option where it exists; permission **presets** (`read-only` / `workspace-write` / `unattended`) are convenience mappings onto each agent's native permission model. A finished run is judged evidence-first: `completed` means the evidence says so, not merely `exit 0`.

For package updates, upstream CLI updates or uninstalling, ask the installing agent to follow [Update and uninstall](INSTALL.en.md#update-and-uninstall). Config/history/native settings remain by default; host skill copies are compared before updating/removing.

## Host integration

A host AI agent drives paidan through the CLI. During [agent-guided setup](INSTALL.en.md), choose which hosts receive the paidan skill. Each of the eight supported agents has a native variant registered in [skills/hosts.json](skills/hosts.json). The installer copies only the selected variants, using the source and target paths reported by `paidan doctor`, without re-running init or changing endpoint defaults.

The skill teaches task submission, waiting, cancellation, model discovery, and evidence-based result checking. You can also copy the corresponding packaged variant by hand. The optional `paidan init` wizard offers skill installation alongside its endpoint/default selections.

Model and effort defaults should normally **follow the selected CLI’s native configuration**: pin the executable path, leave model/effort overrides unset. Explicit fixed defaults remain an option. After a connection switch or quota/login/model error, the host checks current configuration and asks you how to proceed; it never silently changes the billing route or retries the task.

Headless permissions are separate from native model defaults: seven endpoints use workspace-write; ZCode uses unattended. Codex explicitly uses never approval and Claude disables interactive permission prompts; other endpoints keep their own headless mappings. Adjust with `--mode` or `defaults.modes.<endpoint>`. See [headless defaults](INSTALL.en.md#headless-permissions-are-separate-defaults).

Configure **selected CLI → connection/account → model → model-specific effort** using each endpoint’s native mechanism. Login, API and gateway routes may bill separately; catalogs do not guarantee access. See [endpoint recipes](INSTALL.en.md#endpoint-specific-configuration).


## What it is / is not

paidan is a local dispatch desk ("派单" = dispatching an order). It does three things and no more:

1. A **local tool** that hands tasks to AI CLI agents on this computer.
2. Every task is a **persistent run** — waitable, cancellable, verifiable after restart.
3. Configuration and discovery (`init` wizard, `doctor`, `models`).

It deliberately does **not** do: orchestration / multi-agent pipelines, daemons, multi-tenancy, multi-machine scheduling, chat UI, plugin system (v1), credential custody (it never proxies or copies your credentials), telemetry (none, ever).

## Data zones

| Zone | Location | Contents |
|---|---|---|
| code repo | this repository | zero machine paths, zero credentials |
| machine config | `%APPDATA%\paidan\config.json` | endpoints enabled, defaults (endpoint + per-endpoint default models and efforts, run timeout), data dir override, per-endpoint bin overrides |
| data plane | `%APPDATA%\paidan\runs\` + `usage.db` + `models-cache/` | one directory per run (request/state/events.jsonl/result), usage accounting (provider / endpoint-ledger / unavailable, never fabricated), model discovery cache, TTL self-cleaning (terminal runs and caches expire after **30 days** by default — `ttlDays` configurable; `paidan list` piggy-backs the expiry sweep, so it is not a strictly read-only query) |

Data never flows back into the code repo. Move the data dir anywhere via config; nothing is pinned to one machine.

## Endpoints

An endpoint is a **data manifest** (`endpoints/<name>.json`) plus a small parser (one protocol per file, ~150-260 lines). The manifest declares: how to detect the agent binary, command template, permission capability map, prompt delivery, output parsing type, model discovery command, and capability flags with the date they were last verified.

Permission presets (`read-only` / `workspace-write` / `unattended`) are conveniences only — each endpoint maps them to its native permission model, and an endpoint that cannot enforce a preset says so honestly (`soft` or `unsupported`) instead of pretending. See `docs/contracts.md`.

| endpoint | presets (ro/ww/ua) | user-visible surprises |
|---|---|---|
| kimi-code | – / ✅ / ✅ | Native print auto; no enforceable read-only tier. Usage comes from the native ledger. Full aliases select OAuth/API routes independently. Explicit effort is supported only for confirmed kimi-protocol thinking models; other protocols follow native effort. |
| codex | ✅ / ✅ / ✅ | Native exec --json; resume restores the original sandbox. The selected CLI supplies models and per-model efforts. Fixed choices bind to the native configuration and require user selection after changes; --native follows defaults for one invocation. |
| claude-code | – / ✅ / ✅ | Show alias mappings and full model IDs; fixed selections require re-confirmation after native config changes. Effort uses native flags only. Default acceptEdits + permission-prompts=none preserves native allow rules; enforced read-only is unsupported. |
| zcode | – / – / ✅ | Print/yolo only (unattended). Configure and enable a working native API-key connection first; desktop OAuth alone does not prove headless readiness. Follow native or let the installer create an approved native profile and set endpoints.overrides.zcode.provider_config. Report expected/actual provider, model and effort; ask before any fallback. See [INSTALL.en.md](INSTALL.en.md). |
| opencode | ? / ✅ / ✅ | Task-directory configuration and provider/model variants; fixed choices are validated and bound to native metadata. 1.18.31 write/resume passed; read-only refusal evidence was insufficient, so enforcement is unverified. |
| omp | ✅ / ✅ / ✅ | Current OMP_PROFILE selectors, per-model thinking and auth metadata; fixed choices are validated and bound. 18.2.5 write/read-only-refusal/resume passed. Native account rotation, fallback and role switching remain under native configuration and are disclosed. |
| dsh | ✅ / ✅ / – | Native headless profile owns provider/model/reasoningEffort; the menu lists explicitly configured entries. Native edits require consent; no paidan model/effort overrides. 0.1.5-rc.2 write/read-only-refusal passed; no resume. |
| agy | soft / ✅ / ✅ | Pin the full ID, including any encoded effort; do not add --effort. Native account type remains unknown. 1.2.5 write/resume passed; read-only timed out and remains soft. Native allow rules and the cwd hint still matter. |

Legend: ✅ supported · – unsupported · soft = claims it, enforcement doubtful (submit warning).

## Maintenance mode

This project is **maintained by AI agents** (with human oversight at a low bandwidth). Responses may be slow. Forks are welcome and encouraged — the repo is designed to be self-explanatory: read `AGENTS.md` for the invariants and how to add an endpoint.

Compatibility claims carry dates: agent CLIs drift, and `paidan doctor` / `paidan probe` re-measure the real behavior of your installed versions instead of trusting documentation.

## Status

Early (0.x). The engine works; all eight endpoint manifests are wired and pass their contract probes where the agent is installed (dsh has no resume to probe; zcode headless is yolo-only by design). An eight-endpoint real-delegation sweep passed on the author's machine (2026-09-10). MIT licensed.

## Platform support

| platform | engine | notes |
|---|---|---|
| Windows 10/11 | ✅ tested daily-driver | cancel = taskkill tree-kill, graceful then forced (orphaned grandchildren after a force-kill are an accepted limitation — Job Objects need FFI, zero-dep invariant) |
| Linux | 🟡 designed, untested | config at `$XDG_CONFIG_HOME/paidan` (default `~/.config/paidan`); cancel = POSIX process-group signals |
| macOS | 🟡 designed, untested | same POSIX path (`~/.config/paidan`, deliberately not `~/Library/Application Support` — one code path) |

The platform-specific surface is intentionally tiny (config dir, binary resolution, process kill) and each has a POSIX branch; what is missing is real-machine verification. Unit tests and golden fixtures run everywhere and are enforced by a three-OS CI matrix (Windows / Linux / macOS); contract probes self-skip when an agent is not installed. Requires Node ≥ 24 on every platform.

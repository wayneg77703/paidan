# paidan（派单）

English · [简体中文](README.zh-CN.md)

Delegate a task to an AI CLI agent already installed on your machine.
Every task is a **durable run**: you can wait for it, cancel it, and verify its result after a reboot.

```
npm i -g paidan                               # requires Node >= 24 (node:sqlite)
paidan init                                   # first-run wizard (detect endpoints, pick defaults)
paidan doctor                                 # what agents are installed and usable?
paidan run --endpoint kimi-code --cwd . --task "summarize this repo"
paidan list
paidan get <run_id> --wait
paidan cancel <run_id>
paidan models --endpoint kimi-code            # cache-first; --refresh re-queries
```

Setting up a fresh machine **through an AI agent** (the agent reads the machine state, asks you the options, and completes the install)? Hand the agent [`INSTALL.md`](INSTALL.md).

All CLI output is JSON. There is no daemon: each run is supervised by a detached worker process, and the on-disk run store is the single source of truth.

New here in one breath: a **host** is the agent that dispatches (you, or an AI agent you ask); an **endpoint** is the agent that executes; a **run** is one task's durable record — save its `run_id`. `effort` is the endpoint's reasoning-intensity option where it exists; permission **presets** (`read-only` / `workspace-write` default / `unattended`) are convenience mappings onto each agent's native permission model. A finished run is judged evidence-first: `completed` means the evidence says so, not merely `exit 0`.

## Host integration

A host AI agent drives paidan through the CLI — no plugin system. The `paidan init` wizard is fully interactive: checkbox multi-selects (space toggles, enter confirms) for the endpoints to enable and for the hosts to receive the skill file ([`skills/paidan/SKILL.md`](skills/paidan/SKILL.md)), an arrow-key menu for the default endpoint, and a default-model pick for every enabled endpoint **that can take a model headless** (endpoints like dsh/zcode, whose native config owns the model, are noted and skipped; selections are stored as `defaults.models.<endpoint>` — the wizard never writes a global `defaults.model`, which would poison those endpoints). Every supported agent can be a host as well as a delegatee — [`skills/hosts.json`](skills/hosts.json) lists the user-scope skills directory of all eight agents (kimi-code, claude-code, zcode, codex, dsh, opencode, agy, omp), and each host receives its own **natively-authored variant** (`skills/paidan/variants/<host>.SKILL.md` — native frontmatter per the host's spec, identical body, installed verbatim with no field stripping). You can also copy the matching variant by hand (for Kimi Code: the user-scope `~/.kimi-code/skills/paidan/` directory). It teaches the seven verbs, the permission-preset semantics, and the evidence-first terminal judgment rules. `paidan init --yes` takes the zero-override path — every model/effort stays at the endpoint's native default (what each native home currently carries is read-only visible via `paidan doctor` `native_defaults` — a snapshot implemented for a subset of endpoints; `null` can mean unimplemented or read failure, not necessarily the effective value); `--yes --effort <level>` applies that level to every endpoint whose options include it.

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
| kimi-code | – / ✅ / ✅ | no headless read-only tier at all (`-p` fixes auto permission; probe-verified). Usage comes from the native session ledger (`endpoint-ledger`). Effort (low/high/max) is env-delivered — 0.42.0 has no CLI flag; `KIMI_MODEL_THINKING_EFFORT` overrides the native config key. |
| codex | ✅ / ✅ / ✅ | resume restores the session's original sandbox tier (`exec resume` takes no `-s`/`--add-dir`). Effort = `-c model_reasoning_effort` (minimal–xhigh; the native config's value applies when unset). |
| claude-code | ✅ / ✅ / ✅ | read-only = default tier + `--permission-prompts none`; shell.exec needs bypassPermissions (unattended). |
| zcode | – / – / ✅ | yolo-only by design (non-yolo tiers wait forever headless). Desktop installs no PATH binary — the default install dirs are auto-probed via `detect.known_paths`; for a custom install location the init wizard offers an in-wizard bin-path intake (or set `endpoints.overrides.zcode.bin` / make a shim by hand). Headless also needs credentials the user provisions, **by Zhipu platform** (z.ai and BigModel are both Zhipu — international vs mainland-China platforms, with separate account systems): (a) **z.ai (Zhipu international)** account → `node <install-dir>/resources/glm/zcode.cjs login` (Z.AI OAuth; `--no-browser` where headless); (b) **BigModel (Zhipu's mainland open platform)** coding plan (`apiKey`+`baseURL` pointing at bigmodel.cn) → hand-copy the desktop's `provider` block from `~/.zcode/v2/config.json` into `~/.zcode/cli/config.json` (or write it there directly), or use the env triple (`ZCODE_MODEL`/`ZCODE_BASE_URL`/`ANTHROPIC_API_KEY`) pointed at the BigModel endpoint. `zcode login` only covers (a) — it cannot provision the mainland BigModel credentials. `doctor` prechecks this as `credential_ready`. |
| opencode | ✅ / ✅ / ✅ | project root anchors to the inherited `PWD` if present — paidan pins `run --dir <cwd>` and unsets `PWD`. `add_dirs` unsupported in v0 (needs a computed-env permission projection). |
| omp | ✅ / ✅ / ✅ | workspace-write tier has **no shell.exec** (bash/eval fail closed); shell needs unattended (yolo). |
| dsh | ✅ / ✅ / – | no PATH shim — the conventional profile-home launcher (`~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js`) is auto-probed via `detect.known_paths`; otherwise set `endpoints.overrides.dsh.bin`. No resume (headless returns no session handle). read-only rides `mode_env` (DSH_PERMISSION_MODE) because any extra argv fragment would merge into the prompt. |
| agy | soft / ✅ / ✅ | fs.write and shell.exec are both **soft**; read-only is **soft** too (1.2.1 probe came back indeterminate — plan-mode headless may wait instead of auto-denying as on 1.1.28/1.2.0, pending a dedicated recheck): on 1.2.0, `write_to_file` is confined to its own conversation artifacts and deliverable writes actually ride `run_command` (shell, gated by the native `command(*)` allow rule), which starts in agy's own scratch dir — paidan appends a cwd hint so absolute paths land right. fs.read needs `read_file`, and on Windows only the unscoped `read_file(*)` form currently takes effect (upstream limitation). No `--sandbox` flag exists; enforcement is carried by native `~/.gemini` permission settings, which paidan never patches (invariant 4). A `write_file` allow rule is **not** required for deliverables (superseded 1.2.0 finding; earlier scoped-rule guidance no longer applies). |

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


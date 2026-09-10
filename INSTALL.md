# INSTALL.md — agent-driven installation

> Audience: an **AI agent** setting up paidan on a fresh machine for a human.
> The human should only have to answer a short list of options; you do
> everything else. (Humans installing by hand can follow the same steps.)

## 0. Prerequisites

- Node.js **≥ 24** (`node --version`; paidan uses `node:sqlite` and `node:test`).
- git.
- The AI CLI agents the user wants to delegate to, already installed and
  authenticated (paidan never touches credentials — it runs each agent
  against its own native config).

## 1. Get and install paidan

```bash
git clone https://github.com/<owner>/paidan.git
cd paidan
npm install        # devDeps only (typescript + @types/node)
npm run build
npm i -g .
paidan doctor      # PATH now has `paidan`
```

Once the package is published to npm, the one-liner is `npm i -g paidan`
(no clone needed). Verify: `paidan doctor` prints a JSON envelope with
`ok: true`.

On a machine with **zero** agents detected, `init` still succeeds and writes
an empty `endpoints.enabled` — install any agent and re-run `paidan init`;
re-init merges and never destroys machine-local keys.

## 2. Read the machine state (no TTY needed)

Run `paidan init` **without answering it** (or simply note that your stdin is
not a TTY). It refuses interaction with `INIT_INTERACTIVE_REQUIRED` and, in
the same envelope, hands you the full machine survey:

```json
{
  "state": {
    "config_path": "...", "config_exists": false,
    "endpoints": [ {
      "name": "kimi-code", "detected": true, "version": "0.42.0",
      "models": [...],
      "model_selectable": true,
      "effort_options": null
    } ],
    "hosts":     [ { "name": "kimi-code", "detected": true, "skills_dir": "..." } ]
  }
}
```

- `endpoints[].detected === false` carries a `repair` hint (e.g. an agent
  installed in an unusual location → set `endpoints.overrides.<name>.bin`).
- `endpoints[].models` is the discovered model list per endpoint (also
  refreshable later with `paidan models --endpoint <name> --refresh`).
- `endpoints[].model_selectable === false` means the endpoint takes no model
  on its headless command line (its native config owns the model — dsh,
  zcode): do NOT offer or write a default model for it — a configured model
  is refused at submit with `MODEL_UNSUPPORTED`.
- `endpoints[].effort_options` is the declared effort list, or `null`.

## 3. Ask the user the option set

Present these five questions (this is exactly the interactive wizard's set):

1. **Enable which endpoints?** (from `state.endpoints` where `detected`)
2. **Default endpoint?** (used when `paidan run` gets no `--endpoint`)
3. **Default model per enabled endpoint that is `model_selectable`?** (from
   that endpoint's `models` list; an endpoint with no discovered models keeps
   its native default; `model_selectable === false` endpoints are skipped —
   their native config owns the model)
4. **Default effort per enabled endpoint?** — only where the endpoint
   declares an effort block: today **claude-code** (low/medium/high/xhigh/max),
   **omp** (off/minimal/low/medium/high/xhigh/max/auto), **opencode**
   (minimal/high/max). Everything else keeps its native default.
5. **Install the paidan skill into which hosts?** (from `state.hosts`;
   the skill teaches each agent how to drive paidan; all eight agents can be
   hosts — kimi-code, claude-code, zcode, codex, dsh, opencode, agy, omp)

## 4. Complete the install

Two paths; prefer A when the human is at the keyboard, B when they are not.

**A. Interactive (human answers the prompts themselves)**

```bash
paidan init        # checkboxes: space toggles, enter confirms
```

**B. Agent-driven (you collected the answers in step 3)**

```bash
paidan init --yes  # enables all detected endpoints and leaves every
                   # model/effort at the endpoint's native default (the agent's
                   # own home carries them); installs the skill into all
                   # detected hosts — a baseline you now adjust. Add
                   # --effort <level> to apply that level to every endpoint
                   # whose options include it.
```

Then edit the machine config (`state.config_path`; `%APPDATA%\paidan\config.json`
on Windows, `~/.config/paidan/config.json` elsewhere) to match the user's
answers. The wizard-owned keys are:

```json
{
  "endpoints": {
    "enabled": ["kimi-code", "codex"],
    "overrides": { "zcode": { "bin": "D:/custom/zcode.cjs" } }
  },
  "defaults": {
    "endpoint": "kimi-code",
    "models": { "kimi-code": "kimi-code/k3", "codex": "gpt-6-astra" },
    "efforts": { "omp": "high", "claude-code": "medium" },
    "run_timeout_sec": 1800
  }
}
```

Key rules, in two layers (know which is which):

**Load-time hard errors** (`loadConfig`, everything in this layer blocks every
verb with `CONFIG_INVALID`):

- `dataDir` / `defaults.model` / `defaults.effort` / `overrides.<name>.bin`
  must be non-empty strings **when present** — omit a key entirely for its
  default; an explicit `null` is an error.
- Unknown keys are rejected (typos never pass silently); `__proto__` and
  friends are rejected as dynamic keys.
- `endpoints.enabled` must be an array of strings; `defaults.models` /
  `defaults.efforts` must be string maps; `ttlDays` a positive number;
  `defaults.run_timeout_sec` a non-negative number.

**Semantic validation** (NOT done at load — a hand-written config that breaks
these loads fine and fails later at the named point):

- `defaults.endpoint` must be in `enabled` (enforced when a run needs it:
  `ENDPOINT_DISABLED`/`ENDPOINT_REQUIRED` at submit).
- `endpoints.overrides.<name>.bin`: machine-local path to a native binary or
  JS bundle for an endpoint detection cannot find (custom drives, profile
  layouts). Machine paths live **only** here, never in the repo. Load checks
  shape only; a wrong path surfaces at detection (`doctor` repair hint).
- `defaults.models.<name>` is only meaningful for `model_selectable`
  endpoints — a configured model against an endpoint with no headless model
  selection (dsh, zcode) is refused at submit with `MODEL_UNSUPPORTED`.
  The wizard validates aliases against discovery; `run`/`probe` validate
  argv-safety, not discovery membership.
- `defaults.efforts.<name>` must be one of that endpoint's declared effort
  `options` (enforced at submit: `EFFORT_INVALID`; a block-less endpoint with
  a configured effort: `EFFORT_UNSUPPORTED`).
- **The wizard never writes `defaults.model`** (a global model poisons
  endpoints that cannot take one headless; a hand-set value is cleared on
  re-init deliberately) — prefer per-endpoint `defaults.models` and leave the
  global out entirely for "native default".

Resolution order at run time: `--model ?? defaults.models[ep] ?? defaults.model`;
`--effort ?? defaults.efforts[ep] ?? defaults.effort ?? native default`.

## 5. Verify and report

```bash
paidan doctor    # every enabled endpoint should show resolved + a version;
                 # usage.db ok
paidan run --endpoint <default> --cwd <scratch-dir> --task "reply with ok" --deliverable ok.txt
paidan get <run_id> --wait
```

Report back to the user: which endpoints are enabled, what the defaults are,
which hosts received the skill, anything you had to override, and the one
test run's terminal state. If an endpoint is not detected, quote the
`repair` hint from `paidan doctor` instead of improvising a fix.

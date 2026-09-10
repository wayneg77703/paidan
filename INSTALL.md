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

## 2. Read the machine state (no TTY needed)

Run `paidan init` **without answering it** (or simply note that your stdin is
not a TTY). It refuses interaction with `INIT_INTERACTIVE_REQUIRED` and, in
the same envelope, hands you the full machine survey:

```json
{
  "state": {
    "config_path": "...", "config_exists": false,
    "endpoints": [ { "name": "kimi-code", "detected": true, "version": "0.42.0", "models": [...] } ],
    "hosts":     [ { "name": "kimi-code", "detected": true, "skills_dir": "..." } ]
  }
}
```

- `endpoints[].detected === false` carries a `repair` hint (e.g. an agent
  installed in an unusual location → set `endpoints.overrides.<name>.bin`).
- `endpoints[].models` is the discovered model list per endpoint (also
  refreshable later with `paidan models --endpoint <name> --refresh`).

## 3. Ask the user the option set

Present these five questions (this is exactly the interactive wizard's set):

1. **Enable which endpoints?** (from `state.endpoints` where `detected`)
2. **Default endpoint?** (used when `paidan run` gets no `--endpoint`)
3. **Default model per enabled endpoint?** (from that endpoint's `models`
   list; an endpoint with no discovered models keeps its native default)
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
paidan init --yes  # enables all detected endpoints, first model per endpoint,
                   # native effort everywhere, installs the skill into all
                   # detected hosts — a sane baseline you now adjust
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
    "model": null,
    "models": { "kimi-code": "kimi-code/k3", "codex": "gpt-6-astra" },
    "effort": null,
    "efforts": { "omp": "high", "claude-code": "medium" },
    "run_timeout_sec": 1800
  },
  "dataDir": null,
  "ttlDays": 30
}
```

Key rules (violations are hard errors with the key named):

- `endpoints.enabled`: array of endpoint names (subset of detected).
- `endpoints.overrides.<name>.bin`: machine-local path to a native binary or
  JS bundle for an endpoint detection cannot find (custom drives, profile
  layouts). Machine paths live **only** here, never in the repo.
- `defaults.endpoint` must be in `enabled`. `defaults.models.<name>` must be
  one of that endpoint's discovered aliases. `defaults.efforts.<name>` must
  be one of that endpoint's declared effort `options` (see step 3.4).
- `defaults.model` / `defaults.effort` are global fallbacks; the per-endpoint
  maps win. Leave a key out entirely for "native default".
- Unknown keys are rejected (typos never pass silently); `__proto__` and
  friends are rejected as dynamic keys.

Resolution order at run time: `--model ?? defaults.models[ep] ?? defaults.model`;
`--effort ?? defaults.efforts[ep] ?? defaults.effort ?? native default`.

## 5. Verify and report

```bash
paidan doctor    # every enabled endpoint should show resolved + a version;
                 # usage.db ok
paidan run --endpoint <default> --cwd <scratch-dir> --task "reply with ok" --deliverable ok.txt || true
paidan get <run_id> --wait
```

Report back to the user: which endpoints are enabled, what the defaults are,
which hosts received the skill, anything you had to override, and the one
test run's terminal state. If an endpoint is not detected, quote the
`repair` hint from `paidan doctor` instead of improvising a fix.

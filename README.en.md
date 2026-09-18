# paidan（派单）

[简体中文](README.md) · English

Delegate tasks to other AI CLI agents on your machine. Keep talking to your current agent while another works, then retrieve the result, wait or cancel. Task records are stored locally and remain available after a restart.

Supports **Codex, Claude Code, Kimi Code, ZCode, OpenCode, OMP, DSH and AGY**.

## Install

You need **Node.js 24+** and the agents you want to connect. Configure login or API access through each agent's native tools.

Give the [repository link](https://github.com/wayneg77703/paidan) to an agent with local shell access and say:

> Follow INSTALL.en.md to install paidan, connect Codex and ZCode, and install the dispatch skill for you. Leave other endpoints alone.

It finds installations, shows current connections/models/reasoning levels, and lets you follow native defaults or choose fixed settings. You choose between multiple installations and review changes before saving. The program handles configuration, backups and installation records; no hand-written JSON is required. Setup does not call a model by default.

The **host** sends tasks; an **endpoint** receives them. Choose these roles independently. Installation conversations use your language.

You can also install the package first, then ask an agent to configure it:

```sh
npm install -g paidan
paidan --version
```

Terminal users can optionally run `paidan init`. If Windows blocks `.ps1`, use the existing `npm.cmd` / `paidan.cmd`. An application missing from PATH may still be installed: give the installing agent its installation directory as a search hint.

## Use it

Once the host has the skill, state the task, endpoint and scope:

> Use paidan to ask Codex for a read-only review of this project. Summarize its findings when finished.

> Delegate this error to Kimi Code. It may edit this project and run tests.

> Check whether the previous task finished; if it is still running, keep waiting.

From a terminal, submit a task:

```sh
paidan run --endpoint codex --cwd . --mode read-only --task "Review this project and list its main issues"
```

The command returns a `run_id`. Use it to retrieve results or cancel. CLI output is JSON.

| Action | Command |
|---|---|
| Retrieve the result and wait for completion | `paidan get <run_id> --wait` |
| List recent tasks | `paidan list` |
| Cancel a task | `paidan cancel <run_id>` |
| Read a longer task from a file | `paidan run --endpoint codex --cwd . --task-file task.md` |
| Inspect model candidates | `paidan models --endpoint codex` |
| Check an endpoint's entry and configuration | `paidan doctor --endpoint codex` |
| Show command options | `paidan help run` |

Replace angle-bracket placeholders with actual values. You may omit `--endpoint` after choosing a default. After a wait timeout, keep querying the same `run_id` rather than submitting again. Restarting does not automatically rerun unfinished tasks.

## Change settings or add an endpoint

You can maintain one endpoint without reinstalling or reconfiguring the others. Tell the installing agent what you want:

> I just installed OpenCode. Connect only that endpoint; keep the other settings and the default endpoint.

> Make Codex follow its native model and effort settings.

> ZCode moved to another directory. Find its new entry and keep my model choice.

The program changes only selected endpoints. Follow native defaults or choose a fixed combination in this order: **connection → model → that model's supported effort**.

| Endpoint name | What to know |
|---|---|
| `codex` | Follow native settings or fix model/effort. Fixed choices require confirmation after connection configuration changes. |
| `claude-code` | Choose a full model ID or a dynamic alias and supported effort. Aliases follow native mappings. |
| `kimi-code` | Model aliases select OAuth/API routes. Fixed effort depends on the model and protocol. |
| `zcode` | Configure and enable a native API provider first; desktop login alone does not establish CLI access. Custom installation drives are supported. The program creates a dedicated profile for fixed choices. |
| `opencode` | Choose provider/model and its variant. Inspect configuration in the actual task directory. |
| `omp` | Uses the current native profile's model/thinking settings. Native account rotation and fallback may still apply. |
| `dsh` | Uses native headless profile settings, with no paidan model/effort overrides. Locate the entry again if its cache disappears. No session resume. |
| `agy` | Choose the complete model ID; do not add effort when the ID already includes it. Missing native permission rules need separate attention. |

A dedicated ZCode file may contain a local copy of the selected API key; setup explains this and asks for approval, preserving the original configuration. DSH native-default changes also disclose their wider impact before the program edits a supported configuration format.

Model settings and execution permissions are separate. Defaults generally permit workspace edits; ZCode uses the broader `yolo` mode. Explicitly request read-only when needed; see [endpoint permission support](INSTALL.en.md#headless-permissions-are-separate-defaults). Codex disables interactive approval, and Claude Code denies operations that require a prompt so the host can handle them without a headless task waiting for input.

## When a task fails

Give the host agent the `run_id` and error. It checks the result, existing artifacts and current configuration before discussing the next step with you.

After changing a connection through CC Switch or another tool, a previously fixed model may no longer apply. Choose native defaults for this run, another fixed combination or a native setup repair. paidan never automatically changes accounts/billing routes or resubmits the task. Model listings and doctor checks do not guarantee quota or access.

## Updates, uninstalling and local data

Ask the installing agent to follow [Update and uninstall](INSTALL.en.md#update-and-uninstall), for example: “Update paidan and sync my existing host skills” or “Uninstall paidan but keep configuration and history.” `npm install -g paidan@latest` updates the npm package alone; installed host skills still need syncing.

Default data locations:

- Windows: `%APPDATA%\paidan\`
- Linux / macOS: `~/.config/paidan/`, or `$XDG_CONFIG_HOME/paidan/`

These hold configuration, installation records and task history. Change locations with `PAIDAN_HOME` or the data-directory setting. Finished tasks are retained for **30 days** by default; `paidan list` cleans expired records. Adjust `ttlDays` for longer retention. Uninstalling preserves this data and native agent settings by default.

[Detailed installation and endpoint setup](INSTALL.en.md) · [Technical reference](docs/contracts.md) · [Maintainer guide](AGENTS.md) · [MIT license](LICENSE)

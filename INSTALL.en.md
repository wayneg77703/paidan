# Install paidan with an agent

[简体中文](INSTALL.md) · English

paidan delegates tasks to local AI CLIs. The sending agent is the host; the receiving CLI is the endpoint. Choose them independently. This guide is for a local installing agent. Get the user's selected endpoints configured quickly. By default, do not call a model for a test, and do not configure every installed agent. The agent handles conversation and location hints; the program validates and writes configuration. No `paidan init` is required.

## Conversation language

For Chinese-speaking users, use Chinese for questions, choices, errors, confirmations and results. Default to Simplified Chinese when no preference is apparent; honor another requested language. Explain English errors before quoting them. Preserve commands, paths, model identifiers, JSON keys and error codes. Native tools and the optional init wizard may still display English.

## Default flow

### 1. Choose endpoints and install paidan

Ask which endpoints to connect: kimi-code, codex, claude-code, zcode, opencode, omp, dsh, agy. Accept names, “all”, and natural language. Do not split one choice into unrelated groups to fit a four-option widget. Reuse explicit choices.

Check Node.js >= 24, then run `npm i -g paidan` and `paidan --version`. Handle missing prerequisites only when necessary. Use existing npm.cmd / paidan.cmd if PowerShell blocks .ps1; do not change execution policy or create PATH shims. A missing PATH command does not prove an application is absent.

### 2. Inspect selected endpoints; ask only about ambiguity

```sh
paidan setup --endpoint zcode --endpoint omp
```

setup is an agent-facing, noninteractive tool. It returns all known installation candidates, versions, current selections, native menus, host skill locations and an editable choices template. It does not inspect unselected endpoints, dispatch tasks, run probes or write paidan configuration/model caches.

Show and adopt a sole valid entry. Preserve an explicitly pinned entry. With multiple installations, show full paths, versions and sources and ask the user; do not pick by version or modification time. Query the chosen entry with `setup --endpoint zcode --bin "<chosen-full-path>"`. Read checked/notes before asking. The agent may inspect shortcuts or custom directories, then pass an installation folder or application path using `setup --endpoint zcode --location "<directory-or-file>"`. Repeat location for multiple hints. The program verifies the actual entries; hints do not authorize choosing between multiple candidates. Defer an unresolved endpoint while continuing others.

ZCode also checks Windows installation records and shortcuts, including custom drives; its executable, resources and user configuration are separate locations. DSH checks its native home, npm layouts and matching packages in the actual npm cache. No npx download is triggered. A missing cached entry requires locating and confirming a replacement.

Version drift is informational, not an installation probe requirement. Use `--cwd "<task-directory>"` for project-sensitive settings and the same directory for preview/application. Native tools may maintain their own caches; paidan does not manage authentication or quota.

A selected entry with version_error needs a runtime/startup/exit-code/timeout diagnosis. Saving returns SETUP_VERSION_FAILED; do not repeatedly ask the user to choose the same path.

### 3. Let users choose combinations freely

Use the preceding setup result without an extra models query. Re-query only when native settings change. Show current connection, model display name, exact ID and effort. Users may name changes directly or choose endpoint by endpoint. Do not ask “pin or follow?” again after an explicit combination, or add a preliminary “which ones should be pinned?” form.

Follow native by default and preserve existing paidan pins. For changes, establish the connection, then show its actual models and per-model efforts. A sole connection can be shown and retained; multiple connections need a choice. Use display name, exact ID and effort columns, not a few model/effort bundles. Accept natural language and exact IDs; only a unique match is selectable, never the nearest name. Unknown catalogs/efforts remain unknown. Login/quota issues or skipped verification do not remove an endpoint.

Reuse enabled ZCode API connections; explain native API setup only when one is missing. DSH remains native-owned and must not offer a fictitious paidan pinning option.

### 4. Preview and apply one summary

Save the returned choices template to a temporary JSON file and enter the user's choices. This is machine input, not a JSON form for the user:

- endpoints.<name>.locations: optional absolute directory/file hints; the program resolves and saves the verified exact entry.
- endpoints.<name>.bin: full selected entry; required to resolve multiple candidates. A sole candidate is adopted and pinned by setup.
- native:true: follow native as a whole. Otherwise model is the exact ID or a unique catalog display name, and effort is that model's level. Omission preserves a saved value; explicit null follows native for that field.
- ZCode fixed choices use provider, model, effort. Setup builds a dedicated native file containing only the chosen provider and its providerModelRules/manualProviderModelRules, preserving original files and desktop defaults.
- DSH native changes use native_settings: {"provider":"chosen-route","model":"chosen-model","effort":"chosen-level"}. This changes the native settings.yaml and affects other native sessions; disclose it. The program only edits these three fields in an ordinary block mapping, preserving other content/comments. Unsupported YAML is refused; use DSH native settings instead of agent-written YAML. Unknown model access/effort stays unverified.
- mode: optional persistent permission preset; omission preserves it, null restores the endpoint default. No additional permission questionnaire.
- enabled:false: disable only this endpoint, retaining its stored entry/choices. Do not combine it with other endpoint fields.
- default_endpoint: preserve the current default; choose when multiple new endpoints have none. A sole endpoint becomes the new default; explicit null clears the default.
- hosts: optional names from setup.hosts. The current host is the agent performing installation and expected to send tasks; ask only if unclear. Adding an endpoint does not automatically install its host skill. Use endpoints:{} for skill-only installation. Differing existing skills remain untouched; after reviewing the difference and approving replacement, use {"name":"codex","replace":true} for that host.

```sh
paidan setup --choices "<choices.json>"
```

Present decisions/files as a short human summary: endpoint selections, default endpoint, host skills and files to create or back up/update. Disclose and obtain approval for ZCode's local API-credential copy in its native directory. Never display the key. Include headless defaults from the table below, preserving existing permission choices; do not add a permission questionnaire. Existing authorization need not be repeated.

After approval, the agent carries the returned internal confirmation value:

```sh
paidan setup --choices "<choices.json>" --apply --expect "<returned-confirmation>"
```

Users never transcribe hashes. Setup rechecks selections and destinations and refuses stale previews. Assess actual changes instead of blindly refreshing and retrying. It merges configuration, pins entries, records selection contexts automatically, performs selected native changes, installs skills and merges the installation receipt. Do not inspect dist to guess schemas, improvise copy scripts or rerun init.

### 5. Finish with the result

Report applied/written/receipt and unresolved query limitations. The program records actual completed files, ownership, hashes, versions, entry sources and backups; the agent never writes a separate receipt. Saving already validates structure and choices; do not repeat every scan. Use `paidan doctor --endpoint <name>` for concrete remaining problems. No mandatory synthetic task; the first real task can verify invocation. Partial write errors identify completed files and backups; do not blindly roll back later user changes.

Give a valid example: `paidan run --endpoint <name> --task "task description"`. Do not claim permissions, authentication or unknown capabilities were live-verified.

## Headless permissions are separate defaults

Keep the established endpoint mappings: seven endpoints default to workspace-write; ZCode defaults to unattended. This controls delegation without changing the user's interactive CLI approval settings. Native deny/organization policies still apply, and equal preset names do not imply equal OS-level sandboxing.

| Endpoint | Default invocation and approval handling |
|---|---|
| kimi-code | Native print-mode auto permission; no enforceable headless read-only preset. |
| codex | exec -s workspace-write with approval_policy=never, including never on resume. Interactive on-request is not inherited; restricted actions fail. Resume retains the original session sandbox. |
| claude-code | Print mode acceptEdits plus permission-prompts=none. Operations needing host approval are denied, but native allow rules still apply. No-prompt is not enforced read-only: paidan rejects read-only requests for this endpoint rather than modifying user allow rules. |
| zcode | Native yolo, paidan unattended, is the only supported headless mode. Explicit read-only/workspace-write requests are rejected, not converted to yolo. |
| opencode | run --agent build with native permission rules. No interactive approval channel is provided; --auto requires an explicit unattended selection. |
| omp | Print mode approval-mode=write. This tier allows reads/writes; exec-tier approval requests fail closed. Native deny rules remain effective; yolo requires an explicit selection. |
| dsh | Native headless profile/sandbox/settings and inherited DSH_PERMISSION_MODE. No approval channel or unattended preset. Read-only is selectable through the environment, never invented positional flags. |
| agy | accept-edits plus native allow rules. The verified Windows setup needs read_file(*) and command(*); explain missing rules and obtain consent for the specific native edits. The runtime never broadens them, and declared soft enforcement remains soft. |

Use these defaults without mandatory per-endpoint permission menus; tell users they can adjust them. A one-run change uses --mode; a persistent change uses endpoints.<endpoint>.mode in setup choices; the program writes defaults.modes. Precedence: explicit --mode → defaults.modes → endpoint default. Unsupported selections fail without fallback or escalation. Explicit read-only task scope requires an explicit read-only preset; defaults do not expand the authorized task scope.

## Endpoint-specific configuration

Use only the user-selected branches, against the chosen binary and native environment.

| Endpoint | Connection → model → effort | paidan overrides |
|---|---|---|
| kimi-code | Real provider mappings, OAuth/API type and protocol; model overrides take precedence over base metadata. Raw provider JSON contains credentials: show paidan's whitelisted output only. | Save the full model alias. Fix effort only for effort_selectable=true models and their declared effort_options; other protocols follow native effort. |
| zcode | Check companion resources, desktop versus CLI connections, and the version's provider rules; select provider before model/reasoning. | Print only: follow native, or set endpoints.overrides.zcode.provider_config to an approved dedicated native JSON. No model/effort argv overrides. |
| codex | The selected CLI's debug models exposes visible models and model-specific efforts alongside native and saved defaults. A custom provider without a native model catalog exposes only configured candidates, never a borrowed OpenAI lineup. Unresolved layers remain unknown. | defaults.models.codex / defaults.efforts.codex plus the user-approved defaults.selection_contexts.codex. Configuration changes require another user choice. |
| claude-code | Show native/saved defaults, alias mappings and per-model efforts. API/cloud routing is separate from model selection; login status does not prove the current gateway's billing route or access. | Save a full ID or dynamic alias and native effort, plus defaults.selection_contexts.claude-code from the approved query. Configuration changes require another choice. |
| opencode | Query resolved configuration in the task directory, native auth-type records and provider/model variants. An implicit native default remains unknown; never pick the first catalog row. Auth records do not prove quota. | Pin the full provider/model, a declared variant and the same query's selection_context. Configuration changes or unavailable selections require a user choice; declared custom variants pass through unchanged. |
| omp | Inherit OMP_PROFILE; show auth metadata, full selectors and per-model thinking. Read modelRoles.default without guessing fuzzy/role-based/automatic defaults or changing auxiliary roles. | Pin selector, thinking and selection_context. auto is native automatic effort. Multiple native accounts remain managed by OMP; model pinning is not account pinning. Disclose native fallback/role switching, and ask about native edits only if strict pinning is requested. |
| dsh | Show explicitly configured settings.yaml provider/model entries and the headless default reasoningEffort. Plugin catalogs, complex YAML and profile overrides may lie outside this menu; missing entries are not proof of unavailability. | Follow native. Change combinations in native settings, or submit approved native_settings through setup for a minimal agent-default-model edit. Unsupported YAML requires the native settings interface, not an agent-written patch. No paidan model/effort overrides or fictitious pinning option; never print credential-bearing dump-config output. |
| agy | Show native IDs, display names and ID-encoded effort; match the current display name to the catalog. Unknown account types remain unknown, not assumed Google OAuth. | Pin the full ID plus selection_context. A high/medium/low suffix already chooses the tier; do not ask again or add --effort. Context binding cannot observe every native login change; investigate actual failures. |

Native changes are previewed and written by setup. For unsupported settings, use the endpoint’s native settings mechanism; the agent must not improvise JSON/YAML edits or configuration copies. Use native login flows; never request secrets in chat or store them in paidan. Reuse existing setup when no change is needed.


Fixed selections for Codex, Claude Code, OpenCode, OMP and AGY store the same models query's selection_context in defaults.selection_contexts.<endpoint>. Setup saves this internal field automatically with the choice; agents do not supply or manually write it, and users never copy hashes or confirm it separately. Use models --cwd <task-directory> for project-sensitive configuration. Kimi validates current model/protocol capabilities; DSH follows native; ZCode retains its approved native JSON workflow.

## Claude Code: installation and configuration changes

Use the selected CLI's native login/API setup or CC Switch. paidan stores no credentials and does not rewrite native settings. A successful claude auth status does not prove that the current ANTHROPIC_BASE_URL gateway uses that subscription or is callable.

During installation, use the Claude Code setup result to show native/saved defaults, source labels, resolved_model mappings and per-model effort_options. Let the user follow native settings or fix a choice. Tier aliases are dynamic selectors and may all resolve to one model; prefer a discovered full ID when fixing a specific model. Unknown gateway capabilities stay unknown, and candidates are not account-access guarantees.

Following native omits defaults.models.claude-code and defaults.efforts.claude-code. A fixed choice stores the approved values and that query's selection_context as defaults.selection_contexts.claude-code. The digest checks user-level routing/model/effort settings, alias mappings, relevant environment, config home and CLI entry; credential values are excluded. Old unbound defaults require a user choice rather than automatic deletion or rebinding.

Changes return SELECTION_RECONFIRM_REQUIRED before dispatch, with another check before launch. Re-query current candidates and let the user choose one-run --native, a new --model/--effort/--selection-context combination, persistent defaults, another enabled endpoint or pause. Merely querying never updates approval. Do not redispatch active work or reuse sessions across connections by default.

Effort uses native --effort only, never an injected --settings override of user-forced environment. Unsupported known levels are reported; project/managed layers, native caps and server access are not fully resolved by the local snapshot. Diagnose errors and partial artifacts through get/recovery, distinguish task/network/permission failures from connection failures, and ask before switching routes or retrying. Existing headless permissions and native settings remain intact.

## Kimi Code endpoint setup

Select the current Kimi Code executable, not a same-named legacy Python kimi-cli. If needed, guide the user through native login or provider setup; paidan never stores API keys. Show each connection's auth_type/protocol, full model alias, resolved_model, model-specific efforts, and native defaults from the Kimi Code setup result. Follow-native omits both overrides. A fixed full alias uses native -m to select its provider, including separate OAuth/API connections; no configuration copy is needed. Editing that native alias definition changes what it routes to, so an alias is not a permanent account/billing lock.

Authentication and protocol are separate: both Kimi subscription login and Kimi API-key access can use the kimi protocol. Do not classify API-key access as OpenAI protocol automatically. Apply another protocol's capabilities only when the native provider actually declares it; no repeated protocol choice is needed when configuration is clear.

Native 0.43.1 request capture showed KIMI_MODEL_THINKING_EFFORT=high taking effect on the kimi protocol while OpenAI/Anthropic still sent native low. Save defaults.efforts.kimi-code only when effort_selectable=true and the selected model declares the level. Other protocols can pin a model while following native effort. Disabled optional thinking also prevents a guaranteed override; do not silently edit native settings to enable it.

KIMI_MODEL_NAME enables the native temporary alias __kimi_env_model__, overriding the file default; explicit -m takes priority over it. --native bypasses paidan defaults but retains native environment settings. Model overrides supersede base effort metadata. Explicit selections are checked before dispatch; missing aliases, unsupported protocols/levels or disabled thinking return an error for the user to resolve, without switching routes. Diagnose the error body: even provider.auth_error: 403 can mean a weekly quota limit, not a need to log in again. Print retains native auto permission and cannot enforce read-only. See the [native config](https://moonshotai.github.io/kimi-code/en/configuration/config-files) and [environment](https://moonshotai.github.io/kimi-code/en/configuration/env-vars.html) documentation. Discovery does not prove authentication/quota, and installation requires no real task.

## ZCode: prepare API access before connecting paidan

ZCode uses **print only, never app-server**. On the tested desktop 3.12.3 / CLI 0.16.5, desktop BigModel OAuth did not populate the standalone CLI identity entry. Desktop login alone does not establish print readiness. A native CLI account-login implementation exists, but paidan installation does not manage OAuth or replace login with configuration copying.

### Prerequisites

Only if setup finds no enabled API provider, guide the user to configure one in native ZCode Model Settings, then query again. Reuse an existing connection. For Coding Plan, use its corresponding Coding Plan API Key connection and the [official instructions](https://zcode.z.ai/en/docs/configuration). Distinguish ordinary API billing, Coding Plan API keys and desktop authorization. Users enter keys in the native UI, not in chat.

Select the real `<install-dir>/resources/glm/zcode.cjs`, asking when multiple installations exist; never create a PATH shim. Keep the companion `resources/config/provider/zcode-builtin.json`. paidan finds it relative to the selected entry and supplies the child environment only, preserving explicit environment values. Doctor checks the resource separately from authentication. Headless mode remains unattended/yolo; unsupported read-only/workspace-write requests are rejected. No mandatory paid test call during installation; skipped verification or exhausted quota does not remove the endpoint.

### Follow native or use a dedicated JSON

Installation uses setup’s native ZCode candidates. After installation, `paidan models --endpoint zcode --native` inspects the original provider rules, bypassing paidan’s dedicated file. Show provider names/IDs/access types, model candidates and effort_options. This reads local personal rules and bundled templates without starting ZCode or calling a model. Only configured, enabled API providers are listed; do not enable disabled entries. Runtime caches/account access can differ; unknown metadata needs native confirmation.

Following native leaves endpoints.overrides.zcode.provider_config unset. Neither mode uses defaults.models.zcode/defaults.efforts.zcode. An inherited ZCODE_PERSONAL_PROVIDER_CONFIG_FILE remains effective unless explicitly bypassed. Native selection is not an OAuth guarantee or a promise to use the first file entry.

Use setup's choices file with the selected bin, provider, model and effort. Its preview identifies the native target and discloses the credential copy. After approval, setup extracts only that enabled API provider, preserves both kinds of provider-specific model rules and sets the selected default. The agent need not rediscover the JSON schema or copy a whole native configuration.

The original v2/provider_config.json remains untouched. Dedicated files and backups stay inside the native home; paidan stores only their path. An existing different profile is shown as a backup/update: obtain approval for rebuilding that target. Later key changes require an approved profile resynchronization. Runtime dispatch only passes the path; it never copies or updates credentials. Neither mode adds paidan --model/--effort arguments to ZCode.

### Actual selection and failure handling

result.evidence.selection in paidan get reports expected, actual provider IDs/names/model/effort, source and matches_expected. It queries native model_usage rows for exactly the current sessionId + traceId + turnId. Missing/unrecognized evidence remains unknown, never inferred from settings or historical turns. Names are labels, not proof of account identity or billing.

A dedicated JSON sets a native default, not an absolute lock. Native fallback remains possible; matches_expected:false must be reported rather than described as successful pinning. Missing evidence cannot verify the requested combination either.

A missing/invalid file, auth/quota or task failure never automatically switches configuration or resubmits. Explain the failure and any operations/artifacts already produced, then ask whether to use native configuration. After consent, a new invocation can use paidan run --endpoint zcode --native ... . It bypasses the dedicated path and model/effort defaults for that run without editing saved configuration. Resume can retain the old session's selection; choose resume versus a fresh task based on task state and inspect new evidence. To follow native permanently, remove only this endpoint's dedicated-path override and handle any user environment override explicitly.

### Migration

The 0.1.8 app-server adapter is removed. With user confirmation, move defaults.models.zcode/defaults.efforts.zcode into a dedicated JSON, then remove those unsupported overrides. Never silently discard them and dispatch elsewhere. Old zapi_ handles cannot resume through print; retain old results and start a new print session.

Current bundles already read v2/provider_config.json. Do not copy it into cli or overwrite cli/config.json. Legacy registries are outside the program writer’s supported scope: use native settings or a compatible version, never an agent-written credential merge.

## Expand only when needed

### Fixed models/effort or connection problems

Use setup for installation and persistent changes. For an already configured endpoint with quota/authentication/model/effort errors, query:

```sh
paidan models --endpoint <name>
```

Every call reads the current discovery source; `--refresh` is retained for compatibility. Read `source` and `notes`, distinguishing native config, static aliases and live catalogs. Older `from_cache` / `stale` responses are historical. Candidates are not access/quota guarantees; a failed query must not be replaced with an old list presented as currently usable.

Codex queries the selected CLI's `debug models` and displays each model's `effort_options`, including max/ultra only where declared. The native command may use its own cache or bundled catalog; it does not prove authentication or quota. Older unsupported CLIs expose clearly labelled configuration candidates only. Custom connections without `model_catalog_json` do not inherit the OpenAI catalog; verify additional models/efforts with that provider's native setup or documentation. OpenCode's effort_accepts_custom permits model-defined variants. DSH and ZCode do not accept paidan model/effort overrides; dedicated ZCode selections live in native JSON.

Setup saves the current selection_context together with approved persistent Codex choices; the agent does not write the digest. This credential-free digest checks routing configuration, config home, entry, authentication-mode markers and relevant environment changes; it is not proof of account access or billing identity. Changed or unbound old fixed selections return `SELECTION_RECONFIRM_REQUIRED` before dispatch; the worker checks again before launch. Never update the digest merely to silence the check.

After the user chooses follow-native for this invocation, every endpoint supports `run --native` to bypass saved model and effort overrides together; ZCode also bypasses its dedicated provider JSON. Permissions and saved configuration stay unchanged. A one-run fixed Codex choice can use `--model <model> --effort <effort> --selection-context <current-value>`. Overriding only the model still inherits saved effort, so check the whole combination. Permanent follow-native removes only the approved endpoint overrides and their selection context.

For every endpoint, diagnose failures from specific errors, refusal evidence, terminal state and partial artifacts. Do not assume task/path/network/permission errors mean a model failure. `get.recovery` provides the submission-time native snapshot and requested overrides for comparison, not an automatic diagnosis. For auth/quota/model/connection evidence, query only the relevant endpoint's current routes and show endpoint, connection, model, effort, source and unverified aspects. Let the user choose native defaults, another combination, native setup, another enabled endpoint or pause. Never delete fixed settings, renew their context, change billing routes/permissions, or resubmit automatically. Before an approved retry, verify the prior task ended and inspect partial effects; do not reuse a session across connections by default.

Fixed defaults use `defaults.models.<endpoint>` / `defaults.efforts.<endpoint>`, not global model/effort. After changes through CC Switch or another native mechanism, following mode uses native configuration; explicit fixed choices are not silently deleted. Explain the issue, then let the user choose native login/setup, another model, another enabled endpoint or stopping. Never silently switch connections, billing routes or permissions.

### Deferring, skipping a test and disabling are different choices

- Unselected endpoints are untouched, including existing configuration.
- **Skip verification**: keep saved paths, enablement and defaults; say no real call was made.
- **Login/quota pending**: keep the configuration for later and list the pending issue.
- **Explicitly disable/remove an endpoint**: only then remove it from enabled; if it was the default, let the user choose a replacement or omit the default.
- When no endpoint has been configured, enabled may be empty with defaults.endpoint omitted; say paidan is installed but no endpoint is connected.

### Real testing only when explicitly requested

Do not make real-call verification a default closing question. If requested, explain account/quota use and send a minimal task; checking a reply does not require writing a file. Successful authentication/reply does not verify all file-writing or other capabilities.

Save run_id and inspect the final state/result. A wait timeout does not authorize resubmission; wait again or cancel with the user's authorization first. Failure or skipped verification does not automatically disable the endpoint. Before retrying, check that the old run ended and account for any partial edits.

## Update and uninstall

These workflows are performed by a local agent, without rerunning init or automatically upgrading other software. First identify the selected paidan entry/package version, config_path, actual data directory and installed skill targets. Inspect all nonterminal runs (pending/running/attention), not just the first 50 results: read state files in the confirmed data directory to avoid list's TTL cleanup side effect. Wait for work to finish, or cancel only as explicitly selected by the user and verify process exit, before replacing/removing software. Uninstalling is not cancellation.

### Program-maintained installation record

Setup and init share the writer, which merges install-receipt.json beside config_path. It records completed files, endpoint/host ownership, hashes, versions and backups; configuration entries include the selected CLI path/source/version. Local changes preserve other entries, and partial failure records completed writes only. An unreadable record is preserved and reported, never replaced with an empty one. Agents do not write or supplement the receipt.

The record contains no credentials or native configuration contents and does not authorize deletion. Old installations without receipts can be compared with packaged files; preserve uncertain/custom files. Writes and backups are per file, not a cross-file transaction. After forced termination, inspect actual files/backups; a missing receipt is not proof that nothing was written.

### 1. Update paidan

1. Identify the installation being updated and retain its old version/configuration. Back up successfully before any necessary migration; do not rewrite config if no migration is needed.
2. For npm global installs, use npm install -g paidan@latest (npm.cmd on PowerShell if needed), then verify the actual entry/version. Source installs update/build that checkout while preserving uncommitted work; updating npm is not updating a source checkout.
3. Sync new packaged skills only into previously user-selected hosts. Missing targets need explanation. Use setup with endpoints:{} and selected hosts to preview updates. Review differences against the receipt/old package; after approval use replace:true. The program compares, backs up, writes and records; do not copy files manually. Do not use init to bypass the comparison or install into newly discovered hosts.
4. Preserve endpoints, paths, connection/model/effort choices, defaults.modes, dataDir and ttlDays. Explain any changed permission defaults and retain the prior choice instead of silently granting more permission. Migrate only required fields; backup failure or concurrent file changes stop that write until reread/compared.
5. The program updates records for successful writes and preserves entries for failures. Run grouped basic checks on enabled endpoints, without a default model call. Before rollback, verify that the older package supports the current config; never blindly restore the entire old config.

### 2. Adapt after an upstream CLI update

1. Inspect only the updated endpoint and its native update mechanism, entry, version and configuration. A pinned path is not a pinned version: same-path replacement runs new bytes; versioned paths/old installations may need reselection.
2. Keep a compatible working entry. If relocation is necessary, show candidates and honor an existing explicit selection or ask the user; pass only that endpoint’s selected bin to setup for saving. Preserve all other settings and never switch account/billing routes automatically.
3. Check headless arguments, approval handling, model metadata and output protocol. Doctor drift is advisory, and unchanged CLI versions can still accompany changed desktop resources. ZCode also needs companion resource/provider-layout checks. Do not remove native/organization deny rules for compatibility.
4. For incompatibility, explain the specific mismatch: the user may update paidan, natively roll back the CLI or defer that endpoint. Do not patch vendor installations or cycle permission modes. Basic checks require no model call; real validation is performed only when explicitly requested.

### 3. Uninstall paidan

1. Settle active tasks and identify the installation first. Handle selected host skills before removing the package so diagnostic information remains available.
2. Remove only confirmed paidan skill files within the user's uninstall scope. Compare with recorded/package hashes; preserve customized or uncertain files pending the user's choice. Keep siblings and backups. Remove only verified ordinary empty directories, never a host skills tree or a symlink/junction target.
3. For a confirmed npm global install, use npm uninstall -g paidan. Keep source checkouts and user workspaces unless separately authorized; they are not disposable package directories.
4. Keep paidan config, installation records, backups and run history by default. For an explicit full cleanup, list the actual scope first. A custom dataDir/PAIDAN_HOME can be shared: never recursively delete that directory wholesale; remove only confirmed paidan-owned records and preserve task deliverables.
5. Keep native agent programs, login, sessions and configuration by default, including approved ZCode provider merges/AGY allow rules. If rollback is requested, compare recorded changes with native backups and reverse only attributable edits. Changed file hashes with uncertain later edits require preserving/explaining the conflict, not restoring an entire stale backup. Node.js/npm/other agents remain installed.

Preserve partial successes; the agent describes the outcome in its own words.

## Agent lookup and diagnostic reference

### Common Windows entry points

| Endpoint / command | Candidate entry files and limits on Windows |
|---|---|
| kimi-code / `kimi` | `%USERPROFILE%/.kimi-code/bin/kimi.exe`; also `%KIMI_INSTALL_DIR%/bin/kimi.exe` when customized. Distinguish the current CLI from legacy Python `kimi` installations; do not assume matching names mean compatible protocols. |
| codex / `codex` | Every discovered `codex.exe`; npm's `<npm-root>/@openai/codex/bin/codex.js` or its packaged native executable. Keep the installation intact: do not copy the exe away from its helpers. Desktop-bundled and npm CLIs may have different versions; installing the desktop app alone does not prove a usable CLI entry exists. |
| claude-code / `claude` | `%USERPROFILE%/.local/bin/claude.exe` for native installation; `<npm-root>/@anthropic-ai/claude-code/bin/claude.exe` for the recorded npm layout. Inspect the installed package's bin entry if its layout differs. |
| zcode / `zcode` | `<ZCode-install>/resources/glm/zcode.cjs`. Check Program Files, `%LOCALAPPDATA%/Programs/ZCode`, and the user's custom installation directory. Server installations may use `%USERPROFILE%/.zcode/server/agents/glm/zcode.cjs`. Select the CLI bundle, not the desktop exe. |
| opencode / `opencode` | A discovered native `opencode.exe`; the recorded npm layout is `<npm-root>/opencode-ai/bin/opencode.exe`. Other package managers/layouts require checking their actual entry. |
| omp / `omp` | `%LOCALAPPDATA%/omp/omp.exe`, or `%PI_INSTALL_DIR%/omp.exe`. The Bun package uses a TypeScript entry requiring Bun; the current paidan bin override does not support that launch recipe. Offer the native binary installation or skip, rather than passing the TS file or bun.exe as bin. |
| dsh / `dsh` | Native DSH_HOME/profile, npm layouts and the actual npm cache’s `_npx/<directory>/node_modules/@deepseek-ai/dsh/lib/bin.js`. The program checks package identity and entry presence; a missing cache never authorizes downloading another version. |
| agy / `agy` | The actual CLI `agy.exe` in its installation directory. No universal default directory is assumed; use discovered entries or ask the user where they installed it. |

These are search hints, not an exhaustive inventory. Expand variables and check user-supplied locations; on POSIX use `type -a` and native package-manager layouts. paidan wraps `.js/.cjs/.mjs` entries with Node automatically.

### Doctor fields

`effort_options_scope` distinguishes adapter syntax/examples from model compatibility. `effort_accepts_custom` permits native custom variant names where declared; use the selected model’s metadata. `runtime_resources` reports ZCode companion catalog readiness separately from authentication.

`config_path` is the program-managed configuration location; honor `PAIDAN_HOME`. `endpoints` contains single matches. `model_selectable`, `effort_options`, and `permission.presets` describe the adapter. `native_defaults` is a partial snapshot; `credential_ready: null` means authentication is unverified. `hosts[].source/target` and `package_root` locate packaged skills and destinations.

`ok: true` means doctor ran; `spawn_supported` covers only the launch method. Also read `version_error`, `repair_hint`, and `issues`. Endpoint filtering retains global configuration and host diagnostics, but does not probe unselected endpoints' versions/native state. Backup, comparison, validation and installation records are handled by the program.

### Source installation and optional init

For source, use `npm install`, `npm run build`, then replace every `paidan` invocation in this guide with `node dist/cli.js`; `npm i -g .` is optional. Git is needed only to clone. Use the same installation throughout.

`paidan init` is an optional terminal UI over the same discovery/planner/writer as setup. Multiple installations require an explicit choice. --yes adds uniquely resolved entries while preserving existing model/effort/context/default choices. Use setup for endpoint-specific maintenance or adding host skills.

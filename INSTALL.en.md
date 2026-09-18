# Install paidan with an agent

[简体中文](INSTALL.md) · English

For an agent with local shell/file access. Get the user's selected endpoints configured quickly. By default, do not call a model for a test, and do not configure every installed agent. This workflow merges configuration directly and does not require `paidan init`.

## Conversation language

For Chinese-speaking users, use Chinese for questions, choices, errors, confirmations and results. Default to Simplified Chinese when no preference is apparent; honor another requested language. Explain English errors before quoting them. Preserve commands, paths, model identifiers, JSON keys and error codes. Native tools and the optional init wizard may still display English.

## Default flow

### 1. Install paidan and ask once which agents to connect

Ask in **one multi-select question** which endpoints to connect: kimi-code, codex, claude-code, zcode, opencode, omp, dsh, agy. Mention known installations if helpful. Do not ask eight sequential questions or investigate paths/models/login for unselected agents. A user's already stated selection needs no repeated question.

Only when a selected endpoint is absent, offer installation, a user-supplied location, or deferring its setup. Do not install additional agents by default.

### 2. Inspect only selected endpoints and resolve entry ambiguity

An initial grouped survey may inspect the selected endpoints, for example:

```sh
paidan doctor --endpoint codex --endpoint zcode
```

`--endpoint` is repeatable and does not require the endpoint to be enabled. Omitting it surveys all endpoints. Older releases without filtering may use one initial full doctor survey, then act only on the user's selections.

Doctor reports one current match per endpoint, **not every installed version**. Inspect all PATH matches, the existing paidan override, and the relevant locations in the reference table below. Search those locations, not every disk.

```powershell
Get-Command codex -All -ErrorAction SilentlyContinue |
    Select-Object CommandType, Source
where.exe codex
npm root -g
```

Use existing launchers to find the real executable/Node.js bundle, rather than selecting a PowerShell alias, function, or `.cmd/.bat/.ps1` wrapper. Check each entry's `--version` with a short timeout; use `node "<bundle>" --version` for Node.js scripts. Deduplicate identical real files, but retain separate installations even at the same version.

- **One valid candidate**: show its path/version/source and include it in the configuration summary; do not add a separate selection question.
- **Multiple installation candidates**: show a path/version/source/check-result table and let the user choose. Do not silently pick the first PATH hit or highest version.
- **No valid candidate**: explain the issue and offer locating, installing, or deferring the endpoint.

Keep an existing explicitly pinned entry unless it fails or the user requests a change. Pin the chosen absolute file path in `endpoints.overrides.<name>.bin`. If it later moves, report the problem instead of changing installations automatically.

### 3. Identify the connection before choosing model and effort

Inspect the selected CLI's native context using the endpoint recipes below. Show its current connection/account type, model and effort, with the source and any unknowns. A provider/vendor name is not an account or billing method: login subscriptions, API keys and gateways can coexist.

If ZCode is selected, complete its native API-key prerequisites below before installing paidan. Deferring it only skips that endpoint; continue with the others.

Check Node.js >= 24, then install:

```sh
npm i -g paidan
paidan --version
```

Discuss missing prerequisites only when necessary. npm installation needs no Git. If PowerShell blocks a `.ps1` launcher, use the existing `npm.cmd` / `paidan.cmd`; do not change execution policy or create PATH shims. A terminal/parent app may retain an old PATH after installation; restart that caller or use the full entry path when needed.

“Follow native” covers connection, model and effort only. Headless permissions/approval handling are separate: use the endpoint defaults below instead of inheriting interactive user/SDK-host approval policies.

For each selected endpoint, query `paidan models --endpoint <name>` once. Show its current native connection/model/effort, existing paidan defaults, and the discovered model menu with per-model efforts; let the user choose follow-native or a fixed combination. Inspect `native_defaults`, `configured_defaults`, `connections`, and each model's `connection`, `source`, and `effort_options`. A compact table and one choice are enough. Before saving the chosen entry, use an isolated temporary `PAIDAN_HOME` with that same absolute binary override; do not inspect a different PATH match.

- Show and adopt a single clear connection. With multiple account/billing routes, show the current selection and alternatives and obtain the user's choice, unless already explicit.
- Following native means the whole connection/model/effort combination. Do not retain an old effort while clearing only the model override.
- For customization: connection first, then its model, then that model's declared effort options. Missing/null metadata means unknown; an explicit empty list means no declared selectable levels.
- Configured entries, catalog membership, authentication and actual quota/access are different evidence. No synthetic call is required; pending login/quota or skipped verification preserves setup.

### 4. Confirm one configuration summary

Collect routine choices into a short summary:

- Selected endpoints and entry paths.
- Chosen connection/account type and the user's follow-native or fixed model/effort choice. Preserve already explicit choices without asking again.
- Use the endpoint's headless permission default and tell the user it can be adjusted. Preserve existing defaults.modes; do not add eight mandatory permission menus.
- With one endpoint, use it as the new default. With multiple endpoints, choose the default in this summary; preserve an existing valid default.
- Propose installing the paidan skill into the **current host** as part of the same confirmation. Additional hosts are optional; ask if the current host is unclear.

Show the current combination and discovered menu during installation, then let the user choose follow-native or fixed values. No real task is required. Explain incomplete/failed discovery; offer native defaults, setup, or skipping verification without inventing an accessible model list. Do not reconfirm already authorized choices. Skill destinations must appear in the approved summary; directory presence alone is not consent to install into every host.

**When ZCode is selected, explain its special requirements below. Explicitly describe and obtain consent for any native configuration changes.** This may be included in the same summary, but a generic request to install paidan is not consent to modify ZCode's credentials/settings.

### 5. Save, check basic configuration, and finish

Back up an existing paidan config once, then merge the user's choices while preserving unrelated keys. Use JSON serialization and UTF-8 without BOM. Store actual absolute file paths with forward slashes or escaped backslashes, without `node`, arguments, or wrapping quotes.

Example structure only; replace the path:

```json
{
  "endpoints": {
    "enabled": ["kimi-code"],
    "overrides": {
      "kimi-code": { "bin": "<absolute-path-to-selected-kimi.exe>" }
    }
  },
  "defaults": {
    "endpoint": "kimi-code",
    "models": {},
    "efforts": {}
  }
}
```

The default endpoint must be enabled. Native defaults mean absent model/effort entries, not null/empty strings. Remove old fixed entries only when the user chooses to return to native settings. Preserve dataDir, ttlDays, timeouts and other endpoint settings. Do not run init afterward; it can replace these choices.

Locate only approved host variants using doctor.hosts[].source/target (or packaged skills/hosts.json on older versions). Confirm custom homes and check the target and ancestors within the selected skills tree for symlinks/junctions; inspect the actual destination before following any link. Create absent files; leave identical files untouched. For a confirmed unmodified old package copy, back up successfully before updating. For custom or ownership-unknown content, preserve it, show non-secret differences and let the user keep, merge or replace. Approval to install a skill is not approval to discard customization, and a backup does not replace that choice. Recompare immediately before writing; intervening changes stop that operation. Verify the result and update the local installation record below. No init is needed, and identical/already authorized updates need no repeated questions.

After saving, run **one grouped check of selected endpoints**, not a full doctor survey for each endpoint. Fix relevant schema/semantic errors and check entry existence/version output. `drift` is a compatibility warning, not an automatic requirement to run probes during installation.

Let the installing agent describe the actual outcome in its own words; no fixed closing script or format is required. **Do not send a synthetic task, generate ok.txt, or require a successful model call to finish configuration by default.** The first real task can provide actual-call verification.

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

Use these defaults without mandatory per-endpoint permission menus; tell users they can adjust them. A one-run change uses --mode; a persistent change uses defaults.modes.<endpoint>, for example `"modes": { "codex": "read-only" }`. Precedence: explicit --mode → defaults.modes → endpoint default. Unsupported selections fail without fallback or escalation. Explicit read-only task scope requires an explicit read-only preset; defaults do not expand the authorized task scope.

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
| dsh | Show explicitly configured settings.yaml provider/model entries and the headless default reasoningEffort. Plugin catalogs, complex YAML and profile overrides may lie outside this menu; missing entries are not proof of unavailability. | Follow native. Change combinations in native settings, or obtain consent for a minimal agent-default-model edit. No paidan model/effort overrides or fictitious pinning option; never print credential-bearing dump-config output. |
| agy | Show native IDs, display names and ID-encoded effort; match the current display name to the catalog. Unknown account types remain unknown, not assumed Google OAuth. | Pin the full ID plus selection_context. A high/medium/low suffix already chooses the tier; do not ask again or add --effort. Context binding cannot observe every native login change; investigate actual failures. |

Before native changes, identify the exact file/native command, fields and impact, and obtain consent for that change. Preserve unrelated settings. Use native login flows; never request secrets in chat or store them in paidan. Reuse existing setup when no change is needed.


Fixed selections for Codex, Claude Code, OpenCode, OMP and AGY store the same models query's selection_context in defaults.selection_contexts.<endpoint>. The installing agent handles this internal field as part of the existing choice, without asking users to copy hashes or confirm again. Use models --cwd <task-directory> for project-sensitive configuration. Kimi validates current model/protocol capabilities; DSH follows native; ZCode retains its approved native JSON workflow.

## Claude Code: installation and configuration changes

Use the selected CLI's native login/API setup or CC Switch. paidan stores no credentials and does not rewrite native settings. A successful claude auth status does not prove that the current ANTHROPIC_BASE_URL gateway uses that subscription or is callable.

During installation, query `paidan models --endpoint claude-code` and show native/saved defaults, source labels, resolved_model mappings and per-model effort_options. Let the user follow native settings or fix a choice. Tier aliases are dynamic selectors and may all resolve to one model; prefer a discovered full ID when fixing a specific model. Unknown gateway capabilities stay unknown, and candidates are not account-access guarantees.

Following native omits defaults.models.claude-code and defaults.efforts.claude-code. A fixed choice stores the approved values and that query's selection_context as defaults.selection_contexts.claude-code. The digest checks user-level routing/model/effort settings, alias mappings, relevant environment, config home and CLI entry; credential values are excluded. Old unbound defaults require a user choice rather than automatic deletion or rebinding.

Changes return SELECTION_RECONFIRM_REQUIRED before dispatch, with another check before launch. Re-query current candidates and let the user choose one-run --native, a new --model/--effort/--selection-context combination, persistent defaults, another enabled endpoint or pause. Merely querying never updates approval. Do not redispatch active work or reuse sessions across connections by default.

Effort uses native --effort only, never an injected --settings override of user-forced environment. Unsupported known levels are reported; project/managed layers, native caps and server access are not fully resolved by the local snapshot. Diagnose errors and partial artifacts through get/recovery, distinguish task/network/permission failures from connection failures, and ask before switching routes or retrying. Existing headless permissions and native settings remain intact.

## Kimi Code endpoint setup

Select the current Kimi Code executable, not a same-named legacy Python kimi-cli. If needed, guide the user through native login or provider setup; paidan never stores API keys. Show each connection's auth_type/protocol, full model alias, resolved_model, model-specific efforts, and native defaults from `paidan models --endpoint kimi-code`. Follow-native omits both overrides. A fixed full alias uses native -m to select its provider, including separate OAuth/API connections; no configuration copy is needed. Editing that native alias definition changes what it routes to, so an alias is not a permanent account/billing lock.

Authentication and protocol are separate: both Kimi subscription login and Kimi API-key access can use the kimi protocol. Do not classify API-key access as OpenAI protocol automatically. Apply another protocol's capabilities only when the native provider actually declares it; no repeated protocol choice is needed when configuration is clear.

Native 0.43.1 request capture showed KIMI_MODEL_THINKING_EFFORT=high taking effect on the kimi protocol while OpenAI/Anthropic still sent native low. Save defaults.efforts.kimi-code only when effort_selectable=true and the selected model declares the level. Other protocols can pin a model while following native effort. Disabled optional thinking also prevents a guaranteed override; do not silently edit native settings to enable it.

KIMI_MODEL_NAME enables the native temporary alias __kimi_env_model__, overriding the file default; explicit -m takes priority over it. --native bypasses paidan defaults but retains native environment settings. Model overrides supersede base effort metadata. Explicit selections are checked before dispatch; missing aliases, unsupported protocols/levels or disabled thinking return an error for the user to resolve, without switching routes. Diagnose the error body: even provider.auth_error: 403 can mean a weekly quota limit, not a need to log in again. Print retains native auto permission and cannot enforce read-only. See the [native config](https://moonshotai.github.io/kimi-code/en/configuration/config-files) and [environment](https://moonshotai.github.io/kimi-code/en/configuration/env-vars.html) documentation. Discovery does not prove authentication/quota, and installation requires no real task.

## ZCode: prepare API access before connecting paidan

ZCode uses **print only, never app-server**. On the tested desktop 3.12.3 / CLI 0.16.5, desktop BigModel OAuth did not populate the standalone CLI identity entry. Desktop login alone does not establish print readiness. A native CLI account-login implementation exists, but paidan installation does not manage OAuth or replace login with configuration copying.

### Prerequisites

Before installing/connecting paidan, guide the user to configure and enable a working API Key provider in native ZCode Model Settings. For Coding Plan, use its corresponding Coding Plan API Key connection and the [official instructions](https://zcode.z.ai/en/docs/configuration). Distinguish ordinary API billing, Coding Plan API keys and desktop authorization. Users enter keys in the native UI, not in chat.

Select the real `<install-dir>/resources/glm/zcode.cjs`, asking when multiple installations exist; never create a PATH shim. Keep the companion `resources/config/provider/zcode-builtin.json`. paidan finds it relative to the selected entry and supplies the child environment only, preserving explicit environment values. Doctor checks the resource separately from authentication. Headless mode remains unattended/yolo; unsupported read-only/workspace-write requests are rejected. No mandatory paid test call during installation; skipped verification or exhausted quota does not remove the endpoint.

### Follow native or use a dedicated JSON

Run `paidan models --endpoint zcode --native` and show provider names/IDs/access types, model candidates and effort_options. This reads local personal rules and bundled templates without starting ZCode or calling a model. Only configured, enabled API providers are listed; do not enable disabled entries. Runtime caches/account access can differ; unknown metadata needs native confirmation.

Following native leaves endpoints.overrides.zcode.provider_config unset. Neither mode uses defaults.models.zcode/defaults.efforts.zcode. An inherited ZCODE_PERSONAL_PROVIDER_CONFIG_FILE remains effective unless explicitly bypassed. Native selection is not an OAuth guarantee or a promise to use the first file entry.

For a dedicated profile, let the user select provider, model and effort. Explain its native destination (for example under `~/.zcode/paidan/`), selected combination, and that it copies the selected API connection including its key. After user confirmation, the installing agent creates it without replacing the original v2/provider_config.json, cli/config.json or desktop defaults:

1. Select exactly one enabled API provider by ID in the current native provider_config.json. Copy only its complete rule, including templateId/connection settings, and its providerModelRules/manualProviderModelRules. Do not copy unrelated providers or credentials.json.
2. Use schemaVersion 1. config.providerConfigRules.providerRules contains the selected provider; config.modelConfigRules contains the two filtered arrays; config.defaultModelSelection carries providerId, modelId and options.reasoningLevel. config.providerOrder may contain just the chosen ID. Use the selected candidates, not hardcoded model/effort choices.
3. Keep the file and backups inside ZCode's native directory. Check destination/parent links cannot redirect credentials outside it. Create new files exclusively; compare existing files and preserve custom edits. Explain fields and obtain the selected scope before replacing them. Never put secrets/file contents into chat, paidan config, the repo or extra logs.
4. Save only the absolute path in endpoints.overrides.zcode.provider_config, preserving bin and unrelated settings. The runtime passes the path and never copies/updates credentials. Record ownership/path/selection for maintenance and uninstall. A later API-key change requires an approved update to this profile copy.

Neither mode uses paidan --model/--effort overrides for ZCode. The installing agent performs this setup; init does not automatically create credential files.

### Actual selection and failure handling

result.evidence.selection in paidan get reports expected, actual provider IDs/names/model/effort, source and matches_expected. It queries native model_usage rows for exactly the current sessionId + traceId + turnId. Missing/unrecognized evidence remains unknown, never inferred from settings or historical turns. Names are labels, not proof of account identity or billing.

A dedicated JSON sets a native default, not an absolute lock. Native fallback remains possible; matches_expected:false must be reported rather than described as successful pinning. Missing evidence cannot verify the requested combination either.

A missing/invalid file, auth/quota or task failure never automatically switches configuration or resubmits. Explain the failure and any operations/artifacts already produced, then ask whether to use native configuration. After consent, a new invocation can use paidan run --endpoint zcode --native ... . It bypasses the dedicated path and model/effort defaults for that run without editing saved configuration. Resume can retain the old session's selection; choose resume versus a fresh task based on task state and inspect new evidence. To follow native permanently, remove only this endpoint's dedicated-path override and handle any user environment override explicitly.

### Migration

The 0.1.8 app-server adapter is removed. With user confirmation, move defaults.models.zcode/defaults.efforts.zcode into a dedicated JSON, then remove those unsupported overrides. Never silently discard them and dispatch elsewhere. Old zapi_ handles cannot resume through print; retain old results and start a new print session.

Current bundles already read v2/provider_config.json. Do not copy it into cli or overwrite cli/config.json. Only confirmed legacy layouts may need a narrowly approved provider merge; that historical workaround is not a universal OAuth fix.

## Expand only when needed

### Fixed models/effort or connection problems

During installation, for customization, or for quota/authentication/model/effort errors, query:

```sh
paidan models --endpoint <name>
```

Every call reads the current discovery source; `--refresh` is retained for compatibility. Read `source` and `notes`, distinguishing native config, static aliases and live catalogs. Older `from_cache` / `stale` responses are historical. Candidates are not access/quota guarantees; a failed query must not be replaced with an old list presented as currently usable.

Codex queries the selected CLI's `debug models` and displays each model's `effort_options`, including max/ultra only where declared. The native command may use its own cache or bundled catalog; it does not prove authentication or quota. Older unsupported CLIs expose clearly labelled configuration candidates only. Custom connections without `model_catalog_json` do not inherit the OpenAI catalog; verify additional models/efforts with that provider's native setup or documentation. OpenCode's effort_accepts_custom permits model-defined variants. DSH and ZCode do not accept paidan model/effort overrides; dedicated ZCode selections live in native JSON.

When fixing a Codex model or effort, save that query's `selection_context` unchanged as `defaults.selection_contexts.codex` alongside the approved values. This credential-free digest checks routing configuration, config home, entry, authentication-mode markers and relevant environment changes; it is not proof of account access or billing identity. Changed or unbound old fixed selections return `SELECTION_RECONFIRM_REQUIRED` before dispatch; the worker checks again before launch. Never update the digest merely to silence the check.

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

### Minimal local installation record

The installing agent merges an install-receipt.json beside config_path: paidan version; each actually installed skill's host, absolute target, installed SHA-256 and prior-file backup if any; approved native file changes with field names, post-change file SHA-256 and backup location inside the native directory. Record successful operations only and retain other hosts' records. Preserve an unreadable/corrupt record rather than replacing it with an empty one.

This is agent-maintained, not automatically generated by the CLI, and never authorizes deletion. Store no credentials, native config contents or secret field values. Older installations without records remain maintainable by comparing with the corresponding package version; preserve uncertain/custom files and ask about those differences. Revalidate recorded paths against the actual installation scope; do not recursively follow symlinks/junctions.

### 1. Update paidan

1. Identify the installation being updated and retain its old version/configuration. Back up successfully before any necessary migration; do not rewrite config if no migration is needed.
2. For npm global installs, use npm install -g paidan@latest (npm.cmd on PowerShell if needed), then verify the actual entry/version. Source installs update/build that checkout while preserving uncommitted work; updating npm is not updating a source checkout.
3. Sync new packaged skills only into previously user-selected hosts. Missing targets need explanation. If current bytes match the recorded hash/old package, back up and update; if customized or ownership is uncertain, show non-secret differences and let the user keep, merge or replace. Do not use init to bypass the comparison or install into newly discovered hosts.
4. Preserve endpoints, paths, connection/model/effort choices, defaults.modes, dataDir and ttlDays. Explain any changed permission defaults and retain the prior choice instead of silently granting more permission. Migrate only required fields; backup failure or concurrent file changes stop that write until reread/compared.
5. Update records only for successful operations; retain old entries for failures. Run grouped basic checks on enabled endpoints, without a default model call. Before rollback, verify that the older package supports the current config; never blindly restore the entire old config.

### 2. Adapt after an upstream CLI update

1. Inspect only the updated endpoint and its native update mechanism, entry, version and configuration. A pinned path is not a pinned version: same-path replacement runs new bytes; versioned paths/old installations may need reselection.
2. Keep a compatible working entry. If relocation is necessary, show candidates and honor an existing explicit selection or ask the user; change only that endpoint's bin override. Preserve all other settings and never switch account/billing routes automatically.
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
| dsh / `dsh` | `%USERPROFILE%/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js`; for another profile/package layout inspect its actual `lib/bin.js`. |
| agy / `agy` | The actual CLI `agy.exe` in its installation directory. No universal default directory is assumed; use discovered entries or ask the user where they installed it. |

These are search hints, not an exhaustive inventory. Expand variables and check user-supplied locations; on POSIX use `type -a` and native package-manager layouts. paidan wraps `.js/.cjs/.mjs` entries with Node automatically.

### Doctor fields

`effort_options_scope` distinguishes adapter syntax/examples from model compatibility. `effort_accepts_custom` permits native custom variant names where declared; use the selected model’s metadata. `runtime_resources` reports ZCode companion catalog readiness separately from authentication.

`config_path` is the file to edit; honor `PAIDAN_HOME`. `endpoints` contains single matches. `model_selectable`, `effort_options`, and `permission.presets` describe the adapter. `native_defaults` is a partial snapshot; `credential_ready: null` means authentication is unverified. `hosts[].source/target` and `package_root` locate packaged skills and destinations.

`ok: true` means doctor ran; `spawn_supported` covers only the launch method. Also read `version_error`, `repair_hint`, and `issues`. Endpoint filtering retains global configuration and host diagnostics, but does not probe unselected endpoints' versions/native state. Backup, copy comparison and JSON validation stay internal to the agent.

### Source installation and optional init

For source, use `npm install`, `npm run build`, then replace every `paidan` invocation in this guide with `node dist/cli.js`; `npm i -g .` is optional. Git is needed only to clone. Use the same installation throughout.

`paidan init` remains an optional terminal shortcut using first-match discovery and may display English. `init --yes` reselects enablement, resets model/effort defaults, and installs selected host skills; do not run it merely to install a skill after careful configuration.

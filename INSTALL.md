# 让 agent 帮你安装 paidan

简体中文 · [English](INSTALL.en.md)

paidan 把任务委派给本机其他 AI CLI：发单的 agent 是“宿主”，接任务的 CLI 是“端点”，二者分别选择。本文供能执行本机命令的安装 agent 使用。目标是尽快完成用户选中端点的配置；默认不调用模型做测试，也不要求配置机器上的所有 agent。agent 负责沟通和补充查找线索，程序负责核验与全部配置写入，不依赖 `paidan init`。

## 交互语言

对中文用户，全程用中文提问、展示选项、解释故障和报告结果。没有明确语言偏好时使用简体中文；用户明确要求其他语言时跟随其选择。英文报错先说明原因和下一步，再按需附原文；命令、路径、模型标识、JSON 字段和错误码保持原样。原生工具或可选 init 向导的界面可能仍是英文。

## 默认流程

### 1. 确认要接入哪些端点，安装 paidan

先问本次接入哪些：kimi-code、codex、claude-code、zcode、opencode、omp、dsh、agy。接受名称、“都接”和自然语言，不为适配四选一控件把一个选择拆成多组。已有明确选择就直接继续。

检查 Node.js >= 24，安装并确认版本：

```sh
npm i -g paidan
paidan --version
```

只在确实缺运行环境时处理它。PowerShell 阻止 .ps1 时使用已有 npm.cmd / paidan.cmd，不修改执行策略，不创建 PATH shim。不要把“PATH 没命令”当成未安装；桌面随附的 CLI 由下一步查找。

### 2. 程序检查所选端点，歧义才问

```sh
paidan setup --endpoint zcode --endpoint omp
```

setup 是不交互的安装工具，返回所有已知入口候选、版本、当前组合、真实菜单、宿主 skill 位置和可编辑的 choices 模板。不扫描未选端点，不启动任务、不做 probe，也不写 paidan 配置或模型缓存。

- 唯一有效入口：简短展示并采用。已有明确固定的入口继续沿用。
- 多份安装：一次展示完整路径、版本与来源，让用户选；不因版本较新或更新时间较近就替用户决定。用 `setup --endpoint zcode --bin "<已选完整路径>"` 查询该入口的模型。
- 找遍已知位置仍没有：先看返回的 checked/notes。agent 可只读检查快捷方式、自定义目录，或请用户提供安装目录/桌面程序位置，再用 `setup --endpoint zcode --location "<目录或文件>"` 交回程序核验。location 可重复；它是线索，不代替多候选选择。找不到可暂缓，其余继续。
- 版本漂移只是兼容性提醒。安装不因 drift 触发 probe，查询失败也不要求用真实模型测试来补证。
- 已选入口出现 `version_error` 时，按启动失败、退出码或超时检查运行环境；保存会返回 `SETUP_VERSION_FAILED`，不要让用户反复选择同一路径。

ZCode 还查询 Windows 安装记录与快捷方式，不假定在 C 盘；安装目录、CLI 和用户配置目录分别识别，不复制 CLI 单文件。DSH 检查原生 home、npm 布局及实际 npm 缓存中的对应包；不执行 npx 下载，缓存失效后重新定位并让用户确认。

需要识别项目配置时加 `--cwd "<实际任务目录>"`，后续预览与应用用同一目录。原生查询可能更新端点自己的缓存，但 paidan 不接管认证、额度和登录。

### 3. 按用户意图展开组合，不塞推荐套餐

直接使用上一步 setup 返回的菜单，不另跑 models。用户修改原生设置后才定向重新查询。先展示所选端点的当前连接、模型显示名称、精确 ID 和强度。用户可以直接说哪些要改，也可以要求逐个选择。用户已经说清组合时直接记录，不再追问“是否固定”“固定哪些”。

默认沿用当前原生设置，已有 paidan 固定选择保留。要调整时先确定连接，再展示该连接的完整模型候选及逐模型强度；单一连接展示后沿用。菜单用“显示名称｜精确 ID｜强度”，不把模型与某个强度捆成几套预设。多条连接才问 provider；不把账号类型按厂商名称猜出来。

支持自然语言和直接输入 ID；能唯一对应显示名称或精确 ID 就采用，存在歧义才让用户选。不要取“最接近”的模型，也不要把选项之外的选择全部推给 Other。看不到完整目录或强度未知时说明范围，允许保留跟随、暂缓或先在原生工具中配置。

ZCode 已有启用 API 时直接选，不重复要求创建 Key；确实缺少时才展开下方接入准备。DSH 由原生设置管理，不展示假的固定选项。没额度、未登录、跳过验证都不等于移除端点。

### 4. 一份简短摘要，交给 setup 保存

将 setup 返回的 choices 模板保存为临时 JSON，填写用户的选择。这是给程序的输入，不是要求用户填写 JSON。它只包含端点名称、入口路径、选择与宿主名称，没有凭据或配置摘要：

- `endpoints.<名称>.locations`：可选的绝对目录/文件线索数组，适合 agent 补充查找；最终由程序保存核验后的精确入口。
- `endpoints.<名称>.bin`：选中的完整入口；多版本时必须填写。唯一候选可由程序采用并固定。
- `native: true`：整体跟随原生。固定时使用 `model`（精确 ID 或目录中唯一显示名称）、`effort`；省略项保留已有选择，显式 null 表示该项跟随原生。
- ZCode 固定组合使用 `provider`、`model`、`effort`。程序在 ZCode 原生目录生成仅含所选 provider 的专用文件，保留其 providerModelRules 和 manualProviderModelRules；原文件与桌面默认值不变。
- DSH 要调整原生默认时使用 `native_settings: {"provider":"已选标识","model":"已选模型","effort":"用户指定档位"}`。这修改 DSH 原生 settings.yaml，也影响其他原生会话；在摘要中说明。程序仅处理可识别的普通块式三个字段，保留其余内容和注释。复杂 YAML 会拒绝写入，改用 DSH 原生设置功能；不让 agent 手改 YAML。菜单与强度不完整时明确未验证，不猜选项。
- `mode`：可选权限默认；省略保留，null 恢复端点默认，不额外询问未要求调整的权限。
- `enabled: false`：只禁用这个端点，保留原有路径与组合；该项不混填其他字段。
- `default_endpoint`：已有默认保留，多个端点且尚无默认时让用户选；单端点自动作为新默认。明确传 null 可取消默认。
- `hosts`：可选，名称取自 setup 返回的 hosts。当前宿主就是正在帮助用户安装并将负责发单的 agent；宿主不明确时才询问。安装执行端点不自动安装它的宿主 skill；只补装 skill 可使用 `endpoints: {}`。已有不同 skill 会保留并返回冲突；用户看过差异并同意替换后，该宿主可写成 `{"name":"codex","replace":true}`。

```sh
paidan setup --choices "<选择文件.json>"
```

把返回的 decisions/files 整理成简短中文摘要：端点与组合、默认端点、宿主 skill、将创建或备份更新的文件。ZCode 专用文件可能包含所选 API Key 的本地副本，须在这次摘要中明确告知并取得授权；不展示 Key。权限沿用下表默认并告知可调整，已有权限选择保留，不逐家再问权限菜单。已有明确授权不重复询问。

用户确认后，agent 自动带入返回的 confirmation：

```sh
paidan setup --choices "<选择文件.json>" --apply --expect "<上一步返回的confirmation>"
```

confirmation 是内部校验值，不让用户抄写。程序重新检查选择和目标，变化时不写入；复看变化是否影响用户选择，不盲目刷新后强行重试。程序负责合并配置、固定入口、自动保存选择摘要、执行已选原生改动、安装 skill 和合并安装记录；不要再翻 dist 猜格式、手写复制脚本或运行 init。

### 5. 说明结果，结束安装

根据 applied/written/receipt 和端点查询说明收尾。install-receipt.json 由程序记录实际写入的路径、来源、版本、文件校验值和备份，agent 不另写账本。保存已完成结构与选择校验，不额外逐端点重复扫描；有具体未解决问题再用 `paidan doctor --endpoint <名称>` 定向检查。默认不派任务试跑，首次真实任务可承担实际调用验证。发生部分写入失败时说明哪些已完成及备份位置，保留原生文件，不擅自回滚后来修改。

对用户给出一条有效示例即可：`paidan run --endpoint <名称> --task "任务描述"`。不把原生权限、登录或未知能力说成已经实测通过。

## 无头权限默认：与模型默认分开

采用项目现有用法：七个端点默认 `workspace-write`，ZCode 默认 `unattended`。这是 paidan 的委派配置，不要求把用户平常手动使用 CLI 的审批模式一起改掉。端点的原生 deny/组织策略仍可能拒绝操作；同名预设也不代表各 CLI 都提供相同的系统级隔离。

| 端点 | 默认无头调用与审批处理 |
|---|---|
| kimi-code | `-p` 的原生 auto 权限。没有可强制的 headless 只读档，不伪造它。 |
| codex | `exec -s workspace-write`，调用时明确设置 `approval_policy=never`，不会继承交互式 `on-request`。越界操作被拒绝，结果由宿主处理。resume 仍恢复原会话 sandbox，不能靠本次 mode 改掉旧会话的权限。 |
| claude-code | `-p --permission-mode acceptEdits --permission-prompts none`。可自动编辑的操作照常执行，原本需要询问 host 的操作直接拒绝。原生已有 allow 仍然有效，所以“不询问”不是强制只读；paidan 不支持该端点的 read-only 请求，不修改用户 allow 规则来模拟只读。 |
| zcode | 唯一支持的无头档为 `--mode yolo`，对应 paidan 默认 `unattended`。不采用可能等待审批的 plan/edit，也不把用户明确的只读要求改成 yolo。 |
| opencode | `run --agent build`，保留原生 permission 规则；paidan 不提供交互审批通道，不默认添加 `--auto`。需要调整时由用户选择。 |
| omp | `-p --approval-mode write`。允许该档的读写，需审批的 shell 等操作在无头模式下拒绝；需要 yolo 时由用户明确调整。 |
| dsh | `--profile headless`，默认沿用原生 sandbox/settings 与调用方的 `DSH_PERMISSION_MODE`，无交互审批通道。可通过环境变量请求 `read-only`；不提供 unattended，不给任务参数硬塞不存在的权限 flag。 |
| agy | `--mode accept-edits`，配合原生 allow 规则。本机已验证的 Windows 配置需要 `read_file(*)`、`command(*)`；缺少时把具体原生改动纳入配置说明，经用户同意再处理，不由运行器偷偷放开。已标为 soft 的能力仍保持该标记。 |

直接采用默认即可，不要求用户先学会这些参数。需要调整时，本次调用使用 `--mode read-only|workspace-write|unattended`；持久调整使用 setup choices 中的 `endpoints.<endpoint>.mode`，由程序写入 `defaults.modes`。优先级为本次 `--mode` → `defaults.modes` → 端点默认。端点不支持用户所选档位时直接报告，不回退或升权。任务本身明确要求只读时，宿主应显式选择只读；默认权限不是扩大任务范围的授权。

## 各端点的配置方式

下表是端点分支，不是要求用户完成八套流程。只处理本次选中的端点；命令均使用已选入口及同一原生配置环境。

| 端点 | 连接、模型、强度的处理顺序 | setup 保存的结果及原生限制 |
|---|---|---|
| kimi-code | 按真实 provider 映射区分 OAuth/API 和协议，不根据别名前缀猜。模型菜单采用 overrides 后的元数据。原始 provider list JSON 含密钥，只展示 paidan 白名单输出。 | 完整别名写 `defaults.models.kimi-code`；仅 `effort_selectable=true` 的模型可固定强度，再按该模型 `effort_options` 选择。其他协议跟随原生强度。 |
| zcode | 先检查 CLI 配套资源，再区分桌面连接、CLI 配置和新版 provider rules。选择连接/provider 后才处理模型和推理档位；详见下一节。 | 仅 print：跟随原生，或把已确认专用 JSON 的绝对路径写入 endpoints.overrides.zcode.provider_config；不写模型/强度参数覆盖。 |
| codex | 所选 CLI 的 `debug models` 提供可见模型及各自强度；同时展示原生配置与 paidan 固定值。第三方 provider 无自定义原生目录时只列已配置模型，不借用 OpenAI 名单。profile/项目/托管覆盖未解析时明确未知。 | `defaults.models.codex`、`defaults.efforts.codex`，同时保存本次确认的 `defaults.selection_contexts.codex`。配置变化后先让用户重新选择。 |
| claude-code | 展示原生模型、已有固定值、别名→模型映射和逐模型强度。自定义地址/云路由与模型是不同设置；来源冲突标为未知，不凭登录状态推断当前计费连接。 | 保存完整模型 ID 或用户选择的动态别名、原生 `--effort`，同时保存本次确认的 `defaults.selection_contexts.claude-code`。连接/映射等变化后重新选择。 |
| opencode | paidan 查询所选 CLI 在当前任务目录解析的配置、原生认证类型记录和 provider/model → variants。未显式配置的默认模型保持未知，不拿目录第一项代替；认证记录不证明额度。 | 固定完整 provider/model 与该模型声明的 variant，并保存同次查询的 selection_context。换连接或固定组合失效时让用户重新选择；目录支持的自定义 variant 原样传递。 |
| omp | 继承当前 OMP_PROFILE；展示原生认证元数据、完整 selector 与逐模型 thinking。主模型读 modelRoles.default，模糊名称/角色引用/自动默认保持未知；不改 smol/slow/plan。 | 固定完整 selector、thinking 及同次 selection_context；auto 表示原生自动强度。多个原生账号仍由 OMP 管理，固定模型不等于固定账号。发现原生 fallback/角色切换时告知用户，需要严格固定才询问是否调整原生设置。 |
| dsh | 展示 headless profile 的 settings.yaml 中明确配置的 provider/model 与当前 reasoningEffort；原生插件内置目录、复杂 YAML 和 profile 覆盖可能不在菜单范围。缺项不代表不可用。 | 跟随原生；要换组合时用 setup 的 native_settings 明确选择，由程序最小修改 agent-default-model；不支持的 YAML 改用原生设置功能。paidan 不写模型/强度覆盖，不提供假的固定选项，也不直接输出可能含凭据的 dump-config。 |
| agy | 展示原生模型 ID、显示名称与 ID 自带的强度档位，并将当前显示名称与目录匹配。原生账号类型未知时直说，不推断 Google OAuth。 | 固定完整模型 ID 与 selection_context；带 high/medium/low 后缀时该档位已随模型选定，不额外询问或叠加 --effort。登录态变化未必能由配置摘要发现，调用失败后仍按实际错误检查。 |

原生改动通过 setup 预览目标、字段和影响后由程序完成；尚未支持的原生操作使用该工具自己的设置功能，不让 agent 自行拼 JSON/YAML 或复制配置。登录通过原生流程完成，不要求用户把 key/token 发进对话，不让 paidan 接管凭据。无须修改时直接沿用。


配置摘要绑定适用于 Codex、Claude Code、OpenCode、OMP、AGY 的固定选择：setup 自动将同次调查的 selection_context 写入 defaults.selection_contexts.<端点>，安装 agent 不传入或手写该字段。这是内部配置字段，不让用户抄写摘要、不增加一道确认；与模型/强度选择合并处理。Kimi 每次按当前模型/协议能力校验；DSH 跟随原生；ZCode 保留专用原生 JSON 的既定流程。

## Claude Code：安装、固定选择与配置变化

选定 CLI 后，使用它自己的登录/API 配置或 CC Switch 接入；paidan 不保存凭据，也不重写原生设置。`claude auth status` 显示已有登录，不代表当前 `ANTHROPIC_BASE_URL` 网关一定使用该订阅或已经可用。

安装使用 setup 的 Claude Code 结果，一并展示 `native_defaults`、`configured_defaults`、候选的 `source`、`resolved_model` 和 `effort_options`，让用户选择跟随或固定。`opus`、`sonnet`、`haiku`、`fable` 是动态选择器，可能都被映射到同一模型；固定某个具体模型时优先选查询到的完整 ID。静态别名、原生配置候选均不是账号可调用清单；自定义网关能力未知时明确说未知，不猜强度范围。

在 choices 中选择 native:true 或明确的 model/effort；配置和 selection_context 均由 setup 保存。摘要覆盖用户级原生模型/强度、别名映射、API 地址/云路由、相关环境、配置目录与 CLI 入口；不保存或比较密钥内容，换 key 本身不等于换模型通路。已有固定值但缺摘要时，也需要用户确认一次，不自动删除或补写。

原生配置变化后，固定选择会在派发前返回 `SELECTION_RECONFIRM_REQUIRED`；提交后到启动前再查一次，防止使用过期选择。宿主重新展示当前候选，让用户选择：本次 `--native` 跟随、用 `--model ... --effort ... --selection-context ...` 本次改选、更新持久默认、改用另一个已启用端点，或暂停。仅查询不会更新确认摘要，只有用户选定后才写回。原任务尚未结束时不重派；涉及新连接时不默认复用旧会话。

强度只传原生 `--effort`，不注入 `--settings` 去覆盖用户通过 CC Switch 等工具强制的环境设置。已知模型不支持的档位会在派发前报告；原生环境、组织限制仍可能影响有效值。项目设置、托管策略和服务端可用性并未被本地快照完整解析；遇到这些情况，按真实错误核对原生来源，再让用户选，不冒充已验证。

运行失败时，先读 `get` 的具体错误、`recovery` 中的提交时选择和已有产物。确认是连接/额度/模型问题后才刷新通路；普通任务、网络、路径或权限问题按各自原因处理。保留原配置，不轮流试模型或自动切换计费连接。无头权限沿用上表的 acceptEdits + permission-prompts=none，不改变用户已有规则。

## Kimi Code 作为端点

先选择正确的当前 Kimi Code CLI，避免误选同名的旧 Python `kimi-cli`。未配置接入时，引导用户在 Kimi 中登录，或通过原生 provider 功能添加 API；不要把 API Key 写进 paidan。

OAuth/API 是认证方式，与协议是两回事。Kimi 登录订阅和 Kimi API 接入都可以使用 `kimi` 协议；不要把 API Key 接入自动当成 OpenAI 协议。只有 provider 实际声明了其他厂商/协议时，才按该协议的能力处理，无需用户重复选择已明确的协议。

安装时按 setup 的 Kimi Code 结果展示连接的 `auth_type` / `protocol`、完整模型别名、实际模型名 `resolved_model`、逐模型强度与当前默认。用户选择整体跟随时不写模型/强度覆盖；固定时保存查询到的完整别名，原生 `-m` 会选中该别名对应的 provider，OAuth 与 API 可以分别选择，无需专用配置副本。别名指向用户原生定义；该定义本身被编辑后，以新定义为准，不把别名当成账号或计费身份的永久锁定。

**强度有协议差异。** 0.43.1 本机请求捕获中，`KIMI_MODEL_THINKING_EFFORT=high` 在 kimi 协议生效，但 OpenAI/Anthropic 协议仍发送原生 low。因此仅在 `effort_selectable=true` 且档位被该模型声明时保存 `defaults.efforts.kimi-code`；其他协议可固定模型，强度留给原生设置。`thinking_enabled=false` 且模型不是强制思考模型时，也不能声称显式强度已生效。不要为固定强度自行修改原生 thinking 设置。

`KIMI_MODEL_NAME` 会启用环境临时模型（原生别名 `__kimi_env_model__`），其默认优先于文件中的 `default_model`，显式 `-m` 又优先于环境模型。`--native` 只移除 paidan 的本次覆盖，会继续继承这些原生环境设置。模型 `overrides` 的支持档位/默认值优先于同一模型的基础元数据；配置快照不保证最终请求强度或额度。

派发前检查显式模型/强度：别名消失、所选协议无法传递强度、关闭 thinking 或档位不支持时，返回具体原因让用户重新选，不借用另一条接入。运行中失败沿用通用诊断流程；例如上游 `provider.auth_error: 403` 的正文可能是周额度耗尽，不能只按错误名要求重新登录。权限继续使用原生 print auto；paidan 无法为它强制只读。

规则依据：[原生配置文档](https://moonshotai.github.io/kimi-code/en/configuration/config-files)、[环境覆盖说明](https://moonshotai.github.io/kimi-code/en/configuration/env-vars.html)。仅查询配置不能证明认证或额度；安装仍不要求实际派单。

## ZCode 作为端点：先准备 API 接入，再配置 paidan

ZCode **只走 print，不启动 app-server**。桌面 3.12.3 / CLI 0.16.5 的本机实测中，桌面 BigModel OAuth 登录没有自动补齐独立 CLI 所需的身份条目；桌面已登录不保证 print 可用。CLI 自身存在账号登录实现，但 paidan 安装不代管 OAuth，也不以复制旧配置代替登录。

### 接入前准备

仅在 setup 没找到启用 API provider 时，引导用户在 ZCode 原生「模型设置」中配置并启用可用的 API Key provider，再重新查询。已有接入直接沿用。使用 Coding Plan 时，选择对应的 Coding Plan API Key 接入，按[官方配置指南](https://zcode.z.ai/cn/docs/configuration)准备 Key；区分普通按量 API、Coding Plan API Key 和桌面账号授权。用户在原生界面填写 Key，不要求发进对话。

选择实际 CLI 入口 `<安装目录>/resources/glm/zcode.cjs`；多版本时让用户选，不选桌面 exe，不创建 PATH shim。保留完整安装中的 `resources/config/provider/zcode-builtin.json`：paidan 从所选入口查找此配套资源，仅为子进程补入 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`，已有显式值不覆盖。`doctor.runtime_resources` 检查资源，版本命令不能证明认证可用。

无头权限默认 `unattended`，映射为 yolo；明确的只读或 workspace-write 要求会被拒绝。安装不强制试派任务，没额度或跳过验证不撤掉端点。

### 跟随原生，或使用专用 JSON

安装直接使用 setup 返回的 ZCode 原生候选；已完成安装后单独查看原始候选，可用 `paidan models --endpoint zcode --native`（绕过 paidan 专用文件读取原始 provider rules）。按实际 provider 名称、标识和接入类型展示模型及 `effort_options`。这只读取本地个人规则与所选安装的内置模板，不启动 ZCode、不调用模型。仅列已配置且已启用的 API provider，不替用户启用禁用项。运行时缓存和账号权限可能与文件候选不同；未知信息应在原生界面核对。

- **跟随原生**：不设置 `endpoints.overrides.zcode.provider_config`，也不写 `defaults.models.zcode` / `defaults.efforts.zcode`。已有 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 会继续生效；原生选择不等于 OAuth，也不保证是文件第一项。
- **专用配置**：用户选 provider → 模型 → 强度。在安装确认中说明目标路径、选定组合，以及文件包含所选 API 连接的副本，可能包括 API Key。用户同意后，由 setup 在 ZCode 原生目录（例如 `~/.zcode/paidan/`）创建 JSON。原 `v2/provider_config.json`、`cli/config.json` 和桌面默认值保持不变。

专用 JSON 由上面的 setup 流程创建。选择文件中填写所选 ZCode 的 bin、provider、model、effort；预览会列出原生目录内的目标路径和凭据副本说明。用户确认后程序只提取选中的启用 API provider，保留它的两类模型规则并设置默认组合。无需 agent 研究 schema 或复制整份原生文件。

setup 不覆盖原始 v2/provider_config.json；专用文件和备份留在原生目录，paidan 配置只保存路径。已有不同专用文件会在摘要中显示备份更新；先核对用户是否同意该目标的重建。原生 Key 更换后需要用户授权重新同步该专用文件。运行时仍只传路径，不复制或更新凭据。

### 实际调用报告与失败处理

`paidan get` 的 `result.evidence.selection` 报告 `expected`、`actual`（provider 标识/名称、模型、强度）、`source`、`matches_expected`。它按本次 sessionId + traceId + turnId 查询原生请求账本；标识、账本缺失或格式不兼容时标为未知，不拿旧会话或配置默认值冒充实际调用。名称只是配置标签，不证明账号或最终账单。

专用 JSON 指定的是原生默认选择，不是绝对锁定。ZCode 自己可能另选模型；`matches_expected: false` 时明确告知用户，不能把任务完成说成固定组合验证成功。实际证据缺失时也不能声称已固定成功。

文件失效、认证/额度或任务失败时，**不自动切回原生，不自动重派**。报告原因、已有产物及可能执行过的操作，询问用户是否改用原生；同意后可为一次调用加 `paidan run --endpoint zcode --native ...`。这只绕过本次专用路径和模型/强度默认，不修改已保存配置。续接可能恢复旧会话选择，是否续接或新建取决于任务状态，并核对本轮实际记录。长期改回跟随时提交该端点 native:true，由 setup 移除对应覆盖；已有环境覆盖仍需明确处理。

### 旧版本迁移

0.1.8 的 app-server 适配已移除。旧 `defaults.models.zcode` / `defaults.efforts.zcode` 需经用户确认转成专用 JSON，再移除这些已不支持的 paidan 覆盖；不静默删掉后改用另一连接。旧 `zapi_` 会话不能直接交给 print 续接，保留旧结果并新建 print 会话。

当前版本直接读取 `v2/provider_config.json`，不需要复制到 cli，更不能拿它覆盖 `cli/config.json`。旧注册表不在当前程序写入支持范围，使用原生设置或兼容版本处理，不让 agent 搬运旧配置；历史合并办法不是通用 OAuth 修复方案。

## 仅在需要时展开

### 固定模型、强度或处理连接变化

安装及持久调整使用 setup；已配置端点发生额度、认证、模型/强度错误时，可单独查询：

```sh
paidan models --endpoint <name>
```

每次重新读取当前来源，`--refresh` 仅为兼容保留。读取 `source`、`notes`，说明原生配置、静态别名和实时目录的区别；旧版返回的 `from_cache` / `stale` 属于历史。名单不证明账号权限或额度，查询失败不能用旧名单声称当前可用。

Codex 使用所选 CLI 的 `debug models` 可见目录，强度按该模型的 `effort_options` 展示，包括原生声明的 max/ultra，不向每个模型套用同一份通用列表。原生查询可能使用自己的缓存或内置目录，不证明认证或额度；旧 CLI 不支持查询时仅保留明确标注的配置候选。第三方连接只有已配置模型、且强度未知时，向用户说明需核对该服务的原生配置/文档，不猜测。OpenCode 的 `effort_accepts_custom` 允许模型声明的自定义 variant。DSH 和 ZCode 不支持 paidan 模型/强度参数覆盖；ZCode 的专用选择保存在原生 JSON，paidan 只保存其路径。

Codex 持久固定选择由 setup 同时保存模型、强度与当前配置摘要；agent 不手动补摘要。这个不含凭据的摘要用于检查原生路由配置、配置目录、入口、认证方式标记及相关环境变化；不是对账号权限或实际计费的证明。原生配置有变化，或旧固定配置还没有摘要时，派发返回 `SELECTION_RECONFIRM_REQUIRED`，不会把旧模型交给新 provider；提交后、启动前再检查一次。不得为了消除错误自行更新摘要。

用户选择本次跟随后，各端点均可用 `run --native` 同时绕过已保存的模型和强度；ZCode 还绕过专用 provider JSON。该参数不改变权限，也不改已保存配置。用户选择本次固定 Codex 时，可以同时传 `--model <模型> --effort <强度> --selection-context <本次查询值>`；仅覆盖模型仍会继承旧强度，所以应核对完整组合。长期改回跟随使用 setup 的 native:true，程序只移除用户选中的覆盖及其摘要，保留其他配置。

固定值放在 `defaults.models.<endpoint>`、`defaults.efforts.<endpoint>`，不使用全局 model/effort。所有端点失败时先读具体错误、拒绝证据、终态和已有产物；普通任务、路径、网络、权限错误不直接归因为模型问题。`get` 的 `recovery` 提供提交时的原生配置快照和固定值用于对比；它不是自动诊断结论。证据指向额度、认证、模型/强度或用户切换配置时，只重查相关端点的当前通路，列清端点、连接、模型、强度、来源和未验证项，让用户选择跟随、另选组合、修复原生设置、换已启用端点或暂停。已固定配置不自动删除，不自行更新确认摘要、换计费路径、升权或重派。用户选择后核对旧任务已结束及部分改动，再按本次覆盖或持久更新执行；不默认跨连接续接旧会话。

### 暂缓、跳过验证与禁用是不同选择

- 本次没选的端点不处理；已有配置不动。
- **跳过验证**：保留已保存的路径、启用状态和默认值，只说明尚未实际调用。
- **暂时未登录或没额度**：保留配置，列为待处理；可以改天直接使用。
- **用户明确不要/禁用该端点**：通过 setup 的 enabled:false 处理；如果它是默认端点，再选 default_endpoint 替代值或 null。
- 所有端点都尚未配置时，enabled 可为空、省略 defaults.endpoint，如实说明 paidan 已安装但尚未接入端点。

### 用户明确需要时才试跑

真实调用验证不是默认收尾问题。用户明确要求确认能否调用时，说明会使用其账号/额度，再发最小任务；只需要验证回复时不要求写文件。认证或回复成功不等于文件写入等全部能力已验证。

保存 run_id，检查终态与实际结果。等待超时不能直接重派；先继续等待，或按用户授权取消。失败或跳过测试不自动禁用端点。重试前核对原 run 已结束及其已产生的改动。

## 更新与卸载

这三个流程仍由能执行本机操作的 agent 完成，不重新运行 init，不自动更新其他软件。维护前先确认当前 paidan 入口、包版本、`config_path`、实际数据目录和已安装 skill 的位置；不能只按默认目录猜。检查所有非终态任务（pending/running/attention）：有任务时先等待完成，或按用户明确的取消选择处理并确认相关进程已退出，再更新/卸载。不要只看默认返回的前 50 条记录；维护调查直接读取已确认数据目录下的 run 状态，避免 `list` 的 TTL 清理副作用。

### 程序维护安装记录

setup 与 init 共用写入器，在 config_path 同目录自动合并 install-receipt.json。记录实际成功写入的文件、所属端点/宿主、校验值、版本与备份；配置项附带选中入口的来源和 CLI 版本。局部维护保留其他记录，部分失败只记录已完成项目。记录损坏时保留并报告，不重建空记录；agent 不手写或补写记录。

记录不含凭据或原生配置全文，也不是删除授权。旧安装没有记录时仍可通过包内容比较归属；归属不明或后来被用户修改的文件先保留。程序按文件备份与写入，不承诺跨文件事务；若进程被强制终止，按实际文件及备份重新检查，不能凭缺失回执推断没有写入。

### 1. 更新 paidan

1. 核对当前安装来源与用户要更新的那一份程序。保存现有配置和旧版本信息；备份成功后才处理必要的配置迁移。配置没有迁移需求时不重写。
2. npm 全局安装使用 `npm install -g paidan@latest`（PowerShell 可用 `npm.cmd`），更新后核对实际入口与版本。源码安装按该 checkout 更新并构建，保留未提交改动；不能用 npm 更新冒充源码已经更新。
3. 使用新包内的 skill，只同步此前由用户选择安装过的宿主，不因为新发现目录而扩散安装。目标不存在时先说明；用 setup choices 的 endpoints:{} 与所选 hosts 预览更新，由程序比较、备份和写入。已有差异时先核对记录/旧版包及非敏感差异；用户确认替换后用 replace:true，不手工覆盖。不得用 init 的覆盖行为绕过比较。
4. 现有端点、路径、连接、模型、强度、`defaults.modes`、dataDir 和 ttlDays 均保留。新版的权限默认若与旧版不同，要说明影响并保留原选择，不能借升级静默放宽权限。只做必要的字段迁移，备份失败或期间文件被其他进程改动则停止该项写入，重新读取比较。
5. 程序自动更新成功项的安装记录；失败项保留旧记录。对已启用端点集中做基础检查，默认不派真实任务。需要回退时先核对旧版本是否支持当前配置，不能不加判断地安装旧包或恢复整份旧配置。

### 2. 上游 CLI 更新后适配

1. 只检查用户指出已更新的端点，使用其原生安装/更新方式；确认新的入口、版本和所用原生配置。固定路径不等于锁定版本：原路径被替换就会运行新版，版本目录变更或旧版残留则需要重新定位。
2. 同一入口仍有效且接口兼容时继续使用。需要更换入口时展示候选，按已有明确选择或用户选择，把该端点 bin 交给 setup 保存，保留其他端点和默认值；不自动选择另一条账号/计费连接。
3. 核对该版本的无头参数、审批方式、模型元数据与输出协议。doctor 的 drift 是提醒，版本号相同也不保证桌面捆绑资源未变；ZCode 还需检查配套资源及 provider 布局。项目/组织 deny 规则不能为兼容而偷偷删除。
4. 若新 CLI 与适配器不兼容，说明具体差异；用户可更新 paidan 到兼容版本、用原生方式回退 CLI，或暂缓该端点。不能修改上游安装文件或靠试遍权限档位来绕过问题。基本检查不要求调用模型；真实验证仅按用户明确需求进行。

### 3. 卸载 paidan

1. 先核对正在运行的任务及实际安装清单，再处理宿主 skill，最后移除程序，避免先丢失诊断入口。卸载本身不等于取消任务。
2. 只移除确认属于 paidan、且用户要求移除的 skill 文件。hash 与记录/对应包一致时按卸载范围处理；文件有用户改动或归属未知时先保留并让用户选择。保留同目录其他文件和备份；只有确认是普通空目录时才移除其空目录，不递归删除宿主 skills 目录，不跟随 symlink/junction 删除目标。
3. npm 全局安装使用 `npm uninstall -g paidan`（PowerShell 可用 `npm.cmd`），只针对确认的安装。源码 checkout 或用户工作目录默认保留，不当作 npm 包目录清掉。
4. **默认保留 paidan 配置、安装记录、备份和运行历史。** 用户另行要求彻底清理时，先列出实际文件范围再按授权删除。自定义 dataDir/PAIDAN_HOME 可能与其他文件共享目录，不能整目录递归删除；只处理确认属于 paidan 的文件/记录，保留用户任务交付物。
5. **默认保留各 agent 本体、登录、原生会话和原生配置。** 卸载不自动撤销 ZCode provider 合并或 AGY allow 规则。用户要求撤销时，根据本机记录和原生备份逐项核对，仅撤回仍能确认归属的改动；若当前文件 hash 已变化且无法确认哪些字段后来被修改，保留并解释，不能整份覆盖成旧备份。Node.js、npm 和其他 agent 也不随 paidan 卸载。

维护过程保留部分成功结果，收尾由 agent 按实际情况组织，不要求固定话术。

## agent 查找与诊断参考

### Windows 常见入口

| 端点 / 命令 | Windows 候选入口与限制 |
|---|---|
| kimi-code / `kimi` | `%USERPROFILE%/.kimi-code/bin/kimi.exe`；自定义安装还需检查 `%KIMI_INSTALL_DIR%/bin/kimi.exe`。区分当前 CLI 与旧 Python 版 `kimi`，同名不代表协议兼容。 |
| codex / `codex` | 所有已发现的 `codex.exe`；npm 的 `<npm-root>/@openai/codex/bin/codex.js` 或其包内原生程序。保留完整安装，不把 exe 单独复制到别处。桌面内置版与 npm 版可能不同；装了桌面应用不等于已经有可用 CLI 入口。 |
| claude-code / `claude` | 原生安装检查 `%USERPROFILE%/.local/bin/claude.exe`；已记录的 npm 布局是 `<npm-root>/@anthropic-ai/claude-code/bin/claude.exe`。布局不同时查看已安装包的 bin 入口。 |
| zcode / `zcode` | `<ZCode安装目录>/resources/glm/zcode.cjs`。检查 Program Files、`%LOCALAPPDATA%/Programs/ZCode` 和用户自定义位置。服务端安装可能使用 `%USERPROFILE%/.zcode/server/agents/glm/zcode.cjs`。选择 CLI 脚本，不选桌面 exe。 |
| opencode / `opencode` | 已发现的原生 `opencode.exe`；已记录的 npm 布局是 `<npm-root>/opencode-ai/bin/opencode.exe`。其他包管理器或布局需确认实际入口。 |
| omp / `omp` | `%LOCALAPPDATA%/omp/omp.exe` 或 `%PI_INSTALL_DIR%/omp.exe`。Bun 包使用需要 Bun 的 TypeScript 入口，当前 paidan 的 bin 覆盖不支持这种启动方式。可选择原生二进制安装或跳过，不把 TS 文件或 bun.exe 填进 bin。 |
| dsh / `dsh` | 原生 DSH_HOME/profile 的对应包、npm 布局，以及实际 npm 缓存下 `_npx/<目录>/node_modules/@deepseek-ai/dsh/lib/bin.js`；程序核对包名和入口，保留完整目录。缓存可能被清理，不自动下载替代。 |
| agy / `agy` | 安装目录内真正的 CLI `agy.exe`。不假定存在通用默认目录，使用已发现的入口，或请用户提供位置。 |

以上是查找线索，不是完整清单。变量需展开，用户提供的位置优先按其选择核对；POSIX 使用 `type -a` 等命令及原生包管理器布局。CLI 脚本 `.js/.cjs/.mjs` 会由 paidan 自动通过 Node 启动。

### doctor 字段

`config_path` 是程序管理的配置文件位置，尊重 `PAIDAN_HOME`；不要求 agent 手工编辑。`endpoints` 是单个命中；`model_selectable`、`permission.presets` 是适配器支持范围。`effort_options_scope` 解释档位列表，`effort_accepts_custom` 标记是否允许原生自定义名称；两者都不能代替逐模型兼容性。`native_defaults` 是部分原生设置快照，`credential_ready: null` 表示认证未验证。`hosts[].source/target` 与 `package_root` 用于定位包内 skill 和安装目标。

`ok: true` 只表示 doctor 执行完成；`spawn_supported` 仅说明启动方式。还要读 `version_error`、`repair_hint`、`issues`。所选端点筛选不会隐藏全局配置诊断和宿主信息，但不执行未选端点的版本/原生状态探测。备份、文件比较和 JSON 检查由 agent 内部完成，无需让用户理解这些字段才能安装。

### 源码安装与可选 init

源码安装使用 `npm install`、`npm run build`，然后统一用 `node dist/cli.js` 替换本文所有 `paidan` 调用；`npm i -g .` 可选。Git 只在克隆源码时需要。整个过程使用同一份安装。

`paidan init` 是可选终端界面，与 setup 共用发现、配置规划和写入器，可能显示英文。多安装不能自动选择；`init --yes` 追加唯一可确定的端点，保留已有模型、强度、绑定和默认端点。单端点维护或补装 skill 直接使用 setup。

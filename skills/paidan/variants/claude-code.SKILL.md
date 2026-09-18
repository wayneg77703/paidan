---
name: paidan
description: 通过 paidan CLI 把任务委派给本机已安装的 AI CLI agent（kimi-code/codex/claude-code/zcode/opencode/omp/dsh/agy）。每个任务是一个持久 run：可等待、可取消、重启后可查证。
when_to_use: 需要把任务委派给本机 AI CLI agent、调第二意见、派对抗审查或并行子任务时使用本通道（run/get/cancel/list/models/doctor/probe），这是本机委派的唯一受管通道。
---

# 宿主 agent → paidan（派单）

paidan 是本机委派工具：把任务交给本机已安装的 AI CLI agent 执行。stdout 恒为单个 JSON 信封（`{ok:true,...}` 或 `{ok:false,error:{code,message}}`），人类文本只在 stderr。没有 daemon：每个 run 由 detached worker 监督，磁盘 run store 是唯一真相源。

中文用户的提问、选项、故障解释、确认和结果报告均用中文；用户明确要求其他语言时跟随其选择。英文工具报错先用中文说明原因和下一步，再按需附原文。命令、路径、模型标识、JSON 字段和错误码保持原样。

## 安装与接入

按包内 INSTALL.md，用 setup 承担机械工作。先确认接入哪些端点，再用 `paidan setup --endpoint <名称>`（可重复）检查完整入口候选与真实菜单；PATH 没命令不等于未安装。唯一有效入口展示后采用，多份安装让用户选，不按版本或 mtime 猜。指定入口可加 --bin；项目配置用 --cwd 指定实际目录。

接受自然语言和逐个选择。模型显示名称、精确 ID、该模型支持的强度一起展示，不塞预设组合、不默认都用 max、不近似匹配；用户已说清组合就直接记录，不再问“固定哪些”。已有配置复用，缺接入时才指导原生设置，未登录/无额度不撤掉端点。

保存 setup 返回的 choices 模板并填写用户选择，`setup --choices <文件>` 生成摘要；用户确认后由宿主带入 confirmation 调用 `--apply --expect <值>`。用户只看组合、默认端点、宿主 skill 和文件影响，不抄写哈希、不填写 JSON。ZCode 固定组合涉及原生目录内所选 API provider 的凭据副本，明确说明并纳入同次授权；程序构建专用 JSON，原始配置不动。不要翻源码猜 schema、临时写复制脚本或再跑 init。变更检测返回新摘要时核对实际变化，不盲目刷新重试。

入口未找到时，agent 可只读补查快捷方式或自定义目录，把目录/程序路径用 setup --endpoint <名称> --location <绝对路径> 交回程序核验。ZCode 不假定在 C 盘；DSH 区分原生 home/npm/npx 缓存，缓存失效不自动下载或换入口。新增端点仅提交该端点，保留其他配置及全局默认。

安装不默认调用模型或 probe，版本漂移仅提示；保存已有校验结果，必要时只定向 doctor。当前宿主 skill 纳入摘要，其他宿主按需。配置、原生专用文件、skill、备份和 install-receipt.json 均由程序写入，agent 不手工补字段或账本。当前宿主是发单方，与执行端点分别选择。未被 setup 支持的原生改动使用原生设置功能，不临时拼 JSON/YAML。

## 标准调用循环

1. 派发：任务正文写入 UTF-8 文件后运行 `paidan run --endpoint <name> --cwd <绝对路径> --task-file <任务文件>`；短任务可用 `--task <文本>`。返回即完成派发，**立即保存 `run_id`**。长正文一律用 `--task-file`（argv 投递有长度上限教训）。可选：`--mode <预设>`、`--model <别名>`、`--effort <档位>`（仅声明了 effort 块的端点：claude-code/omp/opencode/codex/kimi-code，档位表见各端点 manifest 或 `paidan doctor`）、`--add-dir <路径>`（可多次）、`--deliverable <相对路径>`（可多次，声明交付物供终态证据核对）。
2. 收取：`paidan get <run_id> --wait` 前台阻塞到终态；可加 `--timeout <秒>` 防宿主工具超时。底层 run 是持久的，宿主超时后重新 `get --wait` 即可继续收取，**不重派**。
3. 取消：仅用户明确要求停止时 `paidan cancel <run_id>`。
4. 查找历史：`paidan list [--state completed,failed] [--limit N]`。
5. 模型候选：`paidan models --endpoint <name>` 每次查询当前来源，`--refresh` 可省略。读 `source`、`notes`：原生配置、静态别名和实时目录均不等于账号有权调用；查询失败不借旧缓存冒充当前可用。旧版若返回 `from_cache`/`stale`，按历史信息处理。
6. 体检：`paidan doctor` 看端点探测/版本/权限图/`repair_hint`；端点行为存疑或 agent 升级后跑 `paidan probe --endpoint <name>`（P1 写入/P2 只读拒绝/P3 续接契约探针）。

## 模型和强度默认跟随原生配置

- 固定用户选中的 CLI 路径；模型和强度推荐跟随该 CLI 的当前原生配置。不要把安装时看到的值记成以后每次调用的 `--model` / `--effort`。用户明确要求本次覆盖或已选择固定默认时，按其选择执行。
- 跟随模式在 paidan 中表现为 `defaults.models.<端点>`、`defaults.efforts.<端点>` 均省略，调用时也不传对应参数。已有固定值不自动删除；用户选择切回跟随后，清除对应覆盖项，保留路径和其他设置。单纯省略命令参数不会绕过已保存的默认值。
- 用户通过 CC Switch 等工具切换的是原生连接/配置。新的委派沿用当前原生配置；不假定每次切换都同步改好了模型和强度，也不自动改换其他账号。正常成功时无需反复询问或扫描全部端点。

- 连接/provider 先于模型，模型先于强度。同一厂商的登录套餐、API 和网关可能是不同计费连接；多条候选由用户选择，不能根据别名前缀或 apiKey 存在猜账号。`models.connections` 是配置证据，模型 `source` 区分原生配置、桌面候选、目录和静态别名；均不证明额度。
- Kimi 使用真实 provider 映射与完整别名；ZCode 先核对配套资源和桌面/CLI/new provider rules 的差异；Codex 看当前 provider/profile；Claude 看环境覆盖与别名映射；OpenCode 看选中模型的 variants；OMP 看原生 profile、模型 selector 与 thinking，保留其他 modelRoles；DSH 由 headless profile/插件原生设置承载；AGY 不猜认证类型，独立 effort 尚未接入。
- 选强度先读该模型的 `effort_options`（缺失/null = 未知，空数组 = 无声明选项），再核对适配器支持。OpenCode 的 `effort_accepts_custom` 允许原生自定义 variant，通用 options 只是示例。其他端点未支持的覆盖保持原生，不伪造命令。正常派发只做所选端点必要的校验，不扫描无关端点；安装选择、用户调整或相关错误时再展开候选。

## 任务正文写法（先于派发）

- **分档**：简单任务（可逆、一句话说清）口头指令 + 一句"怎么算完"即可；中等任务（正式派单、可逆但有判断量）按下述三分结构写正文；复杂任务（不可逆 / 大爆炸半径 / 数小时 / 未知多）先写正式任务书（骨架见下）再派。详略按复杂度，**诚实不打折**。
- **三分结构**：正文分两段——「已知事实」（每条带定位：路径 / 版本 / 日期）与「判断与假设」（标为可反驳，不作采纳前提）。被调对象与验收标准放事实段；我方推理、偏好、背景综述放判断段——防止执行方把派单方判断当已核实事实。
- **摘要 ≠ 记录**：交付背景材料时标注"这是摘要"并附源定位；不要把改写后的综述冒充完整记录。
- **范围语义不矛盾**：给定的限制（只读 / 限目录 / 禁联网）必须与要求的产出兼容——限制读 Git 又要 Git 证据的任务在物理上做不出来。
- **验收可机械判定优先**：每个交付物至少一条确定性检查（命令 / 退出码 / 对账 / 存在性 / 字节比对），语义审查排在确定性门之后；写不出确定性检查 = 需求没说清，重写再派。

**任务书骨架（承重子集，复杂任务用）**：goal（objective + non_goals）· inputs（name + version_or_ref + source）· deliverables · acceptance（deterministic_checks 必填 + semantic_review）· scope（allowed + forbidden）· stop_conditions · recovery（rollback；有副作用任务加 idempotency_key）。

**对照两例（蒸馏）**：
- 坏："帮我把这些文章收一下做成报告。" → 好：「对象与验收标准：逐项核实 N 项，输出事实表（项目 | 实测证据 | 与所述差异），只统计事实不给建议；声明（供逐条核验，不作采纳前提）：以下描述可能已过时，用实测纠正——[清单]」
- 坏："把这个对话交给 X 继续。"（附自称"完整记录"的改写摘要） → 好：「背景（摘要，我方撰写，供参考不是记录）：[要点 + 源定位]；完整材料：见 <路径 / 会话 id>；我的判断（可反驳）：[列出]；任务：继续完成 X，验收 = [确定性检查]。」

## 权限预设与提交期拒绝

- “跟随原生”仅指连接、模型、强度，不包括交互审批。省略 `--mode` 时按 `defaults.modes.<端点>` → 端点默认选择；内置默认七个端点为 workspace-write，zcode 为 unattended。可用 `--mode` 作本次调整、`defaults.modes` 作持久调整，不自动升权。用户要求只读时显式传 read-only；端点不支持就报告，不回到较宽默认。
- 无头审批按各家适配：Codex 显式 approval_policy=never；Claude acceptEdits 加 permission-prompts=none（不撤销已有 allow，不提供强制只读）；Kimi print 为 auto；ZCode 仅 yolo；OpenCode build 保留原生规则；OMP write，需审批的执行操作拒绝；DSH 默认 native headless，可经 DSH_PERMISSION_MODE 请求只读但无 unattended；AGY accept-edits 依赖原生 allow 规则，缺规则时说明，由用户决定原生调整，通过受支持的程序/原生设置方式完成。无头权限错误先返回宿主处理，不把等待用户/SDK host 确认的交互方式当成可用配置。
- 三预设：`read-only` / `workspace-write` / `unattended`。各端点把预设映射到自己的原生权限模型。
- 端点无法强制所请预设时**提交期硬拒** `PERMISSION_UNSUPPORTED`（message 列出缺失能力），不会降级偷跑。此时不得改权限重试；报告限制，或换支持该预设的端点。
- `soft` 能力只记入返回的 `warnings` 字段，任务照跑；含义是端点声称支持但强制力存疑。
- 预设支持速查（以 `paidan doctor` 实况为准）：kimi-code、claude-code 无 `read-only`；zcode 仅 `unattended`；dsh 无 `unattended`；omp 的 `workspace-write` 不含 shell.exec（shell 需 `unattended`）；agy 的 shell.exec 为 `soft`。

## 终态判读纪律（证据优先）

- `exit 0` 不算成功。以 `get` 返回的 `run.state` + `result.evidence` 为准：`completed | failed | cancelled | unknown`，另有可能见到 `attention`。
- `unknown` 是合法终态 = 证据不足；读 `result.evidence`（`deliverables[].found`、`refusals`、`parser.degraded`、`notes`）与 `result.final_text` 自行判断，据实报告。
- `attention` = reconcile 发现 worker 已死但 run 非终态；不会自动重启，可 `cancel` 关闭后按用户授权决定是否重新委派。
- `evidence.refusals`（端点内band 拒绝信号）是证据，不是自动失败。
- `usage.source` 三态：`provider`（端点输出流自带）/ `endpoint-ledger`（原生账本观测，kimi）/ `unavailable`（诚实标记，不是错误，不得伪造 0）。

## run_id 与幂等纪律

- 已有尚未结束的 `run_id` 时只查询不重派；宿主等待超时、回执不明均不构成重派理由。已结束的失败任务按下方恢复流程处理。
- 幂等：相同 fingerprint（endpoint+cwd+任务正文+mode）在非终态 run 存在时复投返回原 run（`created:false` + note），不会产生重复执行。
- 取消已终态的 run 是无害 no-op（返回 `already terminal`）。

## 续接（resume）

- `paidan run --endpoint <name> --cwd <与首次相同> --resume <session_handle> --task-file <新任务>`；`session_handle` 取自上次 `get` 结果的 `result.session_handle`（或 `run.session.handle`）。
- resume 的权限档分两类端点：**恢复原档型**（codex `exec resume` 不收 `-s`/`--add-dir`，恢复会话原 sandbox，本次 `--mode` 只记在请求里不生效，提交回执会带警告）；**重定档型**（claude 等 flag 拼接路径会重传本次 mode；agy 本次调用可重新定档）。kimi/zcode 会话按 cwd 绑定，必须同 cwd。dsh 无 resume。

## 红线（不可越过）

- 永不把凭据搬进任务正文、命令参数或 paidan 配置；端点用各 agent 自己的原生配置与调用方 env 运行，paidan 不代理、不暂存凭据。
- paidan 引擎不自动修补 agent 的原生配置；缺设置时报告，由用户决定处理。安装 agent 将用户已明确选择的改动交给 setup 或原生设置功能；不手工拼配置文件、复制 provider 或补写安装记录。
- 模型/连接失败（配额、认证等）时**永不静默切换路径**：拒绝并报告，不自动换模型、换端点、换账期、升权。注意区分：失败时刻的自动 fallback 被禁止；用户**明确选择**换模型换档位（或本次任务已有该选择的授权）是正常操作，不属于此条。端点自身的 fallback 机制（如 claude 原生 `--fallback-model`、网关侧切换）归端点与用户配置管，paidan 不知情也不拦截。
- 不传 `--model` 时生效值为 `--model ?? config defaults.models.<端点> ?? 端点原生默认`（无全局回退键；不跨连接）；DSH 没有 headless 模型选择，配置模型会被 `MODEL_UNSUPPORTED` 拒绝。ZCode 只走 print：不传模型/强度覆盖；专用组合保存在用户批准的 ZCode 原生 JSON，paidan 只保存 endpoints.overrides.zcode.provider_config 路径。setup 确认缺少启用 API 接入时才指导用户配置；已有接入直接使用，桌面 OAuth 不保证 CLI 可用。每次报告 result.evidence.selection 的期望/实际组合；matches_expected=false 或未知不能声称固定成功。失败先解释已有操作并询问用户，不自动切换/重派；用户同意后才用 run --endpoint zcode --native 绕过本次专用配置。旧 zapi_ 会话不支持续接。需要核对时用 `paidan models --endpoint <name>` 查询；各端点原生 home 当前实际用什么模型/强度，`paidan doctor` 的 `native_defaults` 只读可见。

## 错误处理

先读 `error.code` + `error.message`，不只看进程退出码。常见码：`ENDPOINT_UNKNOWN` / `ENDPOINT_DISABLED`（未在 config 启用）/ `PERMISSION_UNSUPPORTED` / `MODE_INVALID` / `TASK_REQUIRED` / `TASK_TOO_LONG`（argv 投递端点的最终命令行超长——缩短正文或改用 stdin/file 投递的端点；`--task-file` 只改变 paidan 读正文的方式，**不解除** argv 端点的长度上限）/ `SPAWN_UNSUPPORTED`（端点只能经 cmd shim 解析且为 argv 投递，按 message 设 overrides.bin 或装原生 exe）/ `MODEL_UNSUPPORTED`（端点无 headless 模型选择却配了模型，按 message 从 config 删除对应键）/ `EFFORT_UNSUPPORTED`（端点无 effort 选择）/ `EFFORT_INVALID`（档位不在端点 options 内）/ `RUN_NOT_FOUND` / `CONFIG_INVALID` / `WORKER_SPAWN_FAILED`。端点相关问题先 `paidan doctor` 看探测状态、`drift` 与 `issues`，再决定报告或修复；`get --wait` 返回 `attention` 或 `needs_attention` 时立即向用户报告（worker 已失联，不会自愈）。


### 额度、登录或模型配置失败时

仅当错误证据指向额度、认证、模型或强度不兼容，或用户告知刚切换连接时，进入下面的恢复流程；普通任务错误不触发换路。

1. 先 `get` 原 run，查看错误、终态和已有交付物/改动。等待超时不算执行失败；未结束时继续收取，或按用户取消授权停止，不能直接重派。
2. 用 `get.recovery` 的 `native_at_submission` / `requested` 对照 `doctor --endpoint <原端点>` 与 `models --endpoint <原端点>` 的当前配置，区分用户换连接、认证过期、额度不足、模型不兼容和普通任务/权限/网络错误。快照是配置意图，不是实际调用证明。只展示非敏感的连接、模型和强度，不展示凭据；不扫描无关端点。
3. 向用户说明有证据的原因与候选：跟随当前原生配置、选择当前连接的其他模型/强度、处理原生登录、暂停；用户需要换端点时再查其他已启用端点。候选列清端点、连接来源、模型/强度和验证状态。原生目录可能来自原生缓存或内置数据，不保证认证/额度；第三方连接没有完整目录就明确范围，不借用官方名单。涉及怎么走的选择交给用户，已有明确授权不重复询问。
4. 用户选择后区分本次覆盖和更新默认。各端点均可 `run --native` 同时绕过本次 paidan 模型/强度默认；ZCode 还绕过专用 provider JSON，权限仍保持原设定。具体模型/强度可用参数覆盖；长期跟随才清除用户批准的对应默认。换模型时一并检查强度，不能把旧强度强加给新模型。不得自行登录、换计费连接、提高权限或轮流试一遍候选。
5. 原 run 已结束且已核对部分改动后，按用户选择重新派发，保存新的 run_id；不默认跨连接复用旧 resume 句柄。再次失败则报告新证据，等待用户选择，不进入自动重试/自动切换循环。

Codex 和 Claude Code 的持久固定选择交给 setup，由程序一起保存 model/effort 和本次原生配置摘要。`SELECTION_RECONFIRM_REQUIRED` 表示固定值尚未绑定当前配置或配置已变化；先展示新配置与候选，让用户选择跟随、新固定组合、其他已启用端点或暂停，不擅自刷新摘要。用户选定本次组合后可用 `--model ... --effort ... --selection-context ...`；本次跟随用 `--native`，只有用户要求更改持久默认时才写配置。检查不验证额度或完整项目/托管策略，也不代替实际调用证据。Claude 的 tier 别名会随映射变化，固定具体模型应选完整 ID；仅使用原生 --effort，不专门覆盖用户强制的环境设置。

Kimi Code 的固定模型使用当前模型列表中的完整别名，按真实 provider 映射区分 OAuth/API，不能按别名前缀猜。模型菜单以 overrides 后的 `effort_options` 为准；只有 `effort_selectable=true` 才提供 paidan 强度固定，其他协议跟随原生强度。`MODEL_UNAVAILABLE` / `EFFORT_UNSUPPORTED` / `EFFORT_INVALID` 时让用户重新选，不自行改原生 thinking。`KIMI_MODEL_NAME` 启用环境临时模型，`--native` 也会继承它；省略 paidan 覆盖不代表忽略原生环境变量。


OpenCode、OMP、AGY 的固定选择也保存同次 models 查询的 selection_context 到 defaults.selection_contexts.<端点>；持久配置的这个字段由 setup 自动保存，宿主不手写、不让用户抄写、不增加确认步骤。固定派发前按当前目录检查模型（OpenCode/OMP 同时检查该模型的强度），失效或配置变化时让用户重新选择。查询项目配置用 models --cwd <原任务目录>，不得用安装仓库的配置代替任务目录。AGY 带档位的模型 ID 不再叠加 --effort；DSH 只跟随原生；用户同意调整原生默认后，把 provider/model/effort 放入该端点的 native_settings，经 setup 预览和保存，并说明影响其他原生会话。复杂 YAML 会拒绝，不能自行正则改写。OMP 原生可能启用 fallback/角色切换，固定请求模型不代表固定了账号或禁止原生换路；报告检测到的限制，不能擅自关闭。

## 更新与卸载

用户要更新 paidan、适配已升级的端点或卸载时，读取当前安装包的 INSTALL.md 中“更新与卸载”（包位置见 doctor.package_root）。不要用 init 重建现有选择。先处理活动任务，再核对安装来源、实际路径和本机 install-receipt.json；记录只是定位线索，不是删除授权。只同步原先选中的宿主 skill，用户修改或归属未知的文件先保留并比较；默认保留配置、历史、原生登录和设置。原生回滚仅针对能确认归属且经授权的字段，不用整份旧备份覆盖后来的修改。三个流程均由 agent 根据实际情况交互执行，不默认调用模型试跑。

# Harness 接入更新施工与验收

本次目标：让现有本机委派接口使用已安装 harness 的可验证能力，补齐计量并减少管理开销。基线：a7bf57e01b5f27012ec9fcc7827475427637e1ee（0.1.11）；开工时仅 tmp/ 为既有未跟踪内容，保留不动。

## 边界

保留持久 run、无 daemon、Node 标准库、原生认证和证据优先终态。不能把主分支功能当成本机已有功能；根会话用量不能冒充包含子代理和所有后台请求。未知不补零。运行时不改原生配置、不切换计费连接。配置修复通过既有 setup 预览/应用机制完成，不自动迁移用户配置。

## 施工顺序与验收

1. **DSH 配置与执行接入**：定位当前 headless profile 的 cordis 配置和覆盖关系；仅报告可证明的默认值。修复 setup 的目标路径与有限安全修改，无法理解的组合明确拒绝。stdin 投递、JSON 事件解析、会话句柄和显式续接、每步 provider usage。验收覆盖多步/重试缺数/错误终态/重复事件/流截断/同 cwd 续接；保留本机版本根 agent 等待的限制。不得导入旧 foreground 补丁。
2. **OMP/OpenCode 多轮计量**：依据对应发布版本的事件产生代码，聚合本次运行独立回合/步骤；重复事件不重复入账，缺失/冲突/溢出不报告精确总数。说明缓存口径和根会话覆盖范围。验证多工具步骤、重复事件、缺用量、异常流与汇总事件共存。保留现有模型/权限选择。
3. **Windows 进程查询优化**：一次 reconcile 批量查询相关存活 PID，减少每 PID 启动 PowerShell 的开销；保留 PID 重用核验与单 PID 取消接口。验证缺项、查询失败、格式兼容、无活动任务、Linux/macOS 既有行为。对照测量，不更换 run-store，不为 165 条约 25ms 的历史扫描增加数据库索引。
4. **AGY/ZCode 旧限制复核**：AGY 接收新结构化错误；验证写入、只读拒绝、续接与工作目录，不因发布说明自动放宽沙箱。ZCode 修正过时的审批说明，区分工作流专用收尾和普通后台子代理；只有实测证明的新路径才开放。原生权限、工具禁用和凭据默认保持原选择。需要额外矩阵时用隔离 scratch 和 paidan 受管调用。
5. **集成、审查与真实验收**：先 build 和定向测试，再 npm test 全量；对已变更端点运行项目要求的 probe（允许计费），记录 run ID、终态、用量与 verified_at_refresh。认证/额度失败不换路盲试；只陈述该验证的缺口。用独立上下文审查改动及契约，处理有证据的问题后回归受影响项。最后真实委派检查部署版本。
6. **本机部署与回读**：更新 README/英文入口、安装说明和技能源中的旧结论；发布本机安装包（不发布远端），沿现有安装/技能分发机制部署。核对已安装版本、来源与 manifest，配置和凭据保持原样。保留可回装的旧包；既有运行不中断。用户未要求的 Git 提交/推送不自动执行。

1、2、3 可按文件所有权并行；4 由主控推进；5 依赖实现汇合；6 依赖测试和审查完成。失败仅阻塞相关路径，不把未验证能力标记为支持。

## 本轮不默认开启

OpenCode --attach、Codex App Server、Claude --bare、任务特定 MCP 配置属于可选执行方式，需实际需求和收益支撑。本轮不增加常驻服务、不关闭用户的规则/技能/MCP、不升级 harness。OMP 已有的 MCP 就绪控制写入使用说明，不强制所有任务等待或失败。

## 回退

代码回退只针对本次改动；本机包使用部署前保留的旧版本回装。不回退原生会话、用户凭据或其他人的文件。若配置改动确有必要，由 setup 生成的备份与回读负责恢复。

## 进展与证据（2026-10-12）

- DSH：stdin/JSON、原生配置发现、安全 setup、显式 resume 已实现。0.2.0rc2 真实 P1/P2/P3 全通过，manifest 刷新成功。P1 `run_20261012_147803c0`；P2 `run_20261012_80244b8a`；P3 `run_20261012_5b4547ed` → `run_20261012_d38dd86a`，同 session 续接并回忆成功。四次均取得 provider usage；例如 P1 新输入 11,168、输出 278、缓存读 26,496。
- OMP/OpenCode：按独立回合/步骤去重累计，保留各端点缓存与推理口径。审查发现未闭合开始事件可能遗漏尾轮，已加配对及空尾 EOF 回归。离线回归通过，最终全量包含无稳定身份的跨轮重播反例；真实 probe 被既有固定选择与当前原生配置不一致拦截，未发模型请求，等待用户决定是否重新绑定原组合。
- Windows：相关活跃 PID 一次批量 CIM 查询，取消仍现查身份。三活跃进程的查询段对照 1578→589ms、1568→543ms、1476→523ms（约 63–65% 降低）；不代表端到端或模型生成速度。全量测试发现批查询期间完成的 worker 可能被旧状态覆盖，现已通过写前回读、终态保护和身份再核对修复；确定性回归与独立复审通过。
- AGY：结构化错误解析和脱敏诊断已接入。1.3.3 真实调用被账号资格校验拒绝，未更改账号或重试绕过。旧探针曾将普通 ERROR 误作 P2 通过，已修成必须有明确权限拒绝证据；本轮 AGY 权限/续接结论为未验证，不刷新已验版本。明确认证、额度或配置阻断后跳过后续真实探针。用户随后明确近期不用 AGY，本轮只要求配置正确；已通过只读 doctor 核对入口可启动、native_preflight=ok、固定模型 gemini-3.8-flash-high 与当前原生配置摘要一致。真实权限/续接及账号资格验证按用户要求暂缓，不作为本轮阻塞项；1.3.3 的版本兼容提醒保留。
- ZCode：0.16.9 P1 与 P3 完成，P2 验证提交期不支持只读；manifest 刷新成功。P1 `run_20261012_4b8b1095`，P3 `run_20261012_d63cba85` → `run_20261012_df24dee7`。保持仅 unattended，不把工作流收尾当所有子代理收尾保证。
- 集成：README、安装说明、计量契约及九份技能源已同步；八个已安装宿主技能均与安装记录校验值一致，可按管理机制备份更新。0.1.11 已打包留作本机回装；0.1.12 构建及全量测试通过（319 项：318 通过、1 跳过、0 失败）；独立审查发现的两类计量遗漏/重播与状态竞态已修复，定向复审 PASS。已通过 npm 本机安装 0.1.12，八个原有宿主 skill 通过 setup 备份更新并校验；配置字节未变、原生账号与权限未改。OMP/OpenCode 配置阻断已验证只检查一次、后续探针跳过且不产生 run。

## 实现所依据的上游接口

- OMP 18.9.1：[usage 字段](https://github.com/can1357/oh-my-pi/blob/v18.9.1/packages/catalog/src/types.ts#L197)、[turn_end 产生位置](https://github.com/can1357/oh-my-pi/blob/v18.9.1/packages/agent/src/agent-loop.ts#L753)。输入不含缓存，输出已含 thinking；不用 agent_end 摘要再次计量。
- OpenCode 1.19.0：[token 归一化](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/session/session.ts#L338)、[run 事件输出](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/cli/cmd/run.ts#L718)。缓存与 reasoning 分列，公共输出累计包含已提供的 reasoning；旧日志没该字段则注明限制。
- DSH 接口以本机 0.2.0rc2 headless 代码与上述真实探针为准；未将上游后续的等待所有后代功能记成本机支持。

- 部署后真实验收：`run_20261012_581a2d37` 使用已安装入口和 DSH read-only，在隔离目录读入验收文件，返回精确预期内容；state=completed、parser.degraded=false、session.resumable=true。provider usage：新输入 10,742，输出 158，缓存读 14,208。
- 本轮可完成施工与本机部署已结束。待用户决定的是 OMP/OpenCode 固定选择重新绑定；AGY 已按用户要求完成配置检查，真实账号与能力验收暂缓，不阻塞本轮。不得据离线测试替代账号可用性结论。未提交或推送 Git。

## 0.1.13 权限适配与部署（2026-10-15）

- DSH 三档权限显式映射到 DSH_PERMISSION_MODE，unattended 使用 danger-full-access；AGY unattended 增加 1.3.5 的 --dangerously-skip-permissions。Kimi 2.2.0 print 原生强制 auto，不添加与 print 冲突的 --auto。仅改 mode 的 setup 保留原有入口和固定选择，不将稳定入口重写为缓存解析路径。
- 全量 321 项测试：320 通过、1 跳过、0 失败。DSH 0.2.0rc2 P1/P2/P3 通过；最高权限真实 shell 写入通过。部署后不传 --mode 的新任务实际采用配置指定的 unattended，shell 写入、文件精确内容和 completed 终态均通过。AGY 因账号资格失败，未将参数核验冒充真实权限验证。
- 本机按用户选择配置七个端点的最高权限默认，Claude Code 保持原样；此为本机选择，公共包仍保留原有端点默认，不随源码发布用户配置。原有模型、强度、连接、路径保留，技能沿 setup 自动备份及回执机制更新。用户于本次部署后要求同步 GitHub，源码版本为 0.1.13；临时配置、凭据、任务日志和安装包不进入 Git。

## 当前版本适配与真实验收（2026-10-27）

基线为 `c530b995255f65fb5b7fd0da3f5ca95af81ba50b`（0.1.13）。保留持久 run、零运行时依赖、原生认证、无跨连接 fallback 和证据优先终态；不引入 OpenCode 2、常驻服务或新的 SDK/ACP 通道。包版本保持 0.1.13，只做本机安装，未发布 npm。

### 本轮修复

- OpenCode 接受下划线 provider；Codex/Kimi/OpenCode 的全零及混合用量不再伪造精确零或部分合计。DSH 保留 terminal error；Kimi 保留结构化 error；ZCode 可选观测字段不再使整包 degraded，移除过时的 12 回合上限；OMP 原生 fallback 事件成为有界 warning。
- DSH setup 可经 `native_settings.source_profile=web|acp` 同步所选 provider 对应的 `llm-pi-ai` 段。只在该段内检查所选 provider/model、动态语法和直接凭据；不复制 secret，也不因无关旧插件段拒绝。模型默认仍由原生 headless profile 承载，setup 不替换稳定入口。多端点调查改为串行，避免原生 CLI 竞争。
- 配置投影跳过 `llm-pi-ai` 内的模型列表，不再把嵌套模型 ID 误认成顶层插件。probe 识别 `MISSING_CREDENTIAL` 后停止后续付费尝试。Codex 启动配置提示与实验特性提示保留 warning，不再误作 refusal 使成功续接变成 unknown。HTTP Cookie/Set-Cookie 进入日志前脱敏；旧 run 不改写。

### 实际结果

下表模型为 paidan 提交组合，DSH/ZCode 为原生专用选择；配置快照本身不等于实际路由证明。

| 端点（实测版本） | 模型 / 强度 | P1-write | P2-readonly-refusal | P3-resume | verified_at_refresh |
|---|---|---|---|---|---|
| Codex 0.164.0 | `gpt-6-astra + xhigh` | pass `run_20261027_36c81d76` | indeterminate `run_20261027_eb622e2d` | pass `run_20261027_ea87f2fa` → `run_20261027_76708c0c` | ok |
| Kimi Code 2.3.3 | `kimi-code/k3.1-pro + max` | pass `run_20261027_8157caf2` | pass：提交期拒绝 read-only | pass `run_20261027_57549b43` → `run_20261027_ca8dab61` | ok |
| OpenCode 1.19.4 | `opencode-go/deepseek-v4.1-flash + max` | pass `run_20261027_bb154f00` | indeterminate `run_20261027_ff843269` | pass `run_20261027_07d33a69` → `run_20261027_7fe4420a` | ok |
| OMP 18.13.1 | `deepseek/deepseek-flash + max` | pass `run_20261027_436c62a8` | pass `run_20261027_58c39870` | pass `run_20261027_16249a7e` → `run_20261027_b396ca4c` | ok |
| DSH 0.2.1-rc.4 | `wb_lan/cn:deepseek-v4.1-flash + max` | fail `run_20261027_3bb6a20d` | indeterminate `run_20261027_c908ebe4` | fail `run_20261027_ebafbc99` → `run_20261027_76f5f468` | 未尝试 |
| ZCode 0.17.0 | `bigmodel-api-3/GLM-5.3 + max` | fail `run_20261027_a24720b1` | pass：提交期拒绝 read-only | skip：额度阻断后未提交 | 未尝试 |

- 上表 Codex/Kimi/OpenCode/OMP 的 P1/P3 均为 `state=completed`、`parser.degraded=false`，同 session 回忆成功。OMP P2 的 run 为 `unknown`，因有可归因的工具拒绝而 verdict=pass。Codex/OpenCode 本次 P2 只有模型文本，缺少可归因的工具拒绝事件，不据此宣称强制只读已验证。Kimi/ZCode 的 P2 只证明提交期能力边界。
- 完成调用的 Codex/OpenCode/OMP usage 来源为 provider，Kimi 为 endpoint-ledger，非空用量与 session_handle 均已回读。P1 的 input/output/cached 分别为：Codex 37,864/147/25,984；Kimi 5,880/158/103,168；OpenCode 12,122/92/15,488；OMP 10,876/157/21,120。不同端点口径不能直接相加。
- DSH 四次均为 `MISSING_CREDENTIAL`：headless 无法解析 `WB_LAN_API_KEY`，未进入模型调用，usage unavailable。没有复制凭据、移除 `apiKeyEnv` 或改走其他连接。最终 setup 应用 `applied=true`，headless 配置与 paidan 配置均 `unchanged`；doctor 仍读回目标 provider/model/effort。web/acp 默认及宿主 skill 未改。
- ZCode P1 为 provider 429：5 小时使用上限，原生给出的重置时点为 2026-10-27 16:56:55。P3 未继续提交，usage unavailable；没有本轮 session/trace/turn 可供账本核对，故 `matches_expected=null`，不能声称实际组合已验证。未自动重试或切换 provider。
- Claude Code 未配置可用模型、AGY 未配置登录态，按用户要求不做真实调用，也不刷新 verified_at。OMP 原生 fallback/角色切换保持开启，本轮未观察到 fallback warning，不代表以后不会发生。Kimi 原生 highspeed 默认未被 paidan 固定值覆盖。

### 回归与剩余阻断

`npm run build` 通过；`npm test` 共 335 项：334 通过、1 跳过、0 失败。已从当前源码打包并本机全局安装，`paidan --version`=0.1.13。DSH 最终 setup 预览/应用、doctor 与六端点 run store 已回读；没有遗留 pending/running/attention。

本轮不是六端点全部验收成功：Codex/Kimi/OpenCode/OMP 的真实调用路径通过，DSH 缺原生 headless 凭据、ZCode 受 5 小时额度阻断。两者需相应外部条件恢复后另行补验；不把离线测试、配置读取或历史成功记录冒充本轮模型调用成功。

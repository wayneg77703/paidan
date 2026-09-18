# paidan（派单）

简体中文 · [English](README.en.md)

把任务委派给你机器上已安装的 AI CLI agent。每个任务都是一个**持久 run**：可以等待、可以取消、重启之后仍可查证结果。

**推荐安装方式：把本仓库链接交给能执行本机命令的 AI agent，让它按 [INSTALL.md](INSTALL.md) 配置。** 它会一次询问要接入哪些端点，只检查所选项；唯一有效入口展示后采用，多版本由你选择。默认跟随原生模型/强度，把当前宿主 skill 安装纳入一次配置确认，完成基础检查即可使用。默认不调用模型试跑；暂时未登录、没额度或跳过验证，都可以保留配置稍后使用。中文用户的提问、选项、故障解释和安装结果均由 agent 用中文说明。

配置完成后使用核心命令：

```
paidan doctor                                 # 哪些 agent 已安装且可用？
paidan run --cwd . --task "总结这个仓"
paidan list
paidan get <run_id> --wait
paidan cancel <run_id>
paidan models --endpoint kimi-code            # 当前候选，不代表已验证有权调用
```

手工快捷方式：`npm i -g paidan`（需要 Node >= 24），再按需运行 `paidan init`。向导按首个匹配项探测，不负责在多个已安装版本间替你选择；agent 引导配置不需要运行 init。可选向导和原生工具仍可能显示英文，agent 会用中文解释关键提示。

CLI 的 stdout 恒为 JSON。没有 daemon：每个 run 由一个 detached worker 进程监督，磁盘上的 run store 是唯一事实源。

新读者一句话：**宿主**是发单方（你，或你请的 AI agent）；**端点**是执行方；**run** 是一次任务的持久记录——请保存 `run_id`。`effort` 是端点支持的推理强度选项（若有）；权限**预设**（`read-only` / `workspace-write`/ `unattended`）是映射到各 agent 原生权限模型的便捷层。终态判定是证据优先的：`completed` 是证据成立，不只是 `exit 0`。

更新程序、适配已更新的 agent，以及卸载，请让安装 agent 按 [更新与卸载](INSTALL.md#更新与卸载) 处理。默认保留配置、历史和各 agent 的原生设置；宿主 skill 单独核对后同步或移除。

## 宿主接入

宿主 AI agent 通过 CLI 驱动 paidan。[agent 引导安装](INSTALL.md)时，由用户选择哪些宿主接收 paidan skill。八个受支持的 agent 都有自己的原生变体，登记在 [skills/hosts.json](skills/hosts.json)。安装 agent 按 `paidan doctor` 给出的 source/target 只复制所选变体，无需重新运行 init，也不改变端点默认值。

skill 会教宿主派发、等待、取消、查询模型，以及按证据判断任务结果。也可以手工复制对应的包内变体。可选的 `paidan init` 向导仍可在选择端点和默认值时安装 skill。

连接、模型和强度推荐**跟随所选 CLI 当前的原生配置**：固定程序路径，省略模型/强度覆盖；也可明确选择固定默认值。切换连接后遇到额度、登录或模型错误时，宿主核对当前配置并让你选择下一步，不静默换计费连接或重派任务。

无头权限与“跟随原生模型”分开：默认采用现有端点映射（七个端点 workspace-write，ZCode unattended）。Codex 固定 never 审批，Claude 禁止交互权限询问；其他端点按各自 headless 机制处理。用户可用 `--mode` 或 `defaults.modes.<端点>` 调整，详见 [无头权限默认](INSTALL.md#无头权限默认与模型默认分开)。

配置顺序是**所选 CLI → 连接/账号 → 模型 → 该模型的强度**，各端点使用自己的原生机制。登录、API、网关可能属于不同计费路径；目录不保证额度。具体步骤见 [各端点的配置方式](INSTALL.md#各端点的配置方式)。


## 它是什么 / 不是什么

paidan 是本机派单台（"派单" = dispatching an order）。它做三件事，仅此而已：

1. 一个**本机工具**，把任务交给这台电脑上的 AI CLI agent。
2. 每个任务都是**持久 run**——可等待、可取消、重启后可验证。
3. 配置与发现（`init` 向导、`doctor`、`models`）。

它刻意**不做**：编排 / 多 agent 流水线、daemon、多租户、多机调度、聊天 UI、插件体系（v1）、凭据托管（永不代理或复制你的凭据）、遥测（永远没有）。

## 数据分区

| 区 | 位置 | 内容 |
|---|---|---|
| 代码仓 | 本仓 | 零机器路径、零凭据 |
| 机器配置 | `%APPDATA%\paidan\config.json` | 端点启用、默认值（端点 + 按端点的默认模型与 effort、run 超时）、数据目录覆盖、按端点的 bin 覆盖 |
| 数据面 | `%APPDATA%\paidan\runs\` + `usage.db` + `models-cache/` | 每个 run 一个目录（request/state/events.jsonl/result）、usage 记账（provider / endpoint-ledger / unavailable，永不伪造）、模型发现缓存、TTL 自清理（终态 run 与缓存默认 **30 天**过期——`ttlDays` 可配；`paidan list` 会顺带清理过期记录，并非纯只读查询） |

数据永不回流进代码仓。数据目录可通过配置搬走；没有任何东西钉死在一台机器上。

## 端点

端点 = 一份**数据清单**（`endpoints/<name>.json`）+ 一个小 parser（一个协议一个文件，约 150-260 行）。清单声明：如何探测 agent 二进制、命令模板、权限能力映射、prompt 投递方式、输出解析类型、模型发现命令，以及带最后验证日期的能力标志。

权限预设（`read-only` / `workspace-write` / `unattended`）只是便利语法——每个端点把它映射到自己的原生权限模型；无法强制某预设的端点会如实声明（`soft` 或 `unsupported`），不会假装支持。见 `docs/contracts.md`。

| 端点 | 预设（ro/ww/ua） | 用户可见的意外点 |
|---|---|---|
| kimi-code | – / ✅ / ✅ | 原生 print auto，无可强制的只读档；usage 来自原生账本。完整模型别名可分别选择 OAuth/API 接入。显式强度仅用于已确认的 kimi 协议 thinking 模型，其他协议跟随原生强度。 |
| codex | ✅ / ✅ / ✅ | 原生 `exec --json`；resume 恢复原会话 sandbox。模型菜单及各模型强度由所选 CLI 查询；固定选择绑定当时的原生配置，配置变化后让用户重新选择。`--native` 可仅本次跟随。 |
| claude-code | – / ✅ / ✅ | 展示别名映射与完整模型 ID，固定选择在原生配置变化后需重新确认。强度只用原生参数。默认 acceptEdits + permission-prompts=none；保留原生 allow，无法强制只读。 |
| zcode | – / – / ✅ | 只走 print/yolo（unattended）。先在 ZCode 配置并启用可用 API Key 接入；桌面 OAuth 登录不保证无头可用。可跟随原生，或由安装 agent 按授权创建原生专用 JSON，把路径写入 endpoints.overrides.zcode.provider_config。调用后报告期望/实际 provider、模型和强度；失败先询问，不自动换连接。见 [INSTALL.md](INSTALL.md)。 |
| opencode | ? / ✅ / ✅ | 查询实际目录中的配置与 provider/model → variant，固定组合绑定原生配置；失效先让用户选择。1.18.31 写入/续接通过，只读拒绝证据不足，标为未验证。 |
| omp | ✅ / ✅ / ✅ | 当前 OMP_PROFILE 的 selector/逐模型 thinking 与认证元数据；固定组合校验并绑定配置。18.2.5 写入/只读拒绝/续接通过。原生账号轮换、fallback 与角色切换仍按用户原生配置执行，并在查询时提示。 |
| dsh | ✅ / ✅ / – | 原生 headless profile 管理 provider/model/reasoningEffort；菜单只展示明确配置范围，修改需用户同意，无 paidan 模型/强度覆盖。0.1.5-rc.2 写入/只读拒绝通过，不支持续接。 |
| agy | soft / ✅ / ✅ | 固定完整模型 ID，自带档位不叠加 --effort；原生连接与配置变化可检查，账号类型不猜。1.2.5 写入/续接通过，只读探针超时，保持 soft。写入仍需原生 allow 规则与正确工作目录提示。 |

图例：✅ 支持 · – 不支持 · soft = 声称支持但强制力存疑（提交时出 warning）。

## 维护模式

本项目**由 AI agent 维护**（人类低带宽监督）。响应可能很慢。欢迎并鼓励 fork——仓按自解释设计：读 `AGENTS.md` 了解不变量与如何加端点。

兼容性结论都带日期：agent CLI 会漂移，`paidan doctor` / `paidan probe` 实测你安装版本的真实行为，而不是轻信文档。

## 状态

早期（0.x）。引擎可用；八份端点清单全部接入，凡装有对应 agent 的机器上契约探针均通过（dsh 无 resume 可探；zcode headless 设计上仅 yolo）。八端点真实委派 sweep 已在作者机器上通过（2026-09-10）。MIT 许可。

## 平台支持

| 平台 | 引擎 | 备注 |
|---|---|---|
| Windows 10/11 | ✅ 实测主力 | cancel = taskkill 树杀，先温和后强制（强杀后孤儿孙进程属 accepted limitation——Job Object 需要 FFI，零依赖不变量） |
| Linux | 🟡 已设计，未实测 | 配置在 `$XDG_CONFIG_HOME/paidan`（默认 `~/.config/paidan`）；cancel = POSIX 进程组信号 |
| macOS | 🟡 已设计，未实测 | 同 POSIX 路径（`~/.config/paidan`，刻意不走 `~/Library/Application Support`——一条代码路径） |

平台相关面刻意保持极小（配置目录、二进制解析、进程杀法），且每处都有 POSIX 分支；缺的是真实机器验证。单元测试与 golden fixture 全平台可跑，由三平台 CI 矩阵（Windows / Linux / macOS）强制；契约探针在 agent 未安装时自动跳过。所有平台要求 Node ≥ 24。

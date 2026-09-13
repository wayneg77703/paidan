# paidan（派单）

[English](README.md) · 简体中文

把任务委派给你机器上已安装的 AI CLI agent。
每个任务都是一个**持久 run**：可以等待、可以取消、重启之后仍可查证结果。

```
npm i -g paidan                               # 需要 Node >= 24（node:sqlite）
paidan init                                   # 首跑向导（探测端点、勾选默认项、安装宿主 skill）
paidan doctor                                 # 哪些 agent 已安装且可用？
paidan run --endpoint kimi-code --cwd . --task "总结这个仓"
paidan list
paidan get <run_id> --wait
paidan cancel <run_id>
paidan models --endpoint kimi-code            # 缓存优先；--refresh 重新查询
```

要**通过 AI agent** 在新机器上安装（agent 读取机器状态、向你列出选项、代为完成安装）？把 [`INSTALL.md`](INSTALL.md) 交给它。

CLI 的 stdout 恒为 JSON。没有 daemon：每个 run 由一个 detached worker 进程监督，磁盘上的 run store 是唯一事实源。

新读者一句话：**宿主**是发单方（你，或你请的 AI agent）；**端点**是执行方；**run** 是一次任务的持久记录——请保存 `run_id`。`effort` 是端点支持的推理强度选项（若有）；权限**预设**（`read-only` / `workspace-write`（默认）/ `unattended`）是映射到各 agent 原生权限模型的便捷层。终态判定是证据优先的：`completed` 是证据成立，不只是 `exit 0`。

## 宿主接入

宿主 AI agent 通过 CLI 驱动 paidan——没有插件体系。`paidan init` 向导是全交互的：启用端点与安装 skill 的宿主都是复选框多选（空格勾选、回车确认；skill 文件见 [`skills/paidan/SKILL.md`](skills/paidan/SKILL.md)），默认端点用方向键菜单单选，**每个能 headless 接模型的启用端点**各自选默认模型（dsh/zcode 这类模型归原生配置管的端点只给提示不参与；选择存为 `defaults.models.<端点>`——**向导绝不写全局 `defaults.model`**，那会毒害这两类端点）。**每个受支持的 agent 都既是被调方也能当宿主**——[`skills/hosts.json`](skills/hosts.json) 登记了全部八个 agent 的用户级技能目录（kimi-code、claude-code、zcode、codex、dsh、opencode、agy、omp），且各宿主安装的是按其规范**原生设计**的变体文件（`skills/paidan/variants/<宿主>.SKILL.md`——frontmatter 原生、正文一致、逐字安装不裁剪）。也可以手工复制对应变体（Kimi Code：复制到用户级 `~/.kimi-code/skills/paidan/` 目录）。它教会宿主七个动词、权限预设语义和「证据优先」的终态判读规则。`paidan init --yes` 走零覆盖路径——模型/强度全部留在端点原生默认（各原生 home 当前实际值经 `paidan doctor` 的 `native_defaults` 只读可见——这是**部分端点实现**的原生配置快照，`null` 可能表示未实现或读取失败，不等于最终生效值）；`--yes --effort <档>` 把该档应用到所有声明了它的端点。

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
| kimi-code | – / ✅ / ✅ | 完全没有 headless 只读档（`-p` 固定 auto 权限；探针实证）。usage 来自原生会话账本（`endpoint-ledger`）。强度（low/high/max）走环境变量——0.42.0 无 CLI flag；`KIMI_MODEL_THINKING_EFFORT` 覆盖原生 config 键。 |
| codex | ✅ / ✅ / ✅ | resume 恢复原会话的 sandbox 档（`exec resume` 不收 `-s`/`--add-dir`）。强度走 `-c model_reasoning_effort`（minimal–xhigh；不设时用原生 config 值）。 |
| claude-code | ✅ / ✅ / ✅ | read-only = 默认档 + `--permission-prompts none`；shell.exec 需要 bypassPermissions（unattended）。 |
| zcode | – / – / ✅ | 设计上仅 yolo（非 yolo 档 headless 下永远等待）。桌面版不装 PATH 二进制——默认安装目录由 `detect.known_paths` 自动探测；自定义安装位置 init 向导内可直接录入 bin 路径（或手工设 `endpoints.overrides.zcode.bin`/自制 shim）。headless 还需要用户自行开通的凭据：**把 `~/.zcode/v2/config.json` 里的 `provider` 节复制（合并）进 `~/.zcode/cli/config.json` 的同名 `provider` 节**（v2 文件本身只有 provider 一节，拷进 cli 即可；cli 里已有的 hooks/plugins/mcp/model 键不受影响）——这就是让 zcode 端点可被调用的那一步，桌面已登录的各 provider（BigModel/GLM 套餐、z.ai 或其他）随之进入 headless。z.ai（智谱国际版）账号也可 `node <安装目录>/resources/glm/zcode.cjs login`（Z.AI OAuth；无浏览器加 `--no-browser`）；`ZCODE_MODEL`/`ZCODE_BASE_URL`/`ANTHROPIC_API_KEY` 可作 env 兜底。`doctor` 以 `credential_ready` 预检。 |
| opencode | ✅ / ✅ / ✅ | 项目根会被继承的 `PWD` 锚定——paidan 钉 `run --dir <cwd>` 并 unset `PWD`。v0 不支持 `add_dirs`（需要 computed-env 权限投影）。 |
| omp | ✅ / ✅ / ✅ | workspace-write 档**没有 shell.exec**（bash/eval fail closed）；shell 需 unattended（yolo）。 |
| dsh | ✅ / ✅ / – | 无 PATH shim——约定位置（`~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js`）由 `detect.known_paths` 自动探测；否则设 `endpoints.overrides.dsh.bin`。无 resume（headless 不返回会话句柄）。read-only 走 `mode_env`（DSH_PERMISSION_MODE），因为任何额外 argv 片段都会并进 prompt。 |
| agy | soft / ✅ / ✅ | fs.write 与 shell.exec 同为 **soft**；read-only 同为 **soft**（1.2.1 探针 indeterminate——plan 模式 headless 可能不再像 1.1.28/1.2.0 那样自动拒绝而是挂起，待专项复核）：1.2.0 起 `write_to_file` 被限定在 agy 自己的会话 artifacts 内，交付物写入实际走 `run_command`（shell，由原生 `command(*)` 放行规则门控），其起始目录是 agy 自己的 scratch——paidan 会追加 cwd 提示让绝对路径落位。fs.read 需 `read_file`，且 Windows 上目前仅无作用域的 `read_file(*)` 生效（上游限制）。没有 `--sandbox` 标志；强制由原生 `~/.gemini` 权限设置承载，paidan 永不改写（不变量 4）。`write_file` 放行规则对交付物**并非必需**（1.2.0 已证伪的旧结论；早期作用域规则指引不再适用）。 |

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

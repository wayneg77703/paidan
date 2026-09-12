---
name: paidan
description: >-
  当需要把任务委派给本机已安装的 AI CLI agent（kimi-code、codex、claude-code、zcode、opencode、omp、dsh、agy）时使用本 skill：通过 paidan CLI（run/get/cancel/list/models/doctor/probe）把任务交给对应 agent，每个任务是一个持久 run，可等待、可取消、重启后可查证。这是本机委派的唯一受管通道，跨 agent 调第二意见、派对抗审查、并行子任务同此。
---

# 宿主 agent → paidan（派单）

paidan 是本机委派工具：把任务交给本机已安装的 AI CLI agent 执行。stdout 恒为单个 JSON 信封（`{ok:true,...}` 或 `{ok:false,error:{code,message}}`），人类文本只在 stderr。没有 daemon：每个 run 由 detached worker 监督，磁盘 run store 是唯一真相源。

## 标准调用循环

1. 派发：任务正文写入 UTF-8 文件后运行 `paidan run --endpoint <name> --cwd <绝对路径> --task-file <任务文件>`；短任务可用 `--task <文本>`。返回即完成派发，**立即保存 `run_id`**。长正文一律用 `--task-file`（argv 投递有长度上限教训）。可选：`--mode <预设>`、`--model <别名>`、`--effort <档位>`（仅声明了 effort 块的端点：claude-code/omp/opencode/codex/kimi-code，档位表见各端点 manifest 或 `paidan doctor`）、`--add-dir <路径>`（可多次）、`--deliverable <相对路径>`（可多次，声明交付物供终态证据核对）。
2. 收取：`paidan get <run_id> --wait` 前台阻塞到终态；可加 `--timeout <秒>` 防宿主工具超时。底层 run 是持久的，宿主超时后重新 `get --wait` 即可继续收取，**不重派**。
3. 取消：仅用户明确要求停止时 `paidan cancel <run_id>`。
4. 查找历史：`paidan list [--state completed,failed] [--limit N]`。
5. 模型名单：`paidan models --endpoint <name>`（缓存优先）；仅用户要求或该 agent 升级后 `--refresh`。不猜测、不自造模型名单。
6. 体检：`paidan doctor` 看端点探测/版本/权限图/`repair_hint`；端点行为存疑或 agent 升级后跑 `paidan probe --endpoint <name>`（P1 写入/P2 只读拒绝/P3 续接契约探针）。

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

- 三预设：`read-only` / `workspace-write`（省略时的默认）/ `unattended`。各端点把预设映射到自己的原生权限模型。
- 端点无法强制所请预设时**提交期硬拒** `PERMISSION_UNSUPPORTED`（message 列出缺失能力），不会降级偷跑。此时不得改权限重试；报告限制，或换支持该预设的端点。
- `soft` 能力只记入返回的 `warnings` 字段，任务照跑；含义是端点声称支持但强制力存疑。
- 预设支持速查（以 `paidan doctor` 实况为准）：kimi-code 无 `read-only`；zcode 仅 `unattended`；dsh 无 `unattended`；omp 的 `workspace-write` 不含 shell.exec（shell 需 `unattended`）；agy 的 shell.exec 为 `soft`。

## 终态判读纪律（证据优先）

- `exit 0` 不算成功。以 `get` 返回的 `run.state` + `result.evidence` 为准：`completed | failed | cancelled | unknown`，另有可能见到 `attention`。
- `unknown` 是合法终态 = 证据不足；读 `result.evidence`（`deliverables[].found`、`refusals`、`parser.degraded`、`notes`）与 `result.final_text` 自行判断，据实报告。
- `attention` = reconcile 发现 worker 已死但 run 非终态；不会自动重启，可 `cancel` 关闭后按用户授权决定是否重新委派。
- `evidence.refusals`（端点内band 拒绝信号）是证据，不是自动失败。
- `usage.source` 三态：`provider`（端点输出流自带）/ `endpoint-ledger`（原生账本观测，kimi）/ `unavailable`（诚实标记，不是错误，不得伪造 0）。

## run_id 与幂等纪律

- 已有 `run_id` 的任务只查询不重派；宿主等待超时、回执不明均不构成重派理由。
- 幂等：相同 fingerprint（endpoint+cwd+任务正文+mode）在非终态 run 存在时复投返回原 run（`created:false` + note），不会产生重复执行。
- 取消已终态的 run 是无害 no-op（返回 `already terminal`）。

## 续接（resume）

- `paidan run --endpoint <name> --cwd <与首次相同> --resume <session_handle> --task-file <新任务>`；`session_handle` 取自上次 `get` 结果的 `result.session_handle`（或 `run.session.handle`）。
- resume 的权限档分两类端点：**恢复原档型**（codex `exec resume` 不收 `-s`/`--add-dir`，恢复会话原 sandbox，本次 `--mode` 只记在请求里不生效，提交回执会带警告）；**重定档型**（claude 等 flag 拼接路径会重传本次 mode；agy 本次调用可重新定档）。kimi/zcode 会话按 cwd 绑定，必须同 cwd。dsh 无 resume。

## 红线（不可越过）

- 永不把凭据搬进任务正文、参数或配置；端点用各 agent 自己的原生配置与调用方 env 运行，paidan 不代理、不暂存凭据。
- paidan 不写任何 agent 的原生 home；缺原生设置时按 `doctor` 的 `repair_hint` 报告，不擅自改用户配置。
- 模型/连接失败（配额、认证等）时**永不静默切换路径**：拒绝并报告，不自动换模型、换端点、换账期、升权。注意区分：失败时刻的自动 fallback 被禁止；用户/宿主**显式**选择换模型换档位（每次委派时明示）是正常操作，不属于此条。端点自身的 fallback 机制（如 claude 原生 `--fallback-model`、网关侧切换）归端点与用户配置管，paidan 不知情也不拦截。
- 不传 `--model` 时生效值为 `--model ?? config defaults.models.<端点> ?? 端点原生默认`（无全局回退键；不跨连接）；dsh/zcode 这类端点没有 headless 模型选择（模型归其原生配置管），给它们配了模型会被 `MODEL_UNSUPPORTED` 拒绝。需要核对时用 `paidan models --endpoint <name>` 查询；各端点原生 home 当前实际用什么模型/强度，`paidan doctor` 的 `native_defaults` 只读可见。

## 错误处理

先读 `error.code` + `error.message`，不只看进程退出码。常见码：`ENDPOINT_UNKNOWN` / `ENDPOINT_DISABLED`（未在 config 启用）/ `PERMISSION_UNSUPPORTED` / `MODE_INVALID` / `TASK_REQUIRED` / `TASK_TOO_LONG`（argv 投递端点的最终命令行超长——缩短正文或改用 stdin/file 投递的端点；`--task-file` 只改变 paidan 读正文的方式，**不解除** argv 端点的长度上限）/ `SPAWN_UNSUPPORTED`（端点只能经 cmd shim 解析且为 argv 投递，按 message 设 overrides.bin 或装原生 exe）/ `MODEL_UNSUPPORTED`（端点无 headless 模型选择却配了模型，按 message 从 config 删除对应键）/ `EFFORT_UNSUPPORTED`（端点无 effort 选择）/ `EFFORT_INVALID`（档位不在端点 options 内）/ `RUN_NOT_FOUND` / `CONFIG_INVALID` / `WORKER_SPAWN_FAILED`。端点相关问题先 `paidan doctor` 看探测状态、`drift` 与 `issues`，再决定报告或修复；`get --wait` 返回 `attention` 或 `needs_attention` 时立即向用户报告（worker 已失联，不会自愈）。

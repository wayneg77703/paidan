# paidan（派单）

简体中文 · [English](README.en.md)

把任务交给本机其他 AI CLI agent 执行。你可以继续与当前 agent 沟通，再查看任务结果、等待完成或取消任务；任务记录保存在本机，重启后仍可查询。

支持 **Codex、Claude Code、Kimi Code、ZCode、OpenCode、OMP、DSH、AGY**。

## 安装

需要 **Node.js 24+**，以及你打算接入的 agent。登录或 API 接入在各 agent 的原生工具中配置。

推荐把[仓库链接](https://github.com/wayneg77703/paidan)交给能执行本机命令的 agent，直接说：

> 按 INSTALL.md 帮我安装 paidan，接入 Codex 和 ZCode，并给你安装派单 skill。其他端点先不配置。

它会查找程序入口，展示当前连接、模型和推理强度，让你选择跟随原生或固定组合。多份安装由你选择，保存前说明改动；配置、备份和安装记录由程序完成，无需手写 JSON。默认不调用模型试跑。

**宿主**是负责发单的 agent，**端点**是接任务的 agent，可以分别接入。中文用户的安装对话使用中文。

也可以先自行安装，再让 agent 完成配置：

```sh
npm install -g paidan
paidan --version
```

终端用户可选用 `paidan init`。Windows 若阻止 `.ps1`，使用已有的 `npm.cmd` / `paidan.cmd`；程序没出现在 PATH 中，也可以提供安装目录让安装 agent 继续查找。

## 日常使用

宿主装好 skill 后，直接说明任务、执行端点和要求：

> 用 paidan 交给 Codex 检查这个项目的代码，只读审查，完成后把问题汇总给我。

> 把这个报错交给 Kimi Code 修复，允许修改当前项目并运行测试。

> 看一下刚才的派单完成了没有；如果还在运行，继续等待。

使用终端时，先提交任务：

```sh
paidan run --endpoint codex --cwd . --mode read-only --task "检查这个项目，列出主要问题"
```

命令返回 `run_id`，用它查看结果或取消任务。CLI 输出为 JSON。

| 操作 | 命令 |
|---|---|
| 查看结果并等待完成 | `paidan get <run_id> --wait` |
| 查看近期任务 | `paidan list` |
| 取消任务 | `paidan cancel <run_id>` |
| 从文件读取较长的任务说明 | `paidan run --endpoint codex --cwd . --task-file task.md` |
| 查看某端点的模型候选 | `paidan models --endpoint codex` |
| 检查某端点的路径与配置 | `paidan doctor --endpoint codex` |
| 查看命令参数 | `paidan help run` |

尖括号内容需替换为实际值。设置了默认端点后可省略 `--endpoint`。等待超时后继续查询同一个 `run_id`，不要重复提交；重启不会自动重跑未完成任务。

## 调整配置或新增端点

不必重新安装，也不必重配其他端点。告诉安装 agent 你的需求即可：

> 我新装了 OpenCode，只把它接入 paidan，其他配置和默认端点不变。

> 把 Codex 改成跟随它自己的模型和强度设置。

> ZCode 换了安装位置，帮我重新定位，保留原来的模型选择。

程序只处理选中的端点。默认可跟随原生设置；需要固定时，按 **连接 → 模型 → 该模型支持的强度** 选择。各家的接入差异如下：

| 端点名称 | 接入时需要知道 |
|---|---|
| `codex` | 可跟随原生，或固定模型与强度；固定选择遇到连接配置变化时需重新确认。 |
| `claude-code` | 可选择具体模型或动态别名，以及支持的强度；别名会随原生映射变化。 |
| `kimi-code` | 通过模型别名选择 OAuth/API 接入；强度能否固定取决于该模型和协议。 |
| `zcode` | 先在 ZCode 中配置并启用 API provider，桌面登录不保证 CLI 可用。支持安装在其他盘；固定组合由程序生成专用配置。 |
| `opencode` | 选择 provider/model 和该模型的 variant；配置查询使用实际任务目录。 |
| `omp` | 使用当前原生 profile 的模型与 thinking 设置；原生账号轮换、fallback 仍可能生效。 |
| `dsh` | 使用原生 headless profile 的模型与强度，不支持 paidan 模型参数覆盖。缓存入口失效后需重新定位；不支持续接。 |
| `agy` | 选择完整模型 ID，名称中自带的强度不再重复设置；缺少原生权限规则时需另行处理。 |

ZCode 专用文件可能包含所选 API Key 的本地副本，创建前会说明并征得同意；原始配置保持不变。DSH 的原生默认值调整也会先说明影响范围，再由程序处理支持的配置格式。

模型选择与执行权限分开。默认权限通常允许修改工作目录，ZCode 使用权限更宽的 `yolo`。需要只读时明确提出；各端点的支持范围见[权限说明](INSTALL.md#无头权限默认与模型默认分开)。Codex 调用时关闭交互审批，Claude Code 拒绝需要交互确认的操作，再由宿主处理结果，避免无头任务等待用户输入。

## 调用失败怎么办

把 `run_id` 和错误交给宿主 agent。它会结合任务结果、现有产物和当前配置判断原因，再与你确定下一步。

如果你通过 CC Switch 等工具换了连接，原来固定的模型可能不再适用。可以选择本次跟随原生、重新固定组合或修复原生接入；paidan 不会自动换账号、换计费连接或重派任务。模型菜单和 `doctor` 检查不代表账号一定有额度。

## 更新、卸载与本机数据

让安装 agent 按[更新与卸载说明](INSTALL.md#更新与卸载)操作，例如“更新 paidan 并同步已有宿主 skill”或“卸载 paidan，保留配置和历史”。单独升级 npm 包可用 `npm install -g paidan@latest`，宿主 skill 仍需同步。

默认数据位置：

- Windows：`%APPDATA%\paidan\`
- Linux / macOS：`~/.config/paidan/`，或 `$XDG_CONFIG_HOME/paidan/`

这里保存配置、安装记录和任务历史，可通过 `PAIDAN_HOME` 或数据目录配置调整。已结束任务默认保留 **30 天**，`paidan list` 会清理过期记录；需要长期保留时调整 `ttlDays`。卸载默认保留这些数据及各 agent 的原生设置。

[详细安装与端点配置](INSTALL.md) · [技术说明](docs/contracts.md) · [开发维护指南](AGENTS.md) · [MIT 许可](LICENSE)

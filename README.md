# iflow-zh

iflow（SuperClaude 全能工作流 V8）的 oh-my-pi（omp）插件包。一次安装，这台机器上每个 omp 会话都自动获得全部 21 个 `/sc:*` 命令（20 个行为命令 + 1 个只读状态命令）、15 个专家任务代理，以及一个只做调度、不做落地的主会话。

## 安装

两条路径，任选其一：

```bash
# 方式一：npx（直接跑安装器，等价于在会话内执行 /sc:setup 的那一步）
npx iflow-zh
```

```bash
# 方式二：先装插件，再进会话跑一次 /sc:setup
omp plugin install iflow-zh
omp
/sc:setup
```

`/sc:setup` 只在用户级 `~/.omp/agent/AGENTS.md` 里按标记维护一个 iflow 托管区块——只增改该区块、绝不替换你已有的内容（首次改动前留一份 `.bak`，之后不覆盖它）。iflow 不改写你的 config.yml：每个专家 Agent 在其定义里声明复用的内建角色（`@slow`/`@task`），无需手动为每个专家选角色；这些角色对应的具体模型、思考深度（`@slow:high`）与网络故障回退链 `retry.fallbackChains` 全部由你自己在 config.yml（`/model`、`modelRoles`）配置，`task.agentModelOverrides` 可再覆盖单个专家。omp 原生保证 task 子 Agent 继承其解析 Role 的思考深度与回退链。

> 说明：`npx iflow-zh` 这条路径尚未针对已发布到 npm registry 的包做过实跑验证；`omp plugin install` + `/sc:setup` 是仓库内已验证的路径。

## 卸载

```bash
npx iflow-zh --uninstall
```

按备份清单还原再移除插件。`/sc:setup` 每次首改前，会把原文件路径、是否原本存在、`.bak` 备份路径及其 sha256 记入用户级 `~/.omp/agent/.iflow-setup.json`。`--uninstall` 据此逐项处理：原本存在的文件先校验 `.bak` 的 sha256 与清单一致（不一致视为被改动，跳过而非写入可疑内容），通过后还原并清理 `.bak`；iflow 新建的文件则移除托管区块，若你之后未在其外添加内容便删除该文件，否则保留你添加的内容。随后执行 `omp plugin uninstall iflow-zh`。加 `--dry-run` 仅预览不写入。

## 运行时落地的内容

| 组件 | 作用 |
| :--- | :--- |
| `extension/iflow.ts` | 注册全部 21 个 `/sc:*` 命令；把主会话收窄为调度者工具集；路由 `task` 调用到对应专家；`tool_call` 钩子兜底门禁剩余入口 |
| `framework/` | `commands/sc/*.md` 的 21 条命令正文，按 `import.meta.url` 解析（行为命令展开为下一条提示；`cleanup` 由扩展直接执行） |
| `agents/` | 15 个专家 Agent 定义，被 omp task-agent 发现扫描，可被 `task` 按名称委派 |
| `rules/` | `iflow-framework.md`（完整框架配置，always-apply，`agents:` 白名单注入每个 task 子 Agent；主会话不加载）、`iflow-sticky.md`（执行方硬约束，随 `task` 转发到每个专家）与 `iflow-dispatch.md`（调度者指令，仅主会话可见） |
| `templates/` | `/sc:setup` 按标记注入用户级 `AGENTS.md` 的 iflow 区块模板（不写 `config.yml`） |

## 主会话调度者模式

插件加载后，主会话被收窄为 `read grep glob task todo ask hub` 这一组调度者工具——落地动作（`edit`/`write` 等）一律通过 `task` 分派给专家代理执行。

- 运行中需要临时放开、自己改文件时：`/sc:dispatch off`
- 启动时直接一关到底：`omp --sc-dispatch off`

该收窄对 headless（`omp -p`、`omp --mode json`）同样生效；扩展的状态信息走 stderr，stdout 保持机器可读。

## /sc:cleanup：会话后台任务快照（只读）

`/sc:cleanup` 是状态命令，由扩展直接注册并执行（不走提示词展开，加载器自动跳过该 Markdown 避免重复注册）：调用 omp 18.1.13 扩展 API `ctx.getAsyncJobSnapshot()`，只读列出**当前会话拥有的**后台异步任务（task 子代理等）与投递状态，支持 `--json` 与 `--help`。

**能力边界（omp 18.1.13 的现实，如实声明）**：该 API 只有只读快照；omp 未向插件暴露任何取消或清理接口（`AsyncJobManager.cancelAll` / `evictCompletedJobs` 是宿主内部方法，不在扩展面上）。`/sc:cleanup` 不会也不能终止或删除任何任务；已完成任务行由宿主约 5 分钟后自动淘汰。要停止运行中的任务，请使用宿主机制：TUI 按 `Esc` 中断当前回合，或用内建 `/jobs` 查看。

## 环境要求

- Node.js >= 20
- 已安装 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）

## 上游与许可 / Upstream and license

- 原始作品：**lzA6**，https://github.com/lzA6/SuperClaude-Framework-upgrade
- 本分发：**yous1rr/SuperClaude-Framework-upgrade**，https://github.com/yous1rr/SuperClaude-Framework-upgrade
- 许可证：**Apache License 2.0**，完整文本见随附 [`LICENSE`](./LICENSE) 与 [`NOTICE`](./NOTICE)

本分发对上游 `.iflow/` 下的 21 条 `/sc:*` 命令描述做了中文改写，并新增了 `iflow-zh/` 这一层 omp 插件（TypeScript 扩展、打包后的代理、规则与模板）。

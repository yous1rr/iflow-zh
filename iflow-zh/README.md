# iflow-zh

iflow（SuperClaude 全能工作流 V8）的 oh-my-pi（omp）插件包。一次安装，这台机器上每个 omp 会话都自动获得全部 21 个 `/sc:*` 行为命令、15 个专家任务代理，以及一个只做调度、不做落地的主会话。

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

`/sc:setup` 只写用户级 `~/.omp/agent/AGENTS.md`（合并前留一份 `.bak`）。iflow 不注入任何模型配置：`modelRoles`（含 `@slow:high` 这类思考深度后缀）、`task.agentModelOverrides` 与网络故障回退链 `retry.fallbackChains` 全部由你自己在 config.yml 配置，iflow 不创建、不覆盖、不删除，旧版 iflow 写入的键也原样保留。omp 原生保证 task 子 Agent 继承其解析 Role 的思考深度与回退链。

> 说明：`npx iflow-zh` 这条路径尚未针对已发布到 npm registry 的包做过实跑验证；`omp plugin install` + `/sc:setup` 是仓库内已验证的路径。

## 运行时落地的内容

| 组件 | 作用 |
| :--- | :--- |
| `extension/iflow.ts` | 注册全部 21 个 `/sc:*` 命令；把主会话收窄为调度者工具集；路由 `task` 调用到对应专家；`tool_call` 钩子兜底门禁剩余入口 |
| `framework/` | `commands/sc/*.md` 的 21 条命令正文，按 `import.meta.url` 解析 |
| `agents/` | 15 个专家 Agent 定义，被 omp task-agent 发现扫描，可被 `task` 按名称委派 |
| `rules/` | `iflow-framework.md`（完整框架配置，always-apply，注入主会话与每个子 Agent）、`iflow-sticky.md`（执行方硬约束，随 `task` 转发到每个专家）与 `iflow-dispatch.md`（调度者指令，仅主会话可见） |
| `templates/` | `/sc:setup` 合并进用户级 `config.yml` 与 `AGENTS.md` 的模板 |

## 主会话调度者模式

插件加载后，主会话被收窄为 `read grep glob task todo ask hub` 这一组调度者工具——落地动作（`edit`/`write` 等）一律通过 `task` 分派给专家代理执行。

- 运行中需要临时放开、自己改文件时：`/sc:dispatch off`
- 启动时直接一关到底：`omp --sc-dispatch off`

该收窄对 headless（`omp -p`、`omp --mode json`）同样生效；扩展的状态信息走 stderr，stdout 保持机器可读。

## 环境要求

- Node.js >= 20
- 已安装 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）

## 上游与许可 / Upstream and license

- 原始作品：**lzA6**，https://github.com/lzA6/SuperClaude-Framework-upgrade
- 本分发：**yous1rr/SuperClaude-Framework-upgrade**，https://github.com/yous1rr/SuperClaude-Framework-upgrade
- 许可证：**Apache License 2.0**，完整文本见随附 [`LICENSE`](./LICENSE) 与 [`NOTICE`](./NOTICE)

本分发对上游 `.iflow/` 下的 21 条 `/sc:*` 命令描述做了中文改写，并新增了 `iflow-zh/` 这一层 omp 插件（TypeScript 扩展、打包后的代理、规则与模板）。

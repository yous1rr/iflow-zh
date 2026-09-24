# 🌟 iflow — SuperClaude 全能工作流 V8（oh-my-pi 入口）

本文件是 **oh-my-pi (omp)** 的项目上下文入口。框架唯一事实源位于 `.iflow/`，
本文件通过 `@` 导入（相对本文件解析）将框架组件接入 omp 会话。

## 框架组件（入口 → 旗帜/原则/规则/行为模式）

@../.iflow/IFLOW.md

## oh-my-pi 会话说明

- **行为命令**：`/sc:*` 系列命令（如 `/sc:implement`、`/sc:task`）由已安装的
  `iflow-zh` 插件在启动时从 `framework/commands/sc/*.md` 动态注册，执行时将命令全文
  （含触发条件、行为流程、输出格式）注入为下一条用户提示。
- **专家智能体**：15 个专家任务代理随插件发布（`iflow-zh/agents/`），可通过 task 工具
  按名称委派（如 `security-engineer`、`universal-omni-agent-v8`）。修改 `.iflow/agents/`
  后运行 `node iflow-zh/scripts/build-agents.mjs` 重新生成 `iflow-zh/agents/` 与
  `iflow-zh/framework/`。
- **硬性规则**：两条 always-apply 规则随插件发布——`rules/iflow-sticky.md`（执行方硬性
  规则，每个回合附加）与 `rules/iflow-dispatch.md`（调度方指令，仅主会话附加）。
- **命令索引**：会话内输入 `/sc` 可列出全部可用命令、代理与模式。
- **注意**：`iflow-zh` 以机器范围安装，本仓库会话直接运行已发布副本，项目级
  `.omp/agents/` 已不再存在、不再遮蔽插件根目录。

## 模型与任务路由

- 主会话默认使用 OMP 内置 `@slow` Role，负责用户交互、任务拆解、结果汇总和最终验证。
- 子任务通过 OMP 原生的 `task.agentModelOverrides` 映射到 `@smol`、`@task` 或 `@slow`。
- `.omp/config.yml` 只保存项目通用的 Agent → 内置 Role 映射，不绑定具体供应商或模型名称。
- 插件扩展仅在 task 未显式指定 `agent` 时按任务内容选择 Agent；显式选择始终优先。
- `/model` 中修改 `smol`、`task`、`slow` 后，新的子任务会使用相应模型；使用 `/sc:roles` 查看解析结果。

## 使用流程（Task-First）

理解 → 规划 → 执行 → 验证：

1. `/sc:load --type project --analyze` — 恢复项目记忆，激活 V8 核心
2. `/sc:brainstorm "想法"` 或 `/sc:task create "目标"` — 需求探索与任务分解
3. `/sc:implement feature --with-tests` — 全能专家执行实现
4. `/sc:test`、`/sc:improve`、`/sc:troubleshoot` — 质量保障闭环
5. `/sc:reflect --type session` → `/sc:save` — 总结反思并沉淀经验

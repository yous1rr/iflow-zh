# iflow — SuperClaude V8 全能工作流（omp 用户级入口）

框架事实源在 iflow-zh 插件包内，由 `omp plugin install` 安装、`/sc:setup` 写入本文件。
本文件只是一层薄壳：框架正文不经由上下文文件注入——上下文文件到不了子 Agent
（构造子会话时按文件名过滤掉 `agents.md`），规则才会随 `task` 转发到每个子 Agent。

## 框架配置的注入方式（always-apply 规则）

- **完整框架配置**（旗帜 / 行为规则 / 五个行为模式）：插件的 always-apply 规则
  `rules/iflow-framework.md` 经 `agents:` 白名单限定注入全部 task 子 Agent
  （主会话不加载本规则），升级插件即升级。
- **执行方硬性规则**：`rules/iflow-sticky.md`（always-apply），同样到达每个子 Agent。
- **调度者指令**：仅 `rules/iflow-dispatch.md`（`agents: main`）限定主会话。

## 会话说明

- **行为命令**：`/sc:implement`、`/sc:task` 等 21 条命令由插件内 extension 注册，
  执行时把命令正文注入为下一条用户提示。会话内输入 `/sc` 列出全部。
- **专家智能体**：15 个专家来自插件的 `agents/`，用 `task` 按名称委派
  （如 `security-engineer`、`universal-omni-agent-v8`）。
- **模型角色与回退**：iflow 不注入任何模型映射。模型与角色由你在
  `~/.omp/agent/config.yml` 配置（`/model`、`modelRoles`，可用 `@slow:high`
  这类带思考深度的别名；`task.agentModelOverrides` 按需覆盖单个专家）。
  网络故障回退走 omp 原生机制：在 `retry.fallbackChains` 按 Role 配置回退链，
  task 子 Agent 自动继承其解析 Role 的思考深度与回退链，无需额外设置。
  用 `/sc:roles` 查看解析结果。
- **调度者模式**：主会话的 `edit`/`write`/`bash`/`eval`/`ast_edit` 已被收窄拿掉，
  落地动作一律经 `task` 分派。临时关闭：`/sc:dispatch off`。

## 使用流程（Task-First）

理解 → 规划 → 执行 → 验证：

1. `/sc:load --type project --analyze` — 恢复项目记忆
2. `/sc:brainstorm "想法"` 或 `/sc:task create "目标"` — 需求探索与任务分解
3. `/sc:implement feature --with-tests` — 派专家执行实现
4. `/sc:test`、`/sc:improve`、`/sc:troubleshoot` — 质量保障闭环
5. `/sc:reflect --type session` → `/sc:save` — 总结反思并沉淀经验

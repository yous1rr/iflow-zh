---
name: cleanup
description: "只读报告本会话拥有的后台异步任务快照（omp 18.1.13 无插件侧取消/清理接口）"
category: workflow
complexity: simple
---

# /sc:cleanup - 会话后台任务快照（只读）

## 定位

`/sc:cleanup` 是**状态命令**：由 `iflow-zh/extension/iflow.ts` 直接注册并执行
（Markdown 加载器跳过本文件，避免重复注册），不展开为提示词。它调用 omp 扩展
API `ctx.getAsyncJobSnapshot()`，只读列出**当前会话拥有的**后台异步任务
（task 子代理等）与投递状态。本命令不执行任何变更。

## Usage

```
/sc:cleanup [--json] [--help]
```

## Behavior

1. 默认：人类可读快照——运行中任务、最近任务（含已完成/失败/已取消）、投递状态（queued / delivering / nextRetryAt）
2. `--json`：机器可读 JSON（`available` / `running` / `recent` / `delivery` / `sessionId` / `mutation`）
3. `--help`：用法与限制说明
4. `snapshot === null`（后台任务在该会话不可用）时如实报告，不伪造空结果

## 硬性限制（omp 18.1.13，如实声明）

- 扩展 API 只有**只读快照**：`ctx.getAsyncJobSnapshot(): AsyncJobSnapshot | null`
  （`running` / `recent` / `delivery`，每项仅 `id` / `type` / `status` / `label` / `startTime` / `agentId`）。
- **没有任何公开的取消或清理接口**。`AsyncJobManager.cancelAll` /
  `evictCompletedJobs` 是宿主内部方法，未暴露给插件；本命令不会、也不能终止或
  删除任何任务，`mutation` 恒为 `{ cancel: false, prune: false }`。
- 已完成任务行由 omp 宿主在完成后约 5 分钟自动淘汰（`recent` 窗口由宿主控制）。
- 在外部进程中被 kill 的任务无法由插件"观测清除"——快照只反映宿主会话内存中
  的真实状态。

## 宿主侧处理途径（引导用户）

- 终止运行中的任务：TUI 按 `Esc` 中断当前回合。
- 查看任务：omp 内建 `/jobs`。
- 任务行淘汰：宿主自动完成，无需插件干预。

## Boundaries

**Will:**
- 只读报告本会话拥有的任务快照与投递状态
- 如实说明插件无取消/清理能力，并指向宿主机制
- 支持 `--json` 供脚本消费

**Will Not:**
- 取消、终止、删除或"清理"任何任务
- 伪造"已清理"结果
- 触碰其他会话（其他 ownerId）的任务

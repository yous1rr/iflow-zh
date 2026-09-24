Title: 把 iflow 全部工作流收进一个 omp 插件，用 `omp plugin install` 让它在这台机器上全局接管，并把主 Agent 降级为纯调度者
Author(s): Kiro（草案），待 lzA6 复核
Last updated: 2026-09-05
Discussion at https://github.com/lzA6/SuperClaude-Framework-upgrade/issues —— 本稿尚未开 issue，评审通过时把编号补进这一行
Status: Draft

## Abstract / 摘要

我们把 `.iflow/`、`.omp/agents/`、`.omp/extensions/iflow.ts` 和 `scripts/sync-omp-agents.mjs` 合并成一个名为 `iflow-zh` 的 omp 插件包，用 `omp plugin install iflow-zh` 装进用户插件根，从此这台机器上每个目录起的每个 omp 会话都自动拿到 21 个 `/sc:*` 命令、15 个专家 Agent 和 2 条 iflow 规则——不需要在任何项目里放一个文件。插件唯一贡献不了的是设置和上下文文件，所以包内 extension 注册一条 `/sc:setup`，把 `modelRoles` 和 `task.agentModelOverrides` 合并进 `~/.omp/agent/config.yml`，再把一行 `@` 导入写进 `~/.omp/agent/AGENTS.md`。装完主会话进入调度者模式——`edit`、`write`、`bash`、`eval`、`ast_edit` 被 `setActiveTools` 直接从它的工具表里拿掉，`tool_call` 钩子兜住剩下的入口，所有落地动作通过 `task` 分派给那 15 个专家，而它因为不再被长任务占住，随时能用 `ask` 和 `hub` 回答用户。

调查过程中撞到一件必须写进设计的事：`~/.omp/agent/AGENTS.md` 到不了子 Agent。构造子会话时，omp 按文件名把 `agents.md` 从转发的上下文文件里过滤掉，而 `@` 导入在那之前就已经展开进正文。所以今天那 14 KB 行为规则里写给执行方的每一条，15 个专家一条也收不到。设计因此按收件人重切：约束执行方的 12431 字节内容改走 `rules/iflow-sticky.md`（连 frontmatter 和标题共 12525 字节，规则会随 `task` 转发），只有调度者用得上的留在 `@` 导入链里。

三个承诺贯穿全文：`.iflow/` 仍然是唯一事实源，包里的 `framework/` 由构建期生成而非手写；`/sc:setup` 合并用户已有配置而不是覆盖它，写前先备份，并把被它遮蔽的用户级上下文文件 `@` 导入回来；主会话交出执行权，但不交出对话权。

## Background / 背景与动机

### README 让用户运行一个根本不存在的脚本

`README.md:60-67` 是当前唯一的"一键安装"说明：

```bash
# 假设的初始化命令，用于设置核心组件和依赖
# 实际操作中，您可能需要配置您的 LLM API 密钥
python3 setup.py install_v8_core
```

小标题自己写着「运行初始化脚本 (概念性)」，正文写着「假设的初始化命令」。仓库根目录没有 `setup.py`，也没有 `package.json`、`pyproject.toml`——这条命令必然报 `can't open file 'setup.py'`。文档把一个不存在的入口当成推荐路径，用户第一步就撞墙。

### 唯一真正可用的安装方式是手工拷三个目录

真正能跑的路径藏在 `README.md:104` 的注释里：

```bash
cd SuperClaude-Framework-upgrade   # 或你的项目（把 .iflow/、.omp/、scripts/ 一起拷入）
```

这句话要求用户手工搬 3 个目录、74 个文件、417 KiB（427055 字节）内容，其中 `.iflow/` 自己占 54 个文件、342 KiB：`.iflow/commands/sc/` 21 个命令、`.omp/agents/` 15 个 Agent 定义、`.iflow/` 的 9 个上下文文件（`IFLOW.md` 通过 `@` 导入 `FLAGS.md`、`PRINCIPLES.md`、`RULES.md` 和 5 个 `MODE_*.md`，合计 35422 字节注入内容）。拷漏一个 `MODE_*.md`，omp 不会报错——`@` 导入的目标缺失时原样留下 `@token`（`omp://context-files.md:167`），行为模式静默失效。拷了以后升级只能再拷一遍，每个项目一份副本。

### 路由表里有两个 Agent 名从来没有被定义过

`.omp/config.yml:17` 和 `:21` 声明了模型映射：

```yaml
    sonic: "@smol"
    scout: "@smol"
    librarian: "@smol"
...
    designer: "@task"
```

`.omp/extensions/iflow.ts:70-76` 把调研类任务路由到其中一个：

```ts
  {
    agent: "librarian",
    patterns: [
      /research/, /look up/, /lookup/, /official documentation/, /api reference/,
      /调研/, /查找文档/, /官方文档/, /接口文档/,
    ],
  },
```

`.omp/agents/` 里 15 个文件的 `name` 分别是 `backend-architect`、`devops-architect`、`frontend-architect`、`learning-guide`、`performance-engineer`、`python-expert`、`quality-engineer`、`refactoring-expert`、`requirements-analyst`、`root-cause-analyst`、`security-engineer`、`socratic-mentor`、`system-architect`、`technical-writer`、`universal-omni-agent-v8`——没有 `librarian`，也没有 `designer`。omp 的内置 Agent 只有 `scout`、`reviewer`、`security-reviewer`、`task`、`sonic`（`omp://task-agent-discovery.md:117-118`），同样不含这两个名字。

于是用户只要说一句「帮我调研一下 omp 的插件机制」，`classifyTask()` 就把它分类到 `librarian`，`task` 工具在 preflight 阶段直接失败：`Unknown agent "librarian". Available: ...`，连子进程都不会起（`omp://task-agent-discovery.md:195`）。同一份配置里 `socratic-mentor` 反过来——它有 Agent 文件，却既没有 `agentModelOverrides` 条目也没有 frontmatter `model`，静默继承父会话模型，一个教学型 Agent 因此跑在 `@slow` 上。

### 14 KB 行为规则写给执行方，却只注入了不执行的那一个 Agent

`.omp/AGENTS.md` 用 `@` 导入把 `.iflow/IFLOW.md` 这条链拉进上下文，链尾是 `.iflow/RULES.md` 那 14425 字节的行为规则。里面写给执行方的条目非常明确——Implementation Completeness 要求"No TODO Comments: Never leave TODO for core functionality"、Professional Honesty 要求"No Fake Metrics"、Failure Investigation 要求"Never Skip Tests"。这些约束的收件人只能是真正写代码的那 15 个专家 Agent。

但它们收不到。omp 构造子会话时，转发的上下文文件是过滤掉文件名为 `agents.md` 的那一份：

```ts
contextFiles: session.contextFiles?.filter(file => path.basename(file.path).toLowerCase() !== "agents.md"),
```

（omp 18.1.10 源码 `task/structured-subagent.ts:456`。）而 `@` 导入是在加载上下文文件时就地展开进正文的（`system-prompt.ts:465-474`），所以被过滤掉的不是一行 `@` 记号，是整条链展开后的全部内容。这条过滤在 `omp://` 全部文档里检索不到，文档反而把上下文文件列为子会话的内置继承项（`omp://tools/task.md:172`）——照文档写，只会得到一个静默失效的框架。

今天这 14425 字节的实际投递对象，是唯一不写代码的那个 Agent：主会话。而专家侧真正收到的只有 `.omp/RULES.md` 那 1179 字节——因为它走的是规则通道，规则会随 `task` 转发。

量化一下现状：3 个目录、74 个文件、417 KiB、3 个手工步骤、1 个不存在的脚本、2 个悬空 Agent 名、1 个漏掉角色映射的 Agent、14425 字节投给了错的收件人，而且没有任何一步会在出错时报警。

### 痛点定性：iflow 有工作流，没有分发单元

上面四件事不是四个独立 bug，是同一个缺口的四个症状。iflow 的命令、Agent、规则、路由逻辑都写好了，但没有一个"包"把它们框起来，所以没有安装、没有版本、没有构建期校验，也没人核对过每一份内容最终注入给了谁。配置和代码引用同一个名字的一致性、规则和它的收件人的对应关系，今天都靠人记。

## Design / 设计

### 一个 omp 插件包就是完整的分发单元，装进用户插件根就等于全局生效

包的目录结构如下。每一项后面标注它被谁发现——这是全篇设计的骨架：

```
iflow-zh/
  package.json              # omp.extensions: ["extension/iflow.ts"]; bin: { "iflow-zh": "bin/install.mjs" }
  extension/iflow.ts        # 由 omp 的 extension 加载器 import（package.json#omp.extensions）
  extension/setup.mjs       # /sc:setup 与 npx 共用的写入器：合并 config.yml、写 AGENTS.md
  bin/install.mjs           # 可选的 npx 入口：调 omp plugin install，再调 setup.mjs
  agents/*.md               # 由 task-agent 发现扫描（15 个，构建期从 .iflow/agents/ 生成）
  rules/iflow-sticky.md     # 由 omp-plugins 规则发现扫描（priority 90），全 Agent 生效
  rules/iflow-dispatch.md   # 同上，但 frontmatter agents: main，只约束主会话
  framework/                # 纯数据，由 extension 按 import.meta.url 自己读；不走 omp 发现
    IFLOW.md  FLAGS.md  PRINCIPLES.md  RULES.md  MODE_*.md
    commands/sc/*.md        # 21 个命令正文
  templates/
    AGENTS.md               # setup 写入 ~/.omp/agent/AGENTS.md 的薄壳模板
    config.patch.yml        # setup 合并进 ~/.omp/agent/config.yml 的键
  scripts/build-agents.mjs  # 构建期：.iflow/agents → agents/、.iflow/ → framework/，并做一致性校验
```

三样东西 omp 会自己发现，安装器一行代码都不用写：`agents/*.md` 被 task-agent 发现扫描，插件根的扫描顺序是 CLI `--extension` → 项目 `extensions:` → 用户 `extensions:` → 已安装的 npm/link 插件，全部排在内置 Agent 之前（`omp://task-agent-discovery.md:136-142`），合并按 `name` 区分大小写、首次命中胜出（:148,159）；`rules/*.{md,mdc}` 被 `omp-plugins` 规则提供者以优先级 90 扫描（`omp://rulebook-matching-pipeline.md:61`）；`package.json#omp.extensions` 声明的入口由加载器用 Bun 直接 import 再执行工厂函数，`.ts`/`.js`/`.mjs`/`.cjs` 都接受，目录条目认 `index.*`，没有编译或打包步骤（`omp://extension-loading.md:9,55,57`）。

边界要划清楚：包里不放根级 `commands/` 目录。 `omp-plugins` 会把它当作文件式斜杠命令扫描，而文件式命令没有自动命名空间——`claude` 提供者给子目录命令补一个 `foo:bar` 别名（`omp://slash-command-internals.md:89`），`claude-plugins` 提供者加 `<plugin>:` 前缀（:115），`omp-plugins` 只扫 `commands/*.md`、两者都不做（:80）。21 个命令会以 `/implement`、`/load`、`/test` 这样的裸名注册，和内置命令撞名的那些会被跳过并打一条诊断（`omp://extensions.md:736`），而内置命令在 TUI 和 ACP/RPC 里都比文件命令先派发（`omp://slash-command-internals.md:55`）。我们让 `extension/iflow.ts` 继续用 `pi.registerCommand("sc:" + name, …)` 从 `framework/commands/sc/*.md` 注册，命名空间就还在自己手里。包里同样不放 `skills/`——本仓库当前一个 skill 都没有，而 `omp-plugins` 的技能发现带 `requireDescription: true`（`omp://skills.md:65-67`），凭空造一个空目录只会换来一条发现警告。

还有一处现存代码必须改掉。`findFrameworkRoot()` 现在从 cwd 逐级向上找一个 `.iflow` 目录（`iflow.ts:159-167`），`loadCommands()` 拿它拼出 `<root>/.iflow/commands/sc`，读失败时 catch 住返回空数组（:169-177）。装成插件以后 cwd 附近根本没有 `.iflow`，这条链会静默返回 0 个命令，`session_start` 的提示变成「found no .iflow/commands/sc/\*.md」，而用户什么也没做错（:281-287）。包内 extension 必须改成按自己的模块 URL 解析：`new URL("../framework/commands/sc", import.meta.url)`。加载器解析入口的 realpath 后用 Bun 直接 import（`omp://extension-loading.md:9,228`），`import.meta.url` 因此指向插件根内的真实文件，与 cwd 无关。向上找 `.iflow` 的逻辑整条删掉，不留兼容分支——两种解析方式并存，只会让「为什么这个项目里命令是空的」变成一道调试题。

### 插件发现不了的只剩两样东西，而它们都落在用户级 agent 目录里

先说清哪些是免费的。包装进用户插件根之后，`agents/`、`rules/`、`framework/` 和 extension 入口的发现与 cwd 无关：`getEnabledPlugins(cwd)` 只用 cwd 去读项目级的 `plugin-overrides.json`，插件清单和运行状态都取自用户插件根的 `package.json` 与 `omp-plugins.lock.json`（`omp://plugin-manager-installer-plumbing.md:168-172`），四道过滤条件——无 package.json、无 `omp`/`pi` 清单、锁文件里全局禁用、被项目禁用（:176-179）——没有一条与项目布局有关。装一次，这台机器上每个目录起的每个会话都拿到全部命令、Agent 和规则。这就是「全局生效」的全部机制，一个项目级文件都不需要。

剩下两样必须写到磁盘上，而且都写进用户级 agent 目录（默认 `~/.omp/agent/`）。

**第一，插件不能贡献设置。** `omp-plugins` 能力提供者只扫描 `skills/`、`hooks/pre|post/`、`tools/`、`commands/`、`rules/`、`prompts/` 和 `.mcp.json`，task 发现额外扫 `agents/`（`omp://plugin-manager-installer-plumbing.md:202`）——这份清单里没有设置文件的位置。设置只来自五层：内置默认、全局 `~/.omp/agent/config.yml`、项目 `<cwd>/.omp/config.yml` 与 `settings.json`、`PI_CONFIG_FILES` 与 `--config` 覆盖层、运行时（`omp://settings.md:16-22`）。`omp-plugins.lock.json` 里的 `config.settings[<pkg>]` 是插件私有运行状态，不进这五层（`omp://plugin-manager-installer-plumbing.md:49-52`）。所以 `modelRoles.default` 和 `task.agentModelOverrides` 那 20 条映射只能落进 `~/.omp/agent/config.yml`——那正好也是 omp 自己的写入目标：`omp config set`、`omp config reset`、`/settings` 和运行时改设置全都写这一个文件（`omp://settings.md:89`）。

写法上有一处要点名。`omp config set task.agentModelOverrides '<json>'` 看似最省事，而且这条路径确实通：`record` 类型接受 JSON 对象（`omp://settings.md:82`），键必须精确匹配一条真实 schema 路径、没有简写（:85），而 `task.agentModelOverrides` 就是一条真实 schema 路径——`{ type: "record", default: {} }`（omp 18.1.10 源码 `config/settings-schema.ts:5131-5134`，默认值 `:472`），CLI 侧按 `record` 解析 JSON 后原样交给 `settings.set`（源码 `cli/config-cli.ts:216-236`）。`settings.md` 的 `task.*` 分组只列了 `task.softRequestBudget` 和 `task.softRequestBudgetNotice`（:773），那说明的是文档不全，不是键不存在。真正不能用这条路径的理由在写入语义上：`Settings.set` 把值交给 `setByPath`，末段直接 `current[key] = value` 整体赋值，没有任何合并（源码 `config/settings.ts:662-679` 与 `:184-194`）。用户已有的 override 会被我们这 20 条静默顶掉。所以 `setup.mjs` 自己读—合并—写那份 YAML，写前留 `.bak`。

**第二，插件不能贡献上下文文件。** 贡献 `AGENTS.md` 的提供者是 `native`、`claude`、`codex`、`gemini`、`opencode`、`github`、`agents`、`agents-md`——`omp-plugins` 贡献技能、命令、规则、prompts 和 MCP 服务器，不含上下文文件（`omp://context-files.md:13,74`）。`SYSTEM.md`/`APPEND_SYSTEM.md` 也只在 `.omp`、`.claude`、`.codex`、`.gemini` 四个配置基目录里按项目先、用户后查找，不遍历祖先，更不看插件根（`omp://system-prompt-customization.md:23-30`）。所以框架入口只能是一个文件：`~/.omp/agent/AGENTS.md`，用户级作用域，除非禁掉 `native` 否则每个会话都加载（`omp://context-files.md:24`）。

这个入口只覆盖主会话，这一点必须先说清，因为它决定了规则文件该装什么。文档把上下文文件列进子会话的内置继承项（`omp://tools/task.md:172`），但实现比这句话窄一档：构造子会话时转发的是 `session.contextFiles` 里过滤掉文件名为 `agents.md` 的那部分（omp 18.1.10 源码 `task/structured-subagent.ts:456`；vibe 运行时同样过滤，`vibe/runtime.ts:1353`），而 `@` 导入在加载上下文文件时就已经展开进正文（源码 `system-prompt.ts:465-474`），被过滤掉的是整份展开后的内容。这条过滤在 `omp://` 全部文档里检索不到一次，只能从源码得到。结论必须写在这里：写进 `~/.omp/agent/AGENTS.md` 的东西，15 个专家一个也看不到。能到达它们的通道只有两条——规则（父会话把未过滤的规则列表整份转发，子会话用自己的 Agent 名重跑一次 `bucketRules`，源码 `structured-subagent.ts:461` 与 `sdk.ts:1669-1677`，文档侧 `omp://rulebook-matching-pipeline.md:261`）和技能。

粘性规则倒是能随包旅行，但文件名是个陷阱。顶层 `RULES.md` 只从 `~/.omp/agent/RULES.md` 和最近一个非空项目 `.omp/RULES.md` 读取，两者都被合成为规则名 `RULES` 并强制 `alwaysApply: true`；native 的追加顺序是项目规则 → 用户规则 → 用户粘性 → 项目粘性，按名去重先到先得，所以用户的粘性文件遮蔽项目的，而任何一个普通的 `rules/RULES.md` 能同时遮蔽两者（`omp://rulebook-matching-pipeline.md:86-88`）。我们因此把它叫 `rules/iflow-sticky.md`，不参与那场遮蔽竞赛。

装什么进去，由上一段那条边界决定，而不是由优先级标记决定。判据是「这条规则约束谁」：`@` 导入链只到主会话，规则文件到所有 Agent。约束执行方的搬进规则文件——`.omp/RULES.md` 的 10 条（1179 字节）、`.iflow/PRINCIPLES.md` 的工程原则（2633 字节），加上 `.iflow/RULES.md` 里的 Rule Priority System、Failure Investigation、Git Workflow、Safety Rules、Temporal Awareness、Implementation Completeness、Scope Discipline、Workspace Hygiene、File Organization、Professional Honesty 这 10 节（8619 字节），合计 12431 字节内容，加上 frontmatter、标题和前言共 12525 字节落盘为 `rules/iflow-sticky.md`，同时从原处删除。留在 `@` 导入链里的是 `.iflow/RULES.md` 剩下的 5806 字节：Workflow Rules、Planning Efficiency、Tool Optimization、Code Organization 和 Quick Reference 索引——讲怎么拆任务、怎么选工具、怎么并行，只有调度者用得上，发给专家只是噪音。按 🔴/🟡/🟢 切会切错人：🟡 里的 Implementation Completeness（"不留 TODO 桩"）和 Professional Honesty（"不编造指标"）正是专家最需要的，而 🔴 里的 Planning Efficiency 是纯调度内容。搬迁的字节账见 Compatibility 的注入成本一节。

还有一条容易踩的去重规则：always-apply 规则的内容会和生效的系统提示、以及已加载的上下文文件正文做一次去重，内容重复的那份被静默丢掉（`omp://rulebook-matching-pipeline.md:308`）。所以 `~/.omp/agent/AGENTS.md` 里绝不能再抄一遍 `rules/iflow-sticky.md` 的条目，否则规则会被丢弃。`setup.mjs` 写的就是一层薄壳，正文靠 `@` 导入指向已安装的插件根：

```markdown
# iflow — SuperClaude 全能工作流（omp 用户级入口）

框架事实源在 iflow-zh 插件包内，由 omp plugin install 安装、/sc:setup 写入本文件。

@~/.omp/plugins/node_modules/iflow-zh/framework/IFLOW.md
```

`@` 导入的相对路径按导入文件自己所在目录解析，`~/` 按用户主目录解析，递归最多五跳，环被跳过，目标缺失时原样保留 `@token`（`omp://context-files.md:160-167`）。这里有个坑必须避开：这一行不能硬编码。 npm 安装总是在用户插件数据根里跑 `bun install`（默认 `~/.omp/plugins`，`omp://plugin-manager-installer-plumbing.md:105`），但 Linux/macOS 上跑过 `omp config init-xdg` 并设好 XDG 变量后，新的用户插件状态解析到 `$XDG_DATA_HOME/omp/plugins`（:45）。所以 `setup.mjs` 必须先确定包的实际落地路径，再把它写进那一行。边界：这一层只省掉每台机器上的重复副本，不省注入 token——展开后进主会话上下文的是搬迁后剩下的 24639 字节，而且现在是每个会话都进。

最后一件事交给 `session_start`：extension 读一次生效设置，发现 `task.agentModelOverrides` 里没有那 20 个键、或者用户级 `AGENTS.md` 里没有那一行 `@` 导入，就 `ctx.ui.notify` 提示跑 `/sc:setup`。为什么不直接替用户写？因为那是两个跨所有项目生效的文件，静默改写用户全局配置违反「安全第一」。提示一次、写在用户按回车之后，是这条设计里唯一可接受的形状。

写入器的文件后缀不是随手选的。它有两个调用方：omp 里的 extension（Bun 加载，`.ts` 没问题）和 `npx` 起的 `bin/install.mjs`（用户自己的 Node，没有 TS 加载器）。所以共用的那个模块必须是 `.mjs`——Bun 和 Node 都能直接 import 一个 ESM JS 文件，而 `extension/iflow.ts` 用相对路径 `./setup.mjs` 引它，不需要构建步骤。它还要一个 YAML 依赖：Node 没有内置 YAML 解析，`~/.omp/agent/config.yml` 的读—合并—写必须靠 `yaml` 包，版本按精确号钉住。两条安装路径都会装上它——`omp plugin install` 在插件根跑 `bun install`（`omp://plugin-manager-installer-plumbing.md:105`），npx 走 npm 自己的依赖解析。

### 安装完成后主 Agent 只剩下调度这一件事可做

用户的要求是「主 Agent 永远不参与实际任务只负责任务调度，可随时与用户交互」。我们必须先说清一件事：**omp 里没有任何 API 能在程序层面强制模型去调用 `task`。** 没有 `pi.registerAgent(...)`，也没有任何钩子返回值能凭空插入一次工具调用——`tool_call` 的返回类型是 `{ block?, reason?, input? }`，第一个 `block` 短路，抛异常按失败关闭（照样阻塞），返回 `input` 只替换执行参数（`omp://hooks.md:113,141-143,200`）。所以调度者模式是策略 + 收窄 + 门禁的组合，不是路由器。四层从软到硬，另有一层可选的补充：

**第一层，指令层：`rules/iflow-dispatch.md` 用 `agents: main` 只约束主会话。**

```markdown
---
alwaysApply: true
agents: main
---

你是调度者。你自己不执行落地动作：`edit`、`write`、`bash`、`eval`、`ast_edit`
一律通过 `task` 分派给专家 Agent，一次 `tasks[]` 批量投递所有互相独立的切片。
你保留 `read`、`grep`、`glob`、`todo`、`ask`、`hub`，用于拆解、验收和回答用户。
```

frontmatter 里故意没有 `name`——规则名由文件名去掉扩展名得出，`buildRuleFromMarkdown` 解析的字段只有 `globs`、`alwaysApply`、`description`、`condition`、`astCondition`、`scope`、`agents`、`interruptMode`（`omp://rulebook-matching-pipeline.md:85,99`）。所以文件必须叫 `iflow-dispatch.md`，`rule://iflow-dispatch` 才读得到；写一个 `name:` 字段是无效的自我安慰。也没有 `description`——同时带 `alwaysApply` 和 `description` 的规则只进 always-apply 桶、不进 rulebook（:229），带上它除了让 `/extensions` 列表多一行说明没有别的作用。

`agents` 字段接受 YAML 序列、单字符串或逗号分隔串，按小写 glob 大小写不敏感匹配 Agent 定义名；字面量 `main` 匹配顶层会话，无定义名的子 Agent 落到 `sub`，两者都是保留名，`parseAgentFields` 拒绝自定义 Agent 占用（`omp://rulebook-matching-pipeline.md:257-258`）。过滤在会话创建时的 `bucketRules(...)` 里做一次，不匹配的规则不进任何桶、不编译进 TTSR、在那个会话里也不能通过 `rule://` 读到（:260）。所以这条规则对 15 个专家 Agent 完全不可见——它们该干活就干活。

**第二层，收窄层：`setActiveTools` 直接把落地工具从主会话的工具表里拿掉。** 这一层比阻塞干净——被拿掉的工具不出现在系统提示里，模型不会先想着用它再吃一个拒绝。`ExtensionAPI` 上有 `getActiveTools`、`getAllTools`、`setActiveTools`（`omp://extensions.md:121`），SDK 侧对应 `getAllToolNames()`/`setActiveToolsByName(names)`，并写明"System prompt is rebuilt to reflect active tool changes"（`omp://sdk.md:330-335`）。文档没给参数类型也没给作用域，三条决定性事实从 omp 18.1.10 源码读出：签名是 `setActiveTools(toolNames: string[]): Promise<void>`，裸字符串数组、没有选项对象（`extensibility/extensions/types.ts:1455-1456`）；它经 runner 转成 `session.setActiveToolsByName(...)`，只改调用方这一个会话的工具表，随后触发 `refreshBaseSystemPrompt`（`session/session-tools.ts:1289-1301`；主会话接线在 `modes/runtime-init.ts:101`）；子 Agent 不继承——每个会话新建自己的 `ExtensionRuntime`（`extensibility/extensions/loader.ts:465`），父会话的工厂在子会话里重新绑定一次（`sdk.ts:2172-2183`），子会话那份 `setActiveTools` 打到的是它自己的会话（`task/executor.ts:3579-3580`）。所以裁主会话波及不到专家，这一层可以当主力。

两个实现细节必须写进代码注释，否则会踩。第一，不在注册表里的名字被静默丢掉而不是报错（`session-tools.ts:1289` 的方法注释原话是"ignoring names absent from the registry"，归一化在 `tools/builtin-names.ts:52-62`），所以一个拼错的工具名的表现是工具集莫名变小，不是启动失败——保留集必须对着 `tools/builtin-names.ts:1-34` 的规范名写死，我们用 `read`、`grep`、`glob`、`task`、`todo`、`ask`、`hub`，七个全在表内。第二，`write` 的呈现另有一套逻辑：`#applyToolPresentation` 在 plan 模式下可能把它降级成 transport-only、不算进运行时选择集（`session-tools.ts:1357-1384`，判据在 `:1367-1373`），而 `setActiveToolsByName` 判断"要不要降级"看的是调用那一刻的活跃集（`:1298`）。所以我们只做"不含 `write` 的收窄"，还原走进入前的快照而不是重新拼一份名单。这条路径 omp 自己一直在走：goal 模式进出都用 `setActiveToolsByName`，退出时把进入前的名单原样传回（`modes/interactive-mode.ts:3432` 与 `:3081,3452`），plan 模式进入同样用它（`:3257`）；vibe 模式把导演会话裁到 `read` 加五个 vibe 工具（`omp://vibe-mode.md:15,17`）。一处差别要点明：plan 模式退出走的是 `restoreNonMCPToolPresentation`（`:3060,3351,3877`），那个入口能连 `xd://` 挂载分区一起精确写回，而 `ExtensionAPI` 上没有它——我们的还原精度因此比 plan 模式低一档，边界写在 Compatibility 的可逆性一节。

**第三层，兜底层：`tool_call` 阻塞收窄之外还能碰到的落地工具。** 收窄改的是工具契约，阻塞管的是契约之外的入口——MCP 工具、`xd://` 设备，以及用户在 `--config` 层自己加回来的工具：

```ts
const MUTATORS = new Set(["edit", "write", "bash", "eval", "ast_edit"]);

pi.on("tool_call", async (event, ctx) => {
  if (!MUTATORS.has(event.toolName)) return;
  if (isSubagentSession(pi)) return;  // 子 Agent 带 yield；enableDispatcher 同用这道闸
  if (!dispatchGateOn) return;         // /sc:dispatch off 的开关
  return {
    block: true,
    reason: `调度者模式：主会话不直接执行 ${event.toolName}。`
      + `请用 task 分派，建议 agent = ${suggestAgent(event)}。`
      + `临时关闭：/sc:dispatch off`,
  };
});
```

`isSubagentSession(pi)` 这道判据要单独解释，因为 `ctx.hasUI` 从来不是一个可靠的「是交互主会话」测试。omp 18.1.10 源码里，`task/executor.ts:3553` 调 `extensionRunner.initialize(actions, contextActions)` 只传两个参数，`uiContext` 是 `undefined`；`extensibility/extensions/runner.ts:651` 的 `mode` 回落到 `"print"` 默认，`:701` 与 `:881-883` 把 `hasUI` 算成 `#uiContext !== noOpUIContext`——结果是 `false`。而 `modes/print-mode.ts:122` → `modes/runtime-init.ts:152` 走的 print 路径同样不传 `uiContext`，于是 `hasUI === false`、`mode === "print"` 与一个 `task` 子 Agent 在这两维上逐位相同。也就是说 `hasUI` 过去能放行 `omp -p`，靠的不是它认出了 headless 主会话，而是它恰好不是子 Agent；它是个「不是子 Agent」的测试，附带也排掉了 headless 主会话。可靠的判别量是 `yield` 工具：`task/executor.ts:3351` 对每个子 Agent 硬编码 `requireYieldTool: true`（复活路径 `task/persisted-revive.ts:165` 同样如此），`tools/index.ts:498` 据 `session.requireYieldTool === true` 设 `includeYield`，`:678` 只在它为真时把 `["yield", HIDDEN_TOOLS.yield]` 加进注册表。`yield` 是隐藏工具，不在 `tools/builtin-names.ts:32` 的 `BUILTIN_TOOL_NAMES` 里，主会话拿不到它——`main.ts` 的 `buildSessionOptions` 从不设 `requireYieldTool`，`--tools yield` 也过不了 `main.ts:1979` 对注册表的校验。所以「活跃工具集里有 `yield`」等价于「这是子 Agent 会话」。再加一道防误报：`getAllTools()` 返回的 `ToolInfo` 带 `sourceInfo.source`（`types.ts:692-698`），它在 `session/session-tools.ts:533-548` 里按名字是否在本会话的内置注册表里算成 `"builtin"`，种子来自 `sdk.ts:2085` 的 `[...toolRegistry.keys()]`；一个被扩展注册的同名 `yield` 会报 `"extension"`，所以 `isSubagentSession(pi)` 同时要求 `pi.getActiveTools().includes("yield")` 且 `getAllTools()` 里那个 `yield` 的 `sourceInfo.source === "builtin"`，冒名注册就此被挡住。这一层和原有的 per-session-runner 保险不冲突、而是叠在它上面：钩子处理器只在注册它的那个 runner 里派发——`emitToolCall` 遍历的是 `this.extensions`，即本 runner 自己那份列表（omp 18.1.10 源码 `extensibility/extensions/runner.ts:1470-1511`），而每个会话新建自己的 runtime 与 runner（`loader.ts:465` 重建 `ExtensionRuntime`，`sdk.ts:2172` 重绑工厂）；进程级的只有文件写入/删除的回退注册表（`runner.ts:738,757`，文档侧 `omp://extensions.md:538-542`），`tool_call` 不在其列。带受限工具集启动的子 Agent 还连 extension 都不加载（`task/executor.ts:3358` 把 `preloadedExtensionPaths` 置空）。所以父会话注册的处理器根本到不了子 Agent 的 `edit`/`write`，死锁的形状不存在；`isSubagentSession` 是第二道闸，per-session-runner 仍是第一道。处理器拿到的 `ctx` 是每次调用现建的、不是安装时捕获的（`omp://extensions.md:534-535`），所以判据读的是当下会话的活跃工具集，不会被安装时的状态污染。

`ask` 工具的注册条件也是 `session.hasUI` 为真（`AskTool.createIf()`，headless 会话永远拿不到它，`omp://tools/ask.md:43`）。交互会话里这是对称的——只要主会话被收紧，它就一定还能问用户；反过来它答不了用户的场合，它也没被收紧。但 headless 主会话（`omp -p`、`omp --mode json`）被 `isSubagentSession` 判定为非子 Agent，门禁照样收紧，而 `ask` 不在其中——`enableDispatcher` 已经把 `DISPATCHER_TOOLS` 与当下的活跃工具集取过交集，`ask` 不在活跃集里就自然缺席。所以一个 `-p` 调度者不能问用户，`-p` 的提示必须自包含。

**第四层，分类层：修好 `routeTaskInput`，让它只产出真实存在的 Agent。** 现有 `classifyTask()`（`iflow.ts:90-96`）遍历 `TASK_ROUTES` 返回首个正则命中，兜底 `"task"`；`routeTaskInput()`（:98-123）处理 `tasks[]` 批量和扁平两种形状，只在 `agent` 缺失或空白时填充，没改动就返回 `undefined`。这个设计是对的，保留。要改的是数据：把 `librarian` 那条路由的 9 个模式（`iflow.ts:70-76`）合并进 `scout`（调研本就是只读工作，`scout` 是内置 Agent，一定存在，而且它自带 `read-summarize: false`，正适合读文档，`omp://task-agent-discovery.md:41`），删掉 `librarian` 和 `designer` 两个悬空名，给 `socratic-mentor` 补一条 `"@task"` 映射。

第五层是可选的收窄：Agent frontmatter 或会话级 `spawns` 策略。`session.getSessionSpawns()` 的语义是 `"*"`/`true`/`null`/缺省放开（省略 `agent` 默认 `task`），`""`/`false` 全禁，CSV 只放开列出的名字（省略 `agent` 时默认取列表第一个，`omp://task-agent-discovery.md:242-248`）。它限制能派给谁，不强制必须派，所以它是补充不是主力。

### 主 Agent 不干活，但一直在线

「随时与用户交互」在 omp 里是可满足的，机制要说清楚。

`async.enabled=true` 时，非阻塞 `task` 会为每个 item 在 `session.asyncJobManager` 注册一个 `type: "task"` 的任务，工具立刻返回，批量调用的返回文本形如 `Spawned N background agents using <agent types>`；实时进度继续流进同一个工具块，每份最终结果稍后作为 async-result 注入父会话，并附一句 `<id> is now idle — message it via hub to follow up`（`omp://tools/task.md:56-59`）。主会话因此不会被一个 20 分钟的重构占住。反面情形也要写明：`async.enabled=false`、会话没有 job manager、或者每个 item 的 Agent 都声明了 `blocking: true` 时，调用退化成同步结算响应（:61）——所以我们的 15 个 Agent 一个都不设 `blocking`（`blocking` 语义见 `omp://task-agent-discovery.md:44`；omp 内置 Agent 也都不设）。

用户主动问、调度者主动问，各有一条通道。调度者问用户用 `ask`：它 `concurrency = "exclusive"`，独占一个工具批次；`ask.timeout` 默认 `0` 即不超时，plan 模式下强制不超时；用户取消会抛 `ToolAbortError`（`omp://tools/ask.md:79,83,45,88`）。调度者和已经跑起来的 Agent 对话用 `hub`：它总是注册（`loadMode: "essential"`），消息操作只要求会话有 `AgentRegistry` 和调用方 agent id，而"能派子 Agent 或本身就是子 Agent"决定同伴名册要不要进系统提示（`omp://tools/hub.md:72-73`）；给已 park 的 Agent 发消息是唯一的复活手段，`task` 没有 `resume` 参数（:125）。反过来说，作业类操作依赖 `session.asyncJobManager`，异步关掉时 `hub wait`/`jobs` 只会回一句"Async execution is disabled"（:74）——这和上一段的 `blocking` 退化是同一个开关的两个面。

三条补充通道留给实现阶段按需启用，当前设计一条都不依赖：`context` 钩子按链式替换 `messages`（`omp://hooks.md:167`，冲突时逐个接前一个的输出，:202）、`before_agent_start` 注入一条 pre-agent 消息且只有首个返回值生效（:170,203）、`pi.sendMessage` 的 `deliverAs` 四档 `steer`（默认，打断当前运行）/`followUp`（排到本轮之后）/`nextTurn`（存下来在下一条用户提示时注入）/`aside`（在下一个 agent 步边界注入，不打断当前工具批次）（`omp://extensions.md:190-193`）。其中 `aside` 最贴合"调度者在专家干活期间插一句话"，但它属于优化项而非必需项。

headless 主会话的形状和交互会话不一样，得单独说。`session_start` 在第一条提示之前就触发（`modes/runtime-init.ts:157` 在 `modes/print-mode.ts:122` 里被 await，提示在 `:170-173`），所以收窄从第一轮起就生效。`-p` 的提示文本以 `/` 开头时照样派发斜杠命令（`session/agent-session.ts:5935-5955,6435-6461`），`omp -p "/sc:setup"` 确实跑那条命令。但 `ctx.ui.notify` 在 headless 下是 no-op（`extensibility/extensions/runner.ts:401-405,701` 的 `noOpUIContext.notify = () => {}`），`appendEntry` 也不发会话事件，所以扩展面向用户的输出一律走 stderr（`import { stderr } from "node:process"`），绝不碰 stdout——stdout 在 `--mode json` 下逐行写 JSON 记录（`modes/print-mode.ts:115-120,155-160`），在文本模式下写最终助手消息（:188-237），被扩展污染就破坏了机器可读性。

### 九个环节里，每一个都从"靠人记"换成"机制保证"

| 环节 | 现在 | 装上插件之后 |
| --- | --- | --- |
| 安装 | 克隆仓库 → 跑不存在的 `setup.py` → 手工拷 3 个目录 74 个文件 | `omp plugin install iflow-zh`，再在 omp 里跑一次 `/sc:setup` |
| 生效范围 | 拷过 `.iflow/` 的那几个项目 | 这台机器上每个目录起的每个会话 |
| 升级 | 每个项目重新拷一遍 | 重装即升级，没有 `update` 动作（`omp://plugin-manager-installer-plumbing.md:41`） |
| Agent 定义 | `.omp/agents/` 提交进每个项目仓库 | 包内 `agents/`，构建期从 `.iflow/agents/` 生成 |
| 悬空 Agent 名 | 运行时才炸：`Unknown agent "librarian"` | 构建期就炸：`build-agents.mjs` 退出码非零 |
| 上下文 417 KiB | 每个项目一份副本 | 一份在插件根，`~/.omp/agent/AGENTS.md` 一行 `@` 导入 |
| 执行方约束 | 只注入主会话，15 个专家一条也收不到 | 12525 字节走 `rules/iflow-sticky.md`，随 `task` 转发到每个专家 |
| 主会话行为 | 自己 `edit`/`write`，偶尔想起来派 `task` | 落地工具被收窄拿掉、门禁兜底，只能派 `task` |
| 长任务期间 | 主会话被占住 | 异步 `task` 立刻返回，`ask`/`hub` 全程可用 |

### 构建期校验把悬空 Agent 名从运行时错误变成构建失败

`scripts/build-agents.mjs` 由现有 `scripts/sync-omp-agents.mjs`（80 行）扩展而来，保留它的既有行为：只保留 `name`、`description`、`model` 三个 frontmatter 字段，`model` 仅在匹配 `/^@[A-Za-z0-9_-]+(?::(?:minimal|low|medium|high|xhigh|max))?$/` 时保留（`sync-omp-agents.mjs:53,66-68`），缺 `name` 或 `description` 直接抛错（:58-60），只给 `universal-omni-agent-v8` 加 `spawns: "*"`（:69），`description` 一律双引号包裹并转义 `\` 和 `"`（:64-65），递归收集但按 `path.basename` 平铺写出（omp 的 Agent 目录是平铺、`*.md`、字典序）。

新增的是一道断言，跑在写出之后：

```
校验集合 = templates/config.patch.yml 里 task.agentModelOverrides 的全部键
         ∪ extension/iflow.ts 里 TASK_ROUTES 的全部 agent 值
已知集合 = agents/ 下所有文件的 name
         ∪ {scout, reviewer, security-reviewer, task, sonic}   # omp 内置

校验集合 - 已知集合 ≠ ∅  →  构建失败，逐个列出孤名
agents/ 的 name - 校验集合 ≠ ∅  →  构建失败，列出缺角色映射的 Agent
```

第一条今天就会在 `librarian` 和 `designer` 上失败，第二条会在 `socratic-mentor` 上失败。这三个名字必须在包发布前修掉，构建脚本负责让它们修不掉就发不出去。

## Rationale / 理由与取舍

### 我们没有用 marketplace 的 npm 源，因为安装器明确拒绝它

最诱人的方案是写一份 `.omp-plugin/marketplace.json`，把 `{"source": "npm"}` 指向 `iflow-zh`，让用户 `omp plugin install iflow-zh@myshop`。这条路走不通：当前安装器解析这类条目但直接报 `npm plugin sources are not yet supported`，文档要求改用相对路径、GitHub、URL 或 git 子目录源（`omp://marketplace.md:209`）。npm 路径只能走 `omp plugin install <npm-spec>`（内部在 `~/.omp/plugins` 里跑 `bun install <spec>`）或 `omp plugin link <local-path>`。

### 我们没有让安装器把文件拷进项目，因为那等于放弃 omp 的全部发现机制

第二个朴素方案：安装器就是个复制器，把 `.iflow/`、`.omp/agents/`、`.omp/extensions/` 拷进当前项目，一行 omp 插件命令都不调。这样确实能跑——今天手工拷就是这么跑的。但它把 `omp-plugins` 提供者的规则发现、task 发现的插件 `agents/` 根、extension 加载器的 `omp.extensions` 全部作废，退回到"每个项目一份 409 KiB 副本"的老问题：升级要逐项目重放，版本号无处安放，而且和「全局生效」正相反——用户每开一个新项目都得再拷一遍。我们要的是分发单元，不是更快的复制粘贴。

### 我们没有用 vibe 模式当多角色引擎，因为它的档位硬绑内置 Agent

`/vibe` 看起来就是为这个场景造的：它把导演会话裁到 `read` + 可选的父级 `todo` + `vibe_spawn`/`vibe_send`/`vibe_wait`/`vibe_kill`/`vibe_list`，正是"只调度不干活"（`omp://vibe-mode.md:3,15`）。但它的档位只有两个——`fast` 走内置 `sonic`（默认 `@smol`），`good` 走内置 `task`（默认 `@task`）——而且档位总是选内置定义，同名的自定义 Agent 不会被选中（:30-33）。15 个专家一个都到不了。它还和 plan/goal 模式互斥（活跃和暂停的都算，:18）、拒绝 fork/move/handoff（:19）、退出时杀掉作用域内所有 worker（:17）。借它的形，不能用它的实。

### 我们没有用 `--config` 覆盖层带设置，因为它每次启动都要用户自己带上

既然插件贡献不了设置，一个变通是包里带一份 `config.yml`，让用户用 `omp --config <插件根>/config.yml` 引用它——不写用户全局配置，零侵入。它在两个地方站不住。第一，覆盖层是进程级的、永不持久化（`omp://settings.md:21`），用户每次启动 omp 都得带上那个参数，或者把 `PI_CONFIG_FILES` 设成机器级环境变量（:126,265）——后者和直接写 `~/.omp/agent/config.yml` 侵入性相当，却多一个用户看不见的环境变量。第二，覆盖层优先级排在项目设置之上（:101-104），它会把用户在项目 `.omp/config.yml` 里的模型选择顶掉，方向正好错了：iflow 的角色映射应该是可被项目覆盖的底座，不是压在最上面的天花板。顺带一条：覆盖层文件缺失、YAML 非法或顶层是数组/标量都是硬错误，不回落（:267），所以插件被卸载后用户的 omp 会直接起不来。

### 我们没有把插件规则文件命名为 `RULES.md`，因为它会撞进那场遮蔽竞赛

`rules/RULES.md` 会被合成为规则名 `RULES`，和 `~/.omp/agent/RULES.md`、`<project>/.omp/RULES.md` 争同一个名字，按名去重先到先得（`omp://rulebook-matching-pipeline.md:86-88`）。结果取决于用户有没有自己的粘性文件——有则我们的规则被吃掉，无则我们吃掉别人未来写的。两种结果都不该由文件名决定，所以我们叫 `iflow-sticky.md` 和 `iflow-dispatch.md`。

### 我们没有按 🔴/🟡/🟢 优先级切分那 14 KB 规则，因为优先级和收件人是两个正交的维度

本设计的前一版就是按优先级切的：把 `.iflow/RULES.md` 里标了 🔴 CRITICAL 的那几节搬进规则文件，🟡 和 🟢 留在 `@` 导入链里，理由是"最重要的那档值得规则桶的待遇"。这个切法在实现层面成立，在投递层面切错了人。`@` 导入链只到主会话，规则才到所有 Agent——所以这条切线决定的不是"多重要"，而是"谁能看到"。按优先级切的后果是：🟡 里的 Implementation Completeness（"No TODO Comments"）和 Professional Honesty（"No Fake Metrics"）留在链里，而它们约束的正是那 15 个写代码的专家；🔴 里的 Planning Efficiency 讲的是怎么做并行化分析和依赖映射，搬进规则文件后每个专家都收到一份用不上的调度指导。两处都是投递错误，而优先级标记本身没有任何办法暴露它。还有一层更机械的障碍：15 节里有 2 节根本没有 `**Priority**` 行——Rule Priority System 和 Quick Reference & Decision Trees，合计 2371 字节——优先级切法对它们无话可说，只能靠人裁量。按收件人切，这两节的归属反而是确定的：前者讲三档标记怎么排序、冲突怎么解，是执行方判断"这条和那条打架时听谁"的依据，进 `rules/iflow-sticky.md`；后者是给主会话看的决策树索引，留在链里。我们改按收件人切，`.iflow/RULES.md` 的优先级标记继续保留在正文里——它对读文档的人仍然有意义，只是不再充当分发依据。

### 我们没有把整条 `@` 导入链都搬进 `rules/`，因为那会给每个子会话强灌一份调度手册

既然规则能到所有 Agent 而上下文文件不能，最省事的做法是把 35422 字节全搬进 `rules/`，一劳永逸。代价算得出来：那 15 个专家每次被派出去都要多背 24639 字节的调度内容——`--brainstorm`/`--orchestrate` 之类旗帜的语义、Task Management 的记忆键 schema、Token Efficiency 的符号表、MCP 服务器旗帜——而专家不派任务、不管会话记忆、不需要压缩输出。更硬的一条是 always-apply 规则整段进系统提示、无法按需读取（`omp://rulebook-matching-pipeline.md:252`），子 Agent 没有任何办法把它跳过。反过来的极端也不选：把执行方约束留在 `@` 导入链里"等 omp 哪天改掉那个过滤"，那是把设计押在一个未文档化的实现细节会朝我们想要的方向变化上。按收件人切是唯一一个两头都不浪费的切法。

### 我们没有把 `.iflow/core/*.py` 打进包里，因为 omp 桥接路径从不执行 Python

`.iflow/core/` 有 99 KiB Python（`arq_reasoning_engine_v2.py` 37814 字节、`consciousness_stream.py` 28315、`multi_model_neural_adapter_v2.py` 35514），`.iflow/tests/system_comparison_framework.py` 另有 32 KiB 的对比框架。`extension/iflow.ts` 对它们零引用，整条 omp 桥接路径不起任何 Python 进程。打进包里就是 131 KiB 的惰性负重，还会让用户误以为存在一个需要 `python3` 的运行时依赖——README 里那句 `python3 setup.py install_v8_core` 正是这种误解的产物。它们留在仓库里作为设计文献，不进分发包。`.iflow/logs/`（3 个陈旧日志，26 KiB）和 `.iflow/backups/superclaude_backup_20251011_160531.tar.gz`（1834 字节）同理排除，理由更简单：日志和备份不是代码。四项合计 159 KiB，占 `.iflow/` 342 KiB 的将近一半。

### 我们没有用 `omp plugin link` 指向 npx 缓存目录，因为那个目录随时会被回收

`omp plugin link <local-path>` 只是在 `~/.omp/plugins/node_modules/<pkg.name>` 建符号链接，锁文件条目 `features: null`（`omp://plugin-manager-installer-plumbing.md:148-162`）。让 npx 进程 link 自己所在的 npm 缓存目录，能省掉一次下载，但那个目录归 npm 的缓存策略管，被清理后 omp 侧留下一个断链的符号链接，症状是"某天所有 `/sc:*` 命令突然消失"。我们让 `bin/install.mjs` 调 `omp plugin install iflow-zh@<自身版本>`，让 omp 在自己的插件根里持有一份实体。代价是同一个包被下载两次——npx 一次、`bun install` 一次，在 Compatibility 里如实记账。

### 我们没有用 `tools.approval.edit: deny` 关掉主会话的写权限，因为那会把 15 个专家一起锁死

这是最省事的想法，也是最危险的：设置里一句 `tools.approval: { edit: deny, write: deny, bash: deny }` 就能让主会话调不动落地工具，连 extension 都不用写。它错在作用域。子 Agent 以 headless + `tools.approvalMode: yolo` 运行，好让分层审批不卡住它们，但用户的 `tools.approval.<tool>` 设置对子 Agent 仍然有效——`deny` 直接封掉那个工具，`prompt` 在没有 UI 的子会话里无法满足、等于拒绝（`omp://approval-mode.md:154-156`）。也就是说这一句配置挡住的不是"主会话"，是"这台机器上所有会话"，15 个专家一个都写不了文件，整个模型当场死锁。`tool_call` 钩子拿得到 `ctx`、能按会话区分，设置层拿不到——这正是我们宁可多写一个处理器也不用一行配置的原因。

### 我们没有用 TTSR 条件规则纠正主 Agent 的越界行为，因为它一个会话只纠正一次

TTSR（Time Traveling Stream Rules）看起来很贴合：给规则加一个 `condition` 正则，流式输出一命中就打断并注入纠正。写起来更省——`condition` 里放一个形如文件 glob 的 token，解析器会自动把它铺成 `tool:edit(<glob>)` 和 `tool:write(<glob>)` 两条 scope 加一个兜底 `.*`（`omp://rulebook-matching-pipeline.md:301`），一行 TypeScript 都不用写。两个默认值杀死了这个方案。`repeatMode` 默认 `once`，同一条规则在一个会话里只触发一次（`omp://ttsr-injection-lifecycle.md:74`）——调度者模式要的是每次越界都被拦，不是第一次被提醒、后面随便写。`interruptMode` 默认 `always` 且 `contextMode` 默认 `discard`：命中即 `agent.abort()`，50 毫秒后重试，丢掉已生成的那半截助手输出，再注入一条 `<system-interrupt reason="rule_violation">`（:72-73,114-142）。代价是一整轮输出；`tool_call` 阻塞的代价只是一次被拒的工具调用，模型在同一轮里就能改用 `task`。更重、更少触发，两头都不占优。还有一层桶级约束顺带排除了折中方案：`bucketRules` 里 TTSR 注册排在 always-apply 之前，带 `condition` 的规则变成 TTSR-only（`omp://rulebook-matching-pipeline.md:219-220,228`），所以同一个文件不能既当粘性规则又当 TTSR 触发器。

## Compatibility / 兼容性

### 主会话不能再直接改文件，这是破坏性变更，所以它必须能关

装完之后，一个习惯了在主会话里直接 `edit` 的用户会撞上两道拦阻：工具清单里没有 `edit`，模型改用 MCP 的写入面时又被门禁拒。这是设计意图，但它必须可逆，而且两层要一起可逆。运行时出口是 `/sc:dispatch off`，它做两件事：把门禁开关置否，并用进入收窄前 `getActiveTools()` 的返回值调一次 `setActiveTools` 还原。启动期出口是 `--sc-dispatch off`：extension 工厂里 `pi.registerFlag("sc-dispatch", { type: "string", description: ... })` 把它注册成扩展旗标（`extensibility/extensions/loader.ts:222-230` 存进 `extension.flags` 并从 `default` 播种 `runtime.flagValues`，`:254-257` 的 `pi.getFlag(name)` 读它），`main.ts:1895-1904` 先加载扩展、聚合旗标，`cli/extension-flags.ts:36-43` 的 `applyExtensionFlags` 重解析 argv 把值写进 `extensionsResult.runtime.flagValues`，`cli/args.ts:187-205` 让扩展旗标盖住同名内置项（没有内置 `sc-dispatch`），同一份 `extensionsResult` 作为 `preloadedExtensions` 交给 `createAgentSession`（`main.ts:1975`）并在 print 与交互两条分支前就绪，所以 `session_start` 里 `pi.getFlag("sc-dispatch")` 读得到 CLI 值。这个旗标是启动期开关，只在 `session_start` 里读一次：值为 `off`（大小写不敏感、去空白后）时，`session_start` 不激活调度者，任何其他值或缺省则激活。`enableDispatcher()` 自己只判 `isSubagentSession(pi)`，不查旗标——这是有意为之。旗标压的是「这一个会话起头要不要激活」，不是一把需要重启才能解开的锁；用户随后在交互会话里敲 `/sc:dispatch on` 是一次显式动作，它越过启动期缺省、当场激活调度者，这正是设计要的可逆性。在 `-p` 里旗标是唯一的出口——没有运行时交互面可以敲 `/sc:dispatch off`，而一个被门禁拦下的 `{block:true}` 重试螺旋不是无限循环：`ToolCallBlockedError` 只喂回一条错误工具结果（`pi-agent-core/src/agent-loop.ts:2648-2650,2690-2696`），续不续跑取决于模型，但由会话的 run deadline 封顶，不是靠用户打断。还原的精度有个上限要写明：extension 侧只有 `setActiveTools(names)` 这一个入口，拿不到 omp 内部给回滚用的 `setActiveToolPresentation(toolNames, mountedToolNames)` 和 `restoreNonMCPToolPresentation(...)`（omp 18.1.10 源码 `session/session-tools.ts:1303-1350`），后两者才能把顶层与 `xd://` 的分区精确写回；`setActiveTools` 只能按调用时的实时挂载集重新分类（`:1290-1301`）。所以还原保真的前提是这期间 `xd://` 挂载集没有变过——对我们够用，因为收窄和还原之间只隔一条 `/sc:dispatch` 命令。另一处边角：`write` 是否被降级成 transport-only 由 `getActiveToolNames().includes("write")` 决定（`:1298`），还原时 `write` 尚未回到顶层，所以若此刻正开着 plan 模式，它会被继续按 transport-only 处理（`:1367-1373`）——那正好是 plan 模式该有的行为，不需要额外处理。开关状态用 `pi.appendEntry("com.iflow.dispatch.state", …)` 持久化，并在 `session_start`/`session_branch`/`session_tree` 时从 `ctx.sessionManager.getBranch()` 重建（`omp://extensions.md:604-605`）；工具集不持久化，它随每个会话的收窄重新施加。卸载则是 `omp plugin uninstall iflow-zh`，`~/.omp/agent/AGENTS.md` 和 `~/.omp/agent/config.yml` 留在原地由用户处置——`/sc:setup` 写过的文件，它自己不会删。

代价要正面记账：**每一次琐碎编辑现在都要付一次子 Agent 往返。** 改一个错别字，从"主会话一次 `edit`"变成"主会话一次 `task` + 子会话冷启动 + 子会话一次 `edit` + 结果注入"。延迟上升、token 上升，具体倍数取决于 `task.agentModelOverrides` 把它派给了哪个角色。`@smol` 的 `sonic` 便宜，`@slow` 的 `system-architect` 贵得多。这不是可以粉饰的取舍——这是用户明确要求的工作模式，我们如实标价，并且把 `/sc:dispatch off` 放在门禁的拒绝理由里，让用户在被拦的那一刻就看到出口。

### extension 和钩子的改动要重启会话，`/reload-plugins` 不够

`/reload-plugins` 刷新技能、斜杠命令和 MCP，新的工具、钩子或 extension 模块需要重启会话（`omp://marketplace.md:78`）。所以两条安装路径的最后一句都必须是"请退出并重新启动 omp"，而不是宣称即刻生效——`omp plugin install` 之后要重启才能看到 `/sc:*` 和 `/sc:setup`，`/sc:setup` 写完的用户级 `AGENTS.md` 也要下一个会话才注入。这条限制同样影响开发迭代：改 `extension/iflow.ts` 后必须重启，`?mtime` 缓存破坏器解决的是同进程重复 import 的陈旧问题（自 16.3.7 起沿依赖图传播，`omp://extension-loading.md:228`），不解决"处理器已经注册过了"。顺带一条硬约束：所有 `pi.on(...)`/`pi.registerCommand(...)` 必须在工厂函数调用期间完成注册，加载期调用动作方法会抛 `ExtensionRuntimeNotInitializedError`，而晚于工厂的首次注册永远不生效（`omp://extensions.md:63-65`，`omp://extension-loading.md:250-253`）。

### 设置层的数组是整体替换，而我们现在写的是用户全局配置

设置合并规则是：对象深合并，标量和数组整体替换（`omp://settings.md:134-135`）。`/sc:setup` 写的是 `~/.omp/agent/config.yml`——用户所有项目共用的那一份，出错的代价比写项目文件高一档。我们的应对是收缩写入面：只写 `modelRoles.default` 和 `task.agentModelOverrides` 两处，都是对象或对象内的标量，一个数组都不碰；`extensions:` 一行不写，包的 extension 走 `package.json#omp.extensions`，本来不需要设置项；`modelRoleStorage` 也不写——它的默认值本来就是 `global`（`omp://settings.md:362`），现有 `.omp/config.yml:3` 那行是冗余的，而显式重写一遍会在用户把它设成 `project` 时顶掉人家的选择。写前先读、读到已有键就深合并、原文件先复制成 `config.yml.bak` 再落盘。诚实补一句：YAML 注释在解析—序列化往返中会丢，用户自己配置里的注释是第一个受害者，`.bak` 是唯一的找回途径。

### 没有最低 omp 版本闸门，所以 API 漂移只会在加载时暴露

包里没有 `engines` 字段可用——插件安装路径不做 omp 版本校验，`manifest.version` 总是从 `package.json#version` 覆写，缺少 `omp`/`pi` 字段的包能装上但被运行时加载跳过（`omp://plugin-manager-installer-plumbing.md:93-98,178`）。omp 换了 `ExtensionAPI` 签名，症状是加载期报错——好在错误按路径捕获，其他 extension 继续加载，不会连锁崩掉会话。安装期还有一道安全网兼风险：`#validateInstalledExtensions` 会 import 每一个声明的 `extensions` 条目并在一个一次性注册面上初始化它，失败则整个安装回滚（恢复先前的 `plugins/package.json`、`bun.lock` 和包快照）并中止（:112,121）。一个语法错误的 `iflow.ts` 因此不会留下半装状态——但也意味着发布前必须本地跑通这一步。

### 我们占用 `~/.omp/agent/AGENTS.md`，就遮蔽了用户已有的每一个用户级上下文文件

这是全局生效最贵的一笔账。发现完成后按作用域去重时，跨所有提供者只留一个用户级上下文文件，而 `native` 优先级最高，所以 `~/.omp/agent/AGENTS.md` 遮蔽其余全部（`omp://context-files.md:100`）。一个在 `~/.claude/CLAUDE.md` 里攒了多年个人偏好的用户，装完 iflow 会发现那份文件不再注入——没有报错，只是不见了。受影响的候选包括 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.gemini/GEMINI.md`、`~/.config/opencode/AGENTS.md`、`~/.copilot/copilot-instructions.md` 以及 `~/.agent`/`~/.agents` 下的文件（:274）。项目级文件不受影响：它们按目录深度各留一份，且全部排在用户文件之前注入（:104-106）。

应对分两层。`/sc:setup` 在写之前先探这些路径，发现哪个存在就在薄壳开头补一行 `@` 导入指回它——`@` 导入认 `~/` 前缀（:160-167），所以被遮蔽的那份内容照样进上下文，而且是引用而非拷贝，用户后续改它仍然生效。用户不想要 iflow 这个入口，`disabledExtensions: ["context-file:user:AGENTS.md"]` 能精确关掉，而且关掉不等于让作用域空着：被禁用的文件在去重之前就被丢弃、不占作用域，原先被它遮蔽的那份顶上来（:245）。代价有两个：这个 id 按层级加文件名匹配，会连带禁掉任何提供者贡献的用户级 `AGENTS.md`（:241,243）；它不接受路径作用域，并且和所有设置数组一样整体替换（:252），所以写的时候必须带上用户已有的全部条目。

### 包是一台机器一份，所以所有项目共用一个版本

npm 包的安装位置不由我们选：`omp plugin install <npm-spec>` 总是在用户插件数据根里跑 `bun install`（`omp://plugin-manager-installer-plumbing.md:105`），`--scope user|project` 是 marketplace 子命令的参数（`omp://marketplace.md:69-73`），项目级插件根 `<anchor>/.omp/plugins/` 由 marketplace 的项目安装填充，启用的项目级包遮蔽同名用户级包（`omp://plugin-manager-installer-plumbing.md:54`）。一台机器一份正是「全局生效」要的形状，代价是没有按项目钉版本的办法——让项目 A 停在旧版这件事做不到。想按项目整体关掉，用 `<project>/.omp/plugin-overrides.json` 的禁用列表（:56，无效 JSON 回落 `{}`，:270）。

路径本身也不是常量，`setup.mjs` 不能硬编码。用户插件根默认 `~/.omp/plugins`，但 Linux/macOS 上跑过 `omp config init-xdg` 并设好 XDG 变量后，新的用户插件状态解析到 `$XDG_DATA_HOME/omp/plugins`（:45）；agent 目录同样会被 `--profile`/`OMP_PROFILE`/`PI_PROFILE` 挪到 `~/.omp/profiles/<name>/agent`，也认 `PI_CODING_AGENT_DIR`（`omp://context-files.md:34`）。所以 `/sc:setup` 必须先解析出这两个目录的实际位置，写完再把原路径打印出来——用户排查「为什么没生效」时，第一个要看的就是这两行。

### 全局注入把 38058 字节推给了每个会话，而它推给了错的那个 Agent

项目级安装时只有拷过 `.iflow/` 的那几个项目付注入成本，现在是这台机器上每个目录起的每个会话都付。这笔账在上一节末尾提过一句，这里说清它的三个具体问题，因为放大到全局之后它们从"能忍"变成"必须处理"。

第一个问题是 `.iflow/FLAGS.md:27-59` 那 33 行。它文档了 8 个 MCP 旗帜，点名 Context7、Sequential、Magic、Morphllm、Serena、Playwright 六个服务器，还有 `--all-mcp`/`--no-mcp` 两个总开关。本仓库不带 `.mcp.json`（对 `.mcp.json`、`.omp/.mcp.json`、`.omp/*.json`、`.iflow/*.json` 逐个 glob，零命中），插件包也不会带——`omp-plugins` 确实会扫描插件根的 `.mcp.json`（`omp://plugin-manager-installer-plumbing.md:202`），但那六个服务器要用户自己的 API key 和本地进程，替用户配一份只会在启动时报连不上。于是模型每个会话都读到六个它调不动的服务器的启用说明。处理办法是改事实源而不是改生成物：在 `.iflow/FLAGS.md` 的 `## MCP Server Flags` 标题下补一行，写明这些旗帜要求用户自备 `.mcp.json`、omp 不预置任何一个。一行，随 `framework/` 自动进包。

第二个问题是分层错位，而且错位的维度不是优先级而是收件人。`.iflow/RULES.md` 的 14425 字节按 `**Priority**` 行切开是 🔴 CRITICAL 4281、🟡 IMPORTANT 5704、🟢 RECOMMENDED 1970，另有 2371 字节的两节没有优先级行，剩下 100 是文件标题（逐节累加比文件大小多 1 字节，差在分节换行的归属）；但这些全部走 `@` 导入链，而 `@` 导入链只到主会话（Design「插件发现不了的只剩两样东西」里那条 `contextFiles` 过滤）。也就是说 Implementation Completeness 的"不留 TODO 桩"、Professional Honesty 的"不编造指标"、Failure Investigation 的"不禁用测试来让结果通过"——三条全是写给执行方的——今天一条都到不了那 15 个专家，而它们是唯一真正写代码的角色。规则桶的待遇完全不同：always-apply 规则整段注入系统提示、可用 `rule://<name>` 按名重读（`omp://rulebook-matching-pipeline.md:252-253`），并且父会话把未过滤的规则列表整份转发给子会话（:261）。所以搬迁按收件人切：约束执行方的 10 节（8619 字节）连同 `.iflow/PRINCIPLES.md`（2633）和 `.omp/RULES.md` 的 10 条（1179）进 `rules/iflow-sticky.md`，合计 12431 字节内容、12525 字节落盘；`.iflow/RULES.md` 剩下的 5806 字节留在链里，那是纯调度内容。

第三个问题是搬完之后的字节账，必须诚实记一次。主会话总量从 36601 涨到 38058：`@` 导入链从 35422 降到 24639，粘性规则从 1179 升到 12525，加上同为主会话可见的 `iflow-dispatch.md` 894 字节，合计 38058——涨了 1457 字节，这次搬迁买到的是投递正确性，不是省字节。链比旧账的 24170 多 469 字节，因为 `FLAGS.md` 补了 MCP `.mcp.json` 自备说明（见上一段），`IFLOW.md` 补了记录执行方规则已迁出的注释；粘性文件比搬入的 12431 字节内容多 94 字节，是它自己的 frontmatter、标题和一行前言。专家侧从 1179 涨到 12525，每个 `task` 子会话都涨这 11346 字节；换来的是它们第一次真正收到"不留 TODO 桩"这类硬约束。搬迁必须从原处删除、不能留两份：always-apply 规则的内容会和已加载的上下文文件正文按段落比对去重，重复的那份被静默丢掉（:308；实现是分块后的连续子序列比对，围栏代码块内的示例不算命中，源码 `system-prompt.ts:118-141`），留两份等于赌哪一份活下来。

### 两条安装路径，一次多余的下载，这是「一键」的实际成本

`omp plugin install iflow-zh` 只下载一次，但它写不了那两个用户级文件，所以还要在 omp 里跑一次 `/sc:setup`——两步。想真正压到一条命令，`npx iflow-zh` 会先把包下到 npm 缓存以运行 `bin/install.mjs`，那个进程再调 `omp plugin install`，`bun install` 又下一份：同一个包传两遍。可以用 `omp plugin link` 指向 npx 缓存目录省掉这一次，但那样就把 omp 的插件根挂在 npm 缓存的生命周期上（见 Rationale）。两条路我们都留：想省下载走 `omp plugin install` 加 `/sc:setup`，想省步骤走 `npx iflow-zh`。

## Implementation / 实现与过渡

### 分四步落地，每步都有可验证的产出

**第一步，从仓库长出包骨架。** 新建包目录，`scripts/build-agents.mjs` 从 `.iflow/agents/` 生成 `agents/`、从 `.iflow/` 拷出 `framework/`。这一步的验收标准是构建失败：`librarian`、`designer` 触发孤名断言，`socratic-mentor` 触发缺映射断言，脚本退出码非零。修掉这三个名字（`librarian` 路由并入 `scout`，`designer` 删除，`socratic-mentor` 补 `"@task"`）后构建通过，`agents/` 下出现 15 个平铺 `*.md`。同一步做三件改事实源的事：`findFrameworkRoot()` 换成 `import.meta.url` 解析，否则下一步一定拿到 0 个命令；按收件人把那 12431 字节内容（连 frontmatter 落盘 12525 字节）搬进 `rules/iflow-sticky.md` 并从 `.iflow/RULES.md`、`.iflow/PRINCIPLES.md`、`.omp/RULES.md` 原处删除（清单见 Design「插件发现不了的只剩两样东西」）；`.iflow/FLAGS.md` 的 MCP 段补一行自备 `.mcp.json` 的说明。搬完后自查一遍去重风险：把 `rules/iflow-sticky.md` 按空行分块，逐块在 `@` 导入链展开后的正文里找连续匹配，命中数必须为 0。

**第二步，本地 link 验证发现链路，而且必须在包目录之外验证。** `omp plugin link <包路径>`，重启 omp，然后切到一个和本仓库毫无关系的空目录起会话——那才是「全局生效」的验收现场。逐项确认：`/sc` 列出 21 个命令；`task` 的 Agent 清单里出现那 15 个名字；`/extensions` 里 `iflow-sticky` 显示为 always、`iflow-dispatch` 在主会话可见而在一个 `scout` 子 Agent 里不可见（在子 Agent 内读 `rule://iflow-dispatch` 应报未知规则，因为不匹配的规则不进任何桶，`omp://rulebook-matching-pipeline.md:260`）。这一步同时验收收窄层的两端：主会话里 `edit`/`write`/`bash`/`eval`/`ast_edit` 五个名字应当从工具清单里消失，而派出去的专家仍然拿得到 `edit` 和 `write`——派一个 `sonic` 写一个临时文件，写成功即证明未被继承（源码层面已确认，见 Design 的收窄层一节）。同时确认 `rule://iflow-sticky` 在那个子 Agent 里读得到，那是执行方约束的到达凭证。

**第三步，打包后按真实安装路径验证。** `npm pack`，然后 `omp plugin install ./iflow-zh-<version>.tgz`。这条路径会触发 `#validateInstalledExtensions`，是发布前唯一能验证「安装期 import 不炸」的手段。装完重启，先跑 `/sc:setup`：确认它把两个文件写到解析出来的真实路径、生成了 `.bak`、并且探到机器上已有的用户级上下文文件并补上 `@` 导入。再做两个功能验收：说一句「帮我调研 omp 的插件机制」，确认 `routeTaskInput` 把它分类到 `scout` 而不是报 `Unknown agent`；在主会话直接要求改一个文件，确认门禁返回带 `/sc:dispatch off` 出口的拒绝理由，然后 `/sc:dispatch off` 再试一次确认放行。

**第四步，发布并把 README 换掉。** `npm publish`（`npm view iflow-zh` 当前返回 HTTP 404，名字未被占用）。同步删除 `README.md:60-67` 那段不存在的 `setup.py` 说明和 `README.md:104` 的手工拷贝注释，换成两行：`omp plugin install iflow-zh` 加 `/sc:setup`，以及等价的一条 `npx iflow-zh`。这一步是必须的——留着旧说明，用户还会去跑那条命令。

### 用构建期断言而不是"我们会注意"来保证一致性

Background 里那两个悬空 Agent 名说明一件事：配置和代码引用同一个名字的一致性，靠人记必然失守。`build-agents.mjs` 的双向断言把这件事变成 CI 门槛——包发不出去，比运行时报错早三个环节。第二条断言（`agents/` 有而配置没有）今天就能抓到 `socratic-mentor` 那种"有 Agent 无角色映射，静默继承父模型"的问题，这类问题不报错、只是悄悄变贵，人工审查最容易漏。

### 老项目不需要迁移，因为生效不再取决于项目里有什么

装完就是全机器生效，已经手工拷过 `.iflow/` 的项目不必动。两者叠在一起时优先级是确定的：项目 `.omp/agents/` 排在发现链第一位（只认最近一个 `.omp` 命中），插件根排第三，按 `name` 区分大小写、首次命中胜出（`omp://task-agent-discovery.md:132-142,148`）。本仓库不再是特例：收尾时 `.omp/agents/` 已删，`.omp/` 现在只剩 `AGENTS.md` 与 `config.yml`，所以这台机器上起的每个 omp 会话——包括本仓库自己——都用安装好的那份插件副本，和别的项目走同一条路径。想彻底切换的项目，删掉本地 `.iflow/`、`.omp/agents/`、`.omp/extensions/`、`.omp/AGENTS.md` 和 `.omp/RULES.md`，插件版本会顶上来；不想被插件影响的项目，`<project>/.omp/plugin-overrides.json` 一把关掉。

## Appendix / 附录

### 六条决定了整个设计形状的能力边界

| 想做的事 | omp 插件能不能做 | 依据 | 我们的对策 |
| --- | --- | --- | --- |
| 让 Agent、规则、命令跨项目生效 | 能，且与 cwd 无关 | `omp://plugin-manager-installer-plumbing.md:168-179`；`omp://task-agent-discovery.md:136-140` | 不写任何项目级文件 |
| 随包带 `modelRoles` / `task.agentModelOverrides` | 不能 | `omp://plugin-manager-installer-plumbing.md:202`；`omp://settings.md:16-22` | `/sc:setup` 合并写入 `~/.omp/agent/config.yml` |
| 随包带 `AGENTS.md` 上下文入口 | 不能 | `omp://context-files.md:13,74` | `/sc:setup` 写一行 `@` 导入薄壳到 `~/.omp/agent/AGENTS.md` |
| 随包带顶层粘性 `RULES.md` | 能带 `rules/*.md`，但不能占用名字 `RULES` | `omp://rulebook-matching-pipeline.md:61,86-88` | 改名 `iflow-sticky.md` / `iflow-dispatch.md` |
| 在程序层面强制模型调用 `task` | 不能 | `omp://hooks.md:113,141-143,200` | 指令 + 收窄 + 门禁 + 分类，四层叠加 |
| 让 `~/.omp/agent/AGENTS.md` 的内容到达子 Agent | 不能，构造子会话时按文件名过滤掉 | 源码 `task/structured-subagent.ts:456`（`omp://` 无对应文档） | 约束执行方的条目改走 `rules/iflow-sticky.md` |

### 五个大概率会被问到的问题，先在这里答掉

**为什么包名叫 `iflow-zh`？** 用户指定的。`npm view iflow-zh` 当前 HTTP 404，名字未被占用。

**为什么不干脆做成 omp 的内置模式？** 那需要改 omp 本体。插件机制已经够用：Agent、规则、命令、extension 四类内容都能贡献，而且装在用户插件根就是全局生效；缺的只有设置和上下文文件两样，一次 `/sc:setup` 就能补上。

**门禁挡住 `bash`，那 `git status` 怎么办？** 挡掉了。调度者要看仓库状态，用 `read`（目录路径直接列条目）和 `grep`；要跑命令，派一个 Agent。这是"主 Agent 永远不参与实际任务"的直接后果，也是 `/sc:dispatch off` 存在的原因。

**15 个专家会不会互相踩同一个文件？** 会，`task` 不保证同文件编辑能合并。批量投递时把独立所有权切开、在批次 `context` 里预先定死跨切片契约、指定一个集成负责人串行化真正共享的写入边界——这是调度者的工作，也是它唯一的工作。

**既然收窄层已经把工具拿掉了，为什么还要留 `tool_call` 门禁？** 因为收窄只作用于工具注册表里的名字。MCP 服务器带进来的工具、`xd://` 设备下的写入面、用户自己在 `--config` 覆盖层加回来的工具，都不在那七个保留名的裁剪范围里。两层的失效方向也不同：收窄失效的表现是工具集莫名变小（拼错的名字被静默丢掉），门禁失效的表现是放行。留着门禁的成本是几行代码，去掉它的成本是一条静默的绕行路径。

### 一个还没定的问题，以及它的收敛办法

`.iflow/CHANGELOG-V8.md`（9755 字节）进不进包。它是仓库叙事而非运行时内容，`extension/iflow.ts` 不读它，进包只增加下载体积，倾向排除；但排除之后用户在插件根看不到版本历史。收敛办法不必等评审：`package.json#version` 是版本的唯一事实源（安装时总被它覆写，`omp://plugin-manager-installer-plumbing.md:93-98`），变更历史挂在 npm 页面的 README 里就够，包内不留第二份。哪种选择都不影响本设计的任何机制，所以它是发布前的最后一个小决定，不是前置条件。


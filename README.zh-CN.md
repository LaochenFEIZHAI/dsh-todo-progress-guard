# dsh-todo-progress-guard

[English](README.md) | 中文

[![CI](https://github.com/LaochenFEIZHAI/dsh-todo-progress-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/LaochenFEIZHAI/dsh-todo-progress-guard/actions/workflows/ci.yml)

给 DeepSeek Harness（DSH）的任务清单补上「自动推进」：在多步工具调用过程中提醒模型更新
`todo_write`，并在正常结束一轮对话时把遗留任务收尾为已完成。

---

## 它解决什么问题

DSH 自带的 `todo_write` 是**整表替换**的规划工具，任务清单只是一份会话投影：

```js
// @deepseek-ai/dsh-tool-todo
apply: (state, event) => {
  if (event.type === "todo/write") return event.data.todos;
  if (event.type === "turn/start") return null;
  return state;
}
```

也就是说，**只有模型再次调用 `todo_write`，面板才会变化**。于是长链路任务里常见两种症状：

1. **中途不更新**：模型开局写一次清单，随后连续跑几十个 `bash` / `read` / `edit`，
   注意力被工具结果占满，再也不回头更新进度，面板一直停在第一项 `in_progress`。
2. **结束时停在第一个**：模型做完全部工作后直接输出最终答复（这一步不再产生工具调用），
   自然也没有机会补最后一次 `todo_write`，于是对话已经结束，任务面板还挂着
   `1 进行中 · N 待处理`。

本插件用一个 Host 侧 Cordis 插件同时补上这两个缺口，**不改动 DSH 核心包，也不写新的事件类型**。

## 两种机制

### 1. 过程提醒（`tools/post-execute`）

当当前轮次已经有一份**未完成**的任务清单，而模型连续若干步/若干次工具调用都没调用
`todo_write` 时，插件会在该步骤**最后一个工具结果之后**注入一条
`user/message` 形式的上下文提醒（`source.kind = "todo-progress-reminder"`，
`form: "notice"`，在聊天流里渲染成一条可折叠的注入提示）。

提醒正文会把当前清单**逐条原文列出**，因为 `todo_write` 要求整表重发——这样模型无需翻找
几十步之前的历史就能直接复制更新：

```text
Task progress reminder (1/3 completed; 2 step(s) / 4 tool call(s) since the last todo_write):
1. [completed] Recon the repository
2. [in_progress] Implement the fix
3. [pending] Run the test suite
If any task above is now completed or in progress, call `todo_write` with the COMPLETE
updated list in your next step. It can run in parallel alongside your next tool call at no
extra step cost, or mark every finished task `completed` before your final reply.
```

### 2. 轮次结束收尾（`agent/turn-stopping`）

一轮对话**正常结束**的那一刻（`turn/end` 写入之前、轮次仍处于合法开放状态），如果清单里
还残留 `in_progress` / `pending`，插件会追加一条最终的 `todo/write` 快照，把它们统一收尾为
`completed`。这样面板状态永远不会比它描述的工作活得更久。

## 安装

**推荐走 Web 界面**：打开 **插件 → 安装**，粘贴下面任意一个 spec。
它会同时完成「装依赖」和「启用该 bundle」，patch 立即生效，不用重启：

```text
github:LaochenFEIZHAI/dsh-todo-progress-guard   # 直接从 GitHub（本仓库）
/absolute/path/to/dsh-todo-progress-guard        # 本机目录，开发时改动即时生效
dsh-todo-progress-guard                          # 发布到 npm 之后
```

**命令行只负责装包**（`dsh plugin` 是 pnpm 的透传，不做 bundle 选择）：

```bash
dsh plugin --profile web add github:LaochenFEIZHAI/dsh-todo-progress-guard
```

装完后还要在「插件」页把 `dsh-todo-progress-guard` 启用一次（等价于把它加进
`~/.dsh/profiles/<name>/package.json` 的 `dsh.profile.bundles`），bundle 的
`cordis.patch.yml` 才会被应用。

## 配置

默认值即可直接使用；需要调整时，在 profile 的 `cordis.patch.yml` 里按 id 覆盖这一行的
`config`（patch 层会整份替换 `config`，所以要把三个键都写上）：

```yaml
- id: todo-progress-guard
  config:
    stepThreshold: 2
    callThreshold: 5
    autoCompleteOnTurnEnd: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `stepThreshold` | `2` | 距离上次 `todo_write` 经过多少个模型步骤后提醒 |
| `callThreshold` | `5` | 距离上次 `todo_write` 累计多少次其他工具调用后提醒（需至少跨过 1 步） |
| `autoCompleteOnTurnEnd` | `true` | 轮次正常结束时是否把遗留任务收尾为 `completed` |

两个阈值是「或」关系：先到先提醒。同一步骤内最多提醒一次；每轮次开始时计数清零。
非法值（非正整数、非布尔）会被忽略并回退到默认值，插件不会因此加载失败。

## 安全边界

收尾只在一轮**确实做完事**时发生。以下任一情况插件都不写任何东西：

- 当前轮次已被用户中断（`signal.aborted`），或最后一次助手消息被打断；
- 还有排队中的下一步（`agent.inbox.nextStep` 非空）——那说明轮次没结束；
- 本步骤调用过 `ask_user_question` 或 `exit_plan_mode`（正在等人类回答，不能替用户判定完成）；
- 清单已全部 `completed`（无事可做）；
- 清单是刚建好、还没执行过任何其他工具的「纯计划」（这是意图，不是成果）。

插件只**追加** `todo/write` 事件，不改写历史；写入始终发生在合法的开放轮次内，因此与
`@deepseek-ai/dsh-tool-todo` 自带的持久日志不变式兼容。

## 兼容性

- 需要 Host 暴露 `sessions` 与 `sessionProjections` 服务；缺失时插件不激活（`inject` 语义），
  不会影响其他插件。
- 已在 DSH `0.2.0-rc.2` 上验证；依赖的扩展点（`tools/post-execute` 的 `additionalContexts`、
  `agent/turn-stopping`、`todos` 投影）均属于该版本的公开契约。
- **零运行时依赖**：插件不 import 任何 DSH 包，因此 `link:` 本地目录安装和 registry 安装行为
  完全一致（若导出 Schemastery `Config`，`link:` 安装会因真实路径解析不到 DSH 包而加载失败，
  所以配置改为插件内部校验）。

## 开发

```bash
npm test        # node --test，13 个用例覆盖提醒/收尾/边界
```

测试用一套最小的 Host 替身（会话事件日志 + `todos` 投影 + 工具 waterfall）驱动真实插件代码，
不使用任何 DSH 内部模块。

## 许可

[MIT](LICENSE)

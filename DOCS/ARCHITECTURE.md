# DSH Workspace Memory 架构

## 1. 定位

`dsh-workspace-memory` 为 DeepSeek Harness 提供可持久化、按项目隔离的长期记忆。
它同时服务普通 Session、后台 Agent 和可选的 `dsh-voco` 语音 Agent；这些调用方
只依赖 `WorkspaceMemory` 接口，不共享存储实现细节。

目标是让 Agent 在后续任务中记住稳定的项目事实、决策、约定和用户偏好，同时保持
记忆可浏览、可审计、可删除。当前版本不引入向量数据库、Embedding 或 BM25。

## 2. Scope 模型

记忆分为三类目录：

- `global/`：跨项目的用户偏好和通用工作方式。所有项目 Session 都可以读取。
- `scopes/ws-<hash>/`：由规范化绝对 `cwd` 得到的项目 scope。项目 Session 会同时
  读取全局记忆和本项目记忆。
- `archived/ws-<hash>/`：工作区注册记录删除后暂存的项目记忆。它不参与正常召回，
  但可在设置的“回收区”查看，直到用户确认永久删除。

同一个规范化 `cwd` 始终映射到同一个 scope；缺少 `cwd` 时使用全局 scope。存储根目录
默认为 `$DSH_HOME/workspace-memory`，未设置时使用 `~/.dsh/workspace-memory`。

## 3. 文件布局

```text
workspace-memory/
├── global/
│   ├── memory_summary.md
│   ├── memory_entries.json
│   ├── state.json
│   ├── checkpoints/
│   └── summary_history/
├── scopes/
│   └── ws-<sha256-prefix>/
│       ├── scope.json
│       ├── memory_summary.md
│       ├── memory_entries.json
│       ├── state.json
│       ├── checkpoints/
│       └── summary_history/
└── archived/
    └── ws-<sha256-prefix>/
        ├── scope.json
        ├── memory_summary.md
        ├── memory_entries.json
        ├── state.json
        ├── checkpoints/
        └── summary_history/
```

`memory_entries.json` 是结构化事实的来源；`memory_summary.md` 是受大小限制的注入
摘要；`state.json` 保存 checkpoint 缓冲和计数；`checkpoints/` 与 `summary_history/`
用于故障排查和变更审计。所有写入经过 scope 级串行队列，并使用临时文件原子替换。

## 4. 公共接口

```ts
interface WorkspaceMemory {
  recall(input: RecallInput): Promise<MemoryContext>
  checkpoint(input: CheckpointInput): Promise<CheckpointResult>
}
```

此外，运行时提供 `remember`、`forget` 和 `search` 能力供显式记忆工具使用。调用方
不能直接操作 JSON 文件；这样可以统一处理去重、敏感信息过滤和并发写入。

## 5. 数据流

### Agent

1. `systemPrompt.context` 注入当前 scope 的稳定摘要。
2. Agent 第一个 step 根据用户消息调用 `recall`，追加相关条目。
3. Agent turn 结束时把完整消息交给 checkpoint 缓冲区，响应不会被蒸馏过程阻塞。
4. 达到阶段条件后，蒸馏器提取长期有效事实并更新结构化条目。

### 普通 Session 与后台 Agent

两者均从 Session 的 `cwd` 解析项目 scope。后台 Agent 继承来源 `cwd`，因此无需单独
的记忆目录，也不会把不同项目的事实混在一起。

### dsh-voco

语音前台在路由前可调用同一个 `workspaceMemory.recall`，将结果作为带边界的参考材料
提供给路由器；完成的语音 utterance 进入同一 checkpoint 策略，Session 关闭时强制评估
最后一阶段。服务不存在或调用失败时，voco 保持原有行为。

## 6. 阶段性 checkpoint

“阶段性”按工作阶段和缓冲阈值判断，而不是按固定小时执行。以下任一条件满足即可
触发整理：

- 后台 Agent 的任务完成；
- 缓冲达到默认 10 个已完成用户轮次；
- 缓冲文本达到默认 4000 字符；
- 默认空闲 5 分钟；
- Session 关闭，或调用方显式强制 checkpoint。

每轮只追加到缓冲区，不强制调用模型。成功整理 5 次后重建摘要，并保留有限版本历史。
蒸馏器只接受偏好、项目事实、决策、约定、修复和明确要求记住的内容；问候、临时指令、
进度闲聊和未经确认的推测会被丢弃。相似事实更新原条目而不是重复创建。

## 7. 检索策略

检索使用结构化词法排序：精确短语和规范化子串优先，其次是标题、检索词、标签、ASCII
token、中文字符 bigram，再综合内容匹配、重要性、新近度和短期已展示惩罚。结果同时受条目
数量和 UTF-8 字节数限制。

这种策略不依赖 BM25、Embedding 或向量数据库，便于离线运行、审计和控制安装体积；
Agent 仍可通过 `memory_search` 进行第二次查询。

## 8. 设置与生命周期

Web 设置的“记忆”页面从全局 scope 列表中选择任意项目，而不是绑定当前打开的会话。
活动记忆和回收区分为两个视图：活动视图显示全局及现存项目；回收区显示已归档项目的
摘要、结构化条目和整理计数。删除项目时只移动其 scope 目录，便于误删后的人工保留；
“永久删除”需确认，并物理删除归档目录及其 checkpoint、摘要历史，操作不可恢复。

前端只能通过 Host 的只读读取路由访问脱敏数据，不能直接读写存储文件，也不会展示完整
checkpoint 原文。全局记忆不随项目删除而改变。

## 9. 安全与降级

- 凭据形态内容默认拒绝持久化，召回前再次脱敏。
- 记忆以不可信参考资料注入，不能覆盖当前用户指令。
- 解析失败、存储失败、检索失败或蒸馏失败只记录日志，不阻断 Agent 或语音回复。
- checkpoint 输入有硬性字节上限，scope 写入串行化以避免并发覆盖。

## 10. 验证与发布

本项目使用 TypeScript。提交前运行 `pnpm check`、`pnpm build`、`pnpm pack --dry-run` 和
`git diff --check`；发布前确认打包内容包含 `README.md`、`DESIGN.md` 与本架构文档，并
在真实 Harness 中验证项目选择、回收区和永久删除流程。

# DSH Workspace Memory 架构

## 1. 定位

`dsh-workspace-memory` 为 DeepSeek Harness 提供可持久化、按项目隔离的长期记忆。
它同时服务普通 Session 和后台 Agent；这些调用方只依赖 `WorkspaceMemory` 接口，
不共享存储实现细节。

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
│   ├── summary_meta.json
│   ├── memory_entries.json
│   ├── state.json
│   ├── checkpoints/
│   └── summary_history/
├── scopes/
│   └── ws-<sha256-prefix>/
│       ├── scope.json
│       ├── memory_summary.md
│       ├── summary_meta.json
│       ├── memory_entries.json
│       ├── state.json
│       ├── checkpoints/
│       └── summary_history/
└── archived/
    └── ws-<sha256-prefix>/
        ├── scope.json
        ├── memory_summary.md
        ├── summary_meta.json
        ├── memory_entries.json
        ├── state.json
        ├── checkpoints/
        └── summary_history/
```

`memory_entries.json` 是结构化事实的来源；`memory_summary.md` 是受大小限制的当前注入
摘要；`summary_meta.json` 保存来源指纹、确定性/语义模式及语义摘要冷却时间；`state.json`
保存 checkpoint 缓冲和计数；`checkpoints/` 与 `summary_history/`
用于故障排查和变更审计。所有写入经过 scope 级串行队列，并使用临时文件原子替换。

## 4. 公共接口

```ts
interface WorkspaceMemory {
  recall(input: RecallInput): Promise<MemoryContext>
  checkpoint(input: CheckpointInput): Promise<CheckpointResult>
}
```

此外，运行时提供 `remember`、`update`、`forget` 和 `search` 能力供显式记忆工具与设置页使用。调用方
不能直接操作 JSON 文件；这样可以统一处理去重、敏感信息过滤和并发写入。

Agent 显式写入、更新和删除时必须携带 `global | workspace` scope。稳定用户身份与画像（姓名、年龄、
生日、居住地）、跨项目长期偏好和通用工作方式属于 global；只对当前项目成立的事实、决策、架构、
规则和修复属于 workspace。`memory_search` 返回条目的 ID 和 scope，已有事实必须通过
`memory_update` 修订，不能在另一 scope 新建副本。

记忆 ID 在 global 与当前 workspace 间作为权威定位依据；update/forget 不直接信任模型提供的 scope，只有
恰好一个 scope 含该 active ID 时才执行，ID 冲突或不存在时失败关闭。remember 没有既有 ID 可定位，
因此对用户信息、用户画像、姓名、年龄、生日、居住地等稳定画像标签执行确定性 global 提升。搜索
展示使用 `[scope:id]`，让模型和审计日志都能看到真实作用域。

## 5. 数据流

### Agent

1. `systemPrompt.context` 注入当前 scope 的稳定摘要。
2. Agent 第一个 step 根据用户消息调用 `recall`，追加相关条目。
3. Agent turn 结束时把完整消息交给 checkpoint 缓冲区，响应不会被蒸馏过程阻塞。checkpoint
   只在短暂持锁时认领消息和提交结果，耗时的模型蒸馏在锁外执行；期间新到达的消息继续留在缓冲区。
4. 达到阶段条件后，蒸馏器提取长期有效事实并更新结构化条目。

### 普通 Session 与后台 Agent

两者均从 Session 的 `cwd` 解析项目 scope。后台 Agent 继承来源 `cwd`，因此无需单独
的记忆目录，也不会把不同项目的事实混在一起。

## 6. 阶段性 checkpoint

“阶段性”按工作阶段和缓冲阈值判断，而不是按固定小时执行。以下任一条件满足即可
触发整理：

- 后台 Agent 的任务完成；
- 缓冲达到默认 10 个已完成用户轮次；
- 缓冲文本达到默认 4000 字符；
- 默认空闲 5 分钟；
- Session 关闭，或调用方显式强制 checkpoint。

每轮只追加到缓冲区，不强制调用模型。任何记忆变更都会立即重建不调用模型的确定性摘要，避免已纠正
事实继续注入。后台语义摘要仅处理 dirty scope，等待默认 60 秒安静窗口，并限制为每个 scope
最多 24 小时一次；输入按类型轮询且限制为 24 KB，模型只返回 Markdown 摘要正文，程序记录本次
实际输入的来源 ID，并在提交前再次校验 active 条目指纹。启动时校验来源指纹并恢复到期任务。
蒸馏器只用用户原话检索现有记忆，不使用助手回复扩大查询，也不补入最近条目；候选最多 6 条/3 KB。
蒸馏器输出版本化操作：新增、修订、明确取代或
标记冲突。明确取代必须引用本次用户消息原文及目标记忆原文；证据不足时保留双方并建立冲突组。
修订前保存旧版本，取代后的条目继续保留用于审计。只有 active 条目进入稳定摘要，conflict
只在相关查询命中时返回，superseded 不参与普通召回。旧版裸 proposal 输出兼容为新增操作。

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

前端通过 Host 路由访问脱敏数据，不能直接读写存储文件，也不会展示完整 checkpoint 原文。
单条编辑和删除必须经过记忆引擎，以保留旧版本、执行敏感信息检查、串行写入并立即重建摘要。
全局记忆不随项目删除而改变。

## 9. 安全与降级

- 凭据形态内容默认拒绝持久化，召回前再次脱敏。
- 记忆以不可信参考资料注入，不能覆盖当前用户指令。
- 解析失败、存储失败、检索失败或蒸馏失败只记录日志，不阻断 Agent 回复。
- checkpoint 输入有硬性字节上限，scope 写入串行化以避免并发覆盖；recall 使用写入后失效的
  不可变内存快照，不进入写锁队列。

## 10. 验证与发布

本项目使用 TypeScript。提交前运行 `pnpm check`、`pnpm build`、`pnpm pack --dry-run` 和
`git diff --check`；发布前确认打包内容包含 `README.md`、`DESIGN.md` 与本架构文档，并
在真实 Harness 中验证项目选择、回收区和永久删除流程。

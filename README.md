# dsh-workspace-memory

面向 DeepSeek Harness 的 Workspace 长期记忆插件。它让相同工作目录下的多个
Session 共享一份稳定摘要和长期原子记忆，并通过可选 Cordis 接口与
[`dsh-voco`](../dsh-voco/README.md) 的语音前台集成。

## 当前能力

- 按规范化 `cwd` 隔离 Workspace；相同 Workspace 的 Voice Session、后台
  Agent Session 和普通 Session 共享记忆。
- 每个 Agent step 自动注入一份有上限的 `memory_summary.md`。
- 在 Agent 第一 step 根据当前用户消息自动检索相关长期记忆。
- 不使用 BM25、Embedding 或向量数据库：采用精确短语、英文词、中文字符
  bigram、标签、重要性和新近度综合排序。
- 任务结束、10 轮对话、4000 字符、空闲 5 分钟或 Session 关闭时评估
  checkpoint；不会按固定小时机械写入。
- LLM 只蒸馏长期有效事实；重复/近重复事实会更新原条目。
- 提供 `memory_search`、`memory_remember`、`memory_forget` 工具。
- 凭据形态内容默认拒绝持久化，并在模型输入前脱敏。
- 没有安装本插件时，`dsh-voco` 保持原有行为。

详细契约见 [DESIGN.md](./DESIGN.md)。

## 安装（当前源码版本）

```powershell
pnpm install
pnpm build
$plugin = (Resolve-Path .).Path
dsh plugin --profile web add $plugin
```

重启 `dsh web` 后生效。尚未发布 npm 时请使用本地路径安装。

运行数据默认写入：

```text
$DSH_HOME/workspace-memory
```

如果没有设置 `DSH_HOME`，则使用 `~/.dsh/workspace-memory`。数据不会写进
Git 项目目录，除非显式配置 `memoryDir`。

## 配置

安装生成的 loader row 可以覆盖以下配置：

```yaml
- insert:
    - id: workspace-memory
      name: '@flowingspring/dsh-workspace-memory'
      config:
        memoryDir: ''
        checkpointTurns: 10
        checkpointChars: 4000
        idleCheckpointMs: 300000
        consolidateEvery: 5
        summaryMaxBytes: 3000
        recallMaxBytes: 5000
        recallLimit: 8
        checkpointMaxChars: 40000
        keepSummaryVersions: 10
        surfacedPenalty: 8
        summarizeProvider: ''
        summarizeModel: ''
```

`summarizeProvider` 和 `summarizeModel` 为空时使用 DSH 当前默认模型。

## 存储结构

```text
workspace-memory/
├── global/
└── scopes/
    └── ws-<hash>/
        ├── scope.json
        ├── memory_summary.md
        ├── memory_entries.json
        ├── state.json
        ├── checkpoints/
        └── summary_history/
```

项目 Session 会同时读取 `global/` 与对应 `scopes/ws-<hash>/` 的摘要和长期记忆；
全局记忆适合用户偏好和通用工作方式，Workspace 记忆适合项目架构、决策和修复。

`memory_entries.json` 是事实来源；`memory_summary.md` 是自动注入的短摘要；
`checkpoints/` 保留每次阶段性蒸馏的可审计 Markdown 记录。

## 开发验证

源码与测试均使用 TypeScript；`pnpm build` 将 ESM JavaScript 和类型声明生成到
`lib/`，该目录不提交到 Git。

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm pack --dry-run
```

## License

MIT

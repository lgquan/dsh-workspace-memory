# Claude Agent Memory 架构对 dsh-workspace-memory 的借鉴评估

## 研究范围

- 日期：2026-11-14
- 输入材料：用户提供的《Anthropic 首次公开 Claude 记忆架构》转载稿；原文链接为 <https://mp.weixin.qq.com/s/qtnDtNjS6lYJCiPfPMCVWg>
- 核验原则：转载稿是二手解读，只将 Anthropic 官方研究文章、官方产品文档和官方公开代码视为事实来源。
- 本文只做架构评估，不代表已经决定实现，也不修改插件代码。

## 结论

转载稿抓住了 Anthropic 官方研究的核心方向：长期记忆应分层，在线捕获与离线整理应分工，原始会话是纠错依据，常驻上下文应是很小的索引，详细知识应按需检索。这个方向非常适合 `dsh-workspace-memory`，也直接解释了当前“摘要既想做事实投影、又想做语义总览”为什么容易冲突。[Anthropic Research: The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)

但转载稿把研究框架、评测实验、Managed Agents 的 research preview 和 Claude Code Auto Memory 拼成了一个仿佛已经统一部署的“Claude 内部生产架构”。官方材料并没有证明 Claude Code 默认运行完整的 Dreaming/Wiki 管线；Managed Agents Dreams 仍是 research preview，且需要显式创建异步任务。因此应借鉴设计原则，不应照搬宣传化叙事。[Dreams - Claude Platform Docs](https://platform.claude.com/docs/en/managed-agents/dreams) [Claude Code memory docs](https://code.claude.com/docs/en/memory)

对插件最有价值的目标不是立即建设庞大的 Wiki 或向量库，而是把当前两层结构升级为四个职责清晰的层次：

1. 可审计的会话证据层；
2. 带来源、状态和时效的结构化记忆条目层；
3. 模型生成的主题知识页层；
4. 很小的常驻索引层。

后台整理应输出一个独立的候选版本，校验后原子切换，不能直接覆盖当前有效记忆。这样既能解决当前确定性摘要覆盖语义摘要的问题，也为未来纠错、去重、过期治理和更低 Token 的按需检索打下基础。

## 官方事实核验

| 转载稿主张 | 核验结果 | 官方材料实际表达 |
| --- | --- | --- |
| Agent 记忆不同于模型权重、单会话上下文学习和 compaction | 已证实 | 官方研究明确给出这个边界，并把 Agent 记忆定义为从用户和任务经验中获得、跨 Session 保存且以后可读的知识。 |
| 存在 transcripts、memory notes、memory representations、injected context 四层 | 已证实，但它是概念层次 | 官方图 1 展示这四层记忆层次；文章没有把它声明为所有 Claude 产品共享的固定存储 Schema。 |
| Dreaming 可用原始 transcript 校正错误笔记、构建 Wiki、调整注入内容 | 已证实 | 官方研究分别展示了纠正 Pokémon 错误笔记、构建 Wiki、把信息提升到注入层的实验。 |
| Dreaming 是自动“夜间任务”或固定周期任务 | 未证实 | 官方 Dreams API 是显式创建的异步任务；动态工作流由开发者决定何时运行、读哪些 transcript、使用什么模型。官方研究把 cadence 明确列为仍待探索的问题。 |
| Dreaming 使用专门的“审判模型” | 未证实 | 官方文档只说由调用者选择支持的模型运行整理管线，没有公布一个固定的审判模型。 |
| 完整四层 Dreaming/Wiki 架构已经运行在 Claude Code 生产环境 | 夸大 | Claude Code 官方确认的是 Auto Memory：项目级目录、`MEMORY.md` 索引、主题文件和按需读取。Managed Agents Dreams 是单独的 research preview。官方研究只说 Claude Code Auto Memory 用相似方式保持注入层较小。 |
| Claude Code 只在启动时加载 `MEMORY.md` 前 200 行或 25 KB | 已证实 | 两个限制取先到者；详细主题文件不在启动时加载，而由 Claude 使用文件工具按需读取。 |
| `MEMORY.md` 是正文摘要 | 不准确 | 官方文档把它定义为索引，一条记忆一行；详细内容在独立主题文件中。 |
| 原始 transcript 永久无损保留 | 仅对部分产品成立 | Managed Agents Session 是有状态资源，transcript 持续到删除；Claude Code 本地 transcript 会按 `cleanupPeriodDays` 清理，而 Auto Memory 文件不参与该清理。 |
| 只应记隐性规则，绝不记易变事实 | 过度归纳 | Pokémon 实验说明当前屏幕可重新读取的状态不值得长期保存；但 Claude Code Auto Memory 官方类型仍包括进行中的工作、截止日期和无法从代码或 Git 推导的决策。正确原则是“保存未来有复用价值且无法低成本重新获得的信息”，而非按事实/规则二分后硬编码。 |
| 越强模型越不应给规则 | 只在特定评测中成立 | CL-Bench 中“只记录失败”降低了部分强模型的记忆收益；官方结论是给前沿模型简单目标并让其判断显著性，而不是完全取消范围、安全、作用域和可审计约束。 |
| Wiki 一定提高效果并节省约 20,000 Token | 有条件成立 | Stainless 实验中 Wiki 与搜索结合时随 Wiki 成长从 54% 提升到 61%，相对只搜索约 53%，并节省约 20,000 Token/问题；但官方也展示 Wiki 无收益甚至比源文档更大的反例。 |

上表的主要来源均为 [Anthropic 研究原文](https://www.anthropic.com/research/components-of-agent-memory)、[Claude Code Auto Memory 文档](https://code.claude.com/docs/en/memory) 和 [Managed Agents Dreams 文档](https://platform.claude.com/docs/en/managed-agents/dreams)。

## 当前插件与官方层次的映射

| 官方概念层 | 当前插件已有能力 | 主要缺口 |
| --- | --- | --- |
| Transcripts / evidence | `checkpoints/` 保存本次整理所用的用户/助手消息、模型操作和接受/拒绝审计；待整理消息持久化在 `state.json` | checkpoint 目前主要是故障审计文件，不是可检索证据库；结构化条目的 provenance 只保留 message ID，缺少可直接定位到证据文件的稳定引用、证据片段和时效元数据 |
| Memory notes | `memory_entries.json` 有 type、status、importance、冲突、取代、修订历史和 provenance | 缺少置信度、有效时间、最后验证时间、访问统计和“可从当前项目重新推导”的标记；新增、更新和过期治理仍较依赖单次模型判断 |
| Representations / topic pages | `memory_summary.md` 尝试提供语义摘要 | 只有一个总摘要文件；它同时承担展示、常驻注入、降级投影和语义压缩，条目变化时确定性摘要会覆盖语义摘要；无法按主题局部更新，也不能从索引导航到更详细内容 |
| Injected context / index | 每个 Agent step 注入 global 与 workspace 摘要，并在第一个 step 做相关条目召回 | 常驻内容仍是“摘要正文”而非轻量目录；每 step 注入增加上下文成本；索引没有指向主题页或权威条目集合 |
| Dreaming / reconciliation | 后台记忆蒸馏、60 秒语义摘要延迟、24 小时冷却、启动恢复 | 语义摘要只读取结构化条目，不回看 checkpoint 原始证据；在原位置覆盖，没有候选版本、差异审查和原子晋升；24 小时冷却同时阻止了条目变化后的及时恢复 |

当前实现依据：[`src/core.ts`](../../src/core.ts) 中的 `MemoryEntry`、`checkpointMarkdown()`、`deterministicSummary()`、`rebuildSummary()`、`prepareSemanticSummary()` 和 `writeCheckpoint()`；[`src/index.ts`](../../src/index.ts) 中的摘要模型调用、`workspace-memory-summary` 常驻注入与首 step 召回；总体设计见 [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md)。

## 推荐目标架构

### 1. 证据层：保留可回查的底账，但不要无限增长

继续用 checkpoint 保存实际参与整理的原始对话和操作审计，并为每个 checkpoint 分配稳定 ID。结构化条目的 provenance 应指向 `checkpointId + messageId + evidence excerpt/hash`，使后台纠错能够重新核对原话，而不是让上层记忆互相证明。

证据层需要可配置保留期和容量上限。Anthropic 官方也没有给出“所有产品永久保存 transcript”的通用要求；Managed Agents 的 transcript 保存到删除，而 Claude Code 本地 transcript 会按策略清理。[Dreams docs](https://platform.claude.com/docs/en/managed-agents/dreams) [Claude Code memory docs](https://code.claude.com/docs/en/memory)

含凭据、隐私或被用户明确删除的信息必须同时遵循现有脱敏与删除语义。不能为了“可纠错”而把用户要求遗忘的原始内容永久留在隐藏目录。

### 2. 条目层：继续作为权威事实源

保留当前结构化条目和 active/conflict/superseded/deleted 状态机。这一层比完全由模型自由维护 Markdown 更适合 DSH 设置页的浏览、编辑、删除和工作区隔离。

建议逐步增加：

- `confidence`：模型提议、用户明确确认、人工编辑等不同证据等级；
- `validFrom` / `validUntil` / `lastVerifiedAt`：区分稳定事实与可能过期的状态；
- `sourceCheckpointIds`：可从条目回到证据；
- `lastRecalledAt` / `recallCount`：用于决定哪些内容值得提升到常驻索引，而不是直接用于自动删除；
- `derivable`：标记能否从当前代码、配置或工作区文件低成本重新得到，减少重复记忆。

不要硬编码“事实不记、规则才记”。应结合未来复用价值、重新获取成本、稳定性、证据强度和作用域判断。Claude Code Auto Memory 本身也保存 user、feedback、project、reference 四类内容，而不只保存规则。[Claude Code memory docs](https://code.claude.com/docs/en/memory#auto-memory)

### 3. 主题知识页：由模型生成，不再用一个总摘要承载全部语义

为每个 scope 建立少量主题页，例如：

```text
topics/
├── user-profile.md       # 仅 global
├── preferences.md        # global 或 workspace
├── project-overview.md
├── architecture.md
├── decisions.md
├── conventions.md
└── fixes-and-pitfalls.md
```

每个主题页是模型对对应 active 条目的语义整理，必须记录来源 entry IDs、生成时间、来源指纹和 dirty 状态。条目变化后只重算受影响主题，不必每次发送所有记忆。主题页是派生数据，不能反向覆盖权威条目。

这比立即构建任意链接的完整 Wiki 更适合当前规模。官方研究显示 Wiki 对需要跨多个文档综合的问题帮助较大，但在单文档可检索任务中没有明确收益，甚至可能比源资料更大。[Anthropic Research](https://www.anthropic.com/research/components-of-agent-memory) 官方 Knowledge Wiki quickstart 也把适用范围限定为“反复查询、变化较慢的文档语料”，并要求每项事实保留 provenance 和冲突。[Knowledge Wiki quickstart](https://github.com/anthropics/claude-quickstarts/tree/main/managed-agents/knowledge-wiki)

### 4. 常驻索引：只告诉 Agent 有什么、在哪里，不承载全部事实

新增很小的 `memory_index.md`，包含：

- 当前 scope 可用的主题；
- 每个主题的一句说明和最近更新时间；
- 少量必须始终知道的高优先级规则；
- 如何通过 `memory_search` 或主题读取工具获得详情。

启动/首 turn 注入 global 与当前 workspace 的索引，而不是每个 step 注入完整摘要正文。当前问题相关的结构化条目仍由首 step 召回；模型需要更深上下文时再读取主题页。Claude Code 的 `MEMORY.md` 正是“一行一个入口的索引”，只有前 200 行或 25 KB 常驻，主题文件按需读取。[Claude Code memory docs](https://code.claude.com/docs/en/memory#how-it-works)

200 行/25 KB 不是应该照搬的神奇参数。当前插件可从更小的 1-3 KB 起步，并通过真实召回准确率、遗漏率和前台 Token 数据调整。

### 5. 后台整理：从“直接覆盖”改为“候选生成 + 校验 + 原子晋升”

一次后台语义整理建议采用以下生命周期：

1. 根据 dirty topic 收集对应 active 条目和必要的 checkpoint 证据，不全量扫描所有历史；
2. 在 `generations/<run-id>/` 生成候选主题页和候选索引；
3. 检查来源 entry IDs 是否仍 active、来源指纹是否变化、是否遗漏冲突、是否包含凭据、是否超出大小预算；
4. 对新增主张要求能够追溯到条目或原始证据；无法验证的推断不得晋升为事实；
5. 校验通过后原子切换 active generation，保留有限历史用于回滚；失败时继续使用上一版有效语义内容，不发布确定性条目拼接；
6. 修改或删除使旧摘要包含错误事实时，将受影响主题暂时标记为不可注入，依靠权威条目召回，直到候选版本晋升。

这借鉴了 Managed Agents Dreams 的关键安全边界：输入 memory store 不被修改，输出是独立 store，用户可以检查后采用或丢弃。官方 Dreams 可读取 1-100 个 Session 和现有 memory store，异步生成新 store；其成本随 Session 数量和长度大致线性增长。[Dreams docs](https://platform.claude.com/docs/en/managed-agents/dreams)

### 6. 调度：事件驱动增量整理 + 低频完整校准

不建议“每轮对话都完整重算”，也不建议“无论有没有变化每天固定重算”。更合适的是：

- 对话结束后仍按现有短防抖提取结构化条目；
- 条目发生变化时，把对应 topic 标记 dirty，并在安静窗口后做局部语义整理；
- 用户明确纠正/删除时提高优先级；
- 达到 dirty 条目数量、证据量或最长等待时间时触发；
- 服务启动只恢复未完成任务；
- 每隔较长周期或累计足够变化后做一次完整一致性校准。

Anthropic 官方把“何时创建记忆、如何调整 dreaming cadence”列为开放问题，并提出可按记忆访问频率聚焦整理，而不是给出固定 24 小时答案。[Anthropic Research](https://www.anthropic.com/research/components-of-agent-memory)

## 对当前摘要冲突问题的直接启示

确定性条目拼接可以继续作为内部诊断视图或无模型情况下的恢复材料，但不能覆盖用户可见、前台注入的模型语义内容。正确分层是：

- `memory_entries.json`：权威事实；
- `topics/*.md`：模型语义整理；
- `memory_index.md`：常驻导航；
- `checkpoints/`：纠错证据；
- `generations/`：候选、当前版本和回滚历史。

“确定性”应体现在状态机、来源校验、权限、原子切换和失效规则上，而不是用程序拼接原始条目冒充语义摘要。

## 不应照搬的部分

1. **不要现在就建设完整 Wiki/知识图谱。** 当前每个 scope 的记忆规模远小于 Anthropic 的 420M-token Stainless 语料；先做固定主题页和轻量索引更可控。
2. **不要因为文章提到四层就把每层做成独立复杂服务。** 本地文件、结构化 JSON 和现有 DSH 工具已经足以实现职责分层。
3. **不要把所有 transcript 永久保留。** 要有隐私删除、容量预算、保留期和脱敏策略。
4. **不要只凭访问频率自动删除。** 低频但关键的安全规则、用户明确偏好和架构决定可能长期重要；访问数据只能作为整理信号。
5. **不要取消确定性约束。** 模型可以判断显著性和组织方式，但 scope 隔离、凭据过滤、来源完整性、删除语义和原子提交必须由程序保证。
6. **不要把 200 行/25 KB、24 小时或某个模型当作普适答案。** 参数应由插件自己的规模、Token、召回准确率和延迟数据决定。
7. **不要让模型生成的新摘要成为新的事实来源。** 摘要和主题页只能引用条目与证据，不能在多轮自我总结中把推断逐渐固化成“事实”。

## 建议实施顺序

### P0：先修正当前职责冲突

- 模型语义摘要成为唯一发布摘要；
- 确定性拼接不再覆盖展示或注入内容；
- 删除/纠正时让受影响语义内容失效，完成前依靠权威条目召回；
- 为“语义摘要后新增、修订、删除条目仍不退回拼接摘要”增加回归测试。

### P1：建立索引与主题页

- 将一个总摘要拆成固定主题页；
- 建立小型 `memory_index.md`；
- 将常驻注入从每 step 完整摘要调整为首 turn 索引 + 查询相关条目；
- 记录 topic 到 entry IDs 的来源映射。

### P2：引入安全的增量 Dreaming

- dirty topic 局部重算；
- 读取必要 checkpoint 证据；
- 候选 generation、自动校验、原子晋升和回滚；
- 设置页显示“当前版本、待更新主题、上次校准、候选失败原因”，并保留人工编辑/删除入口。

### P3：用数据决定是否需要更复杂检索

先记录召回命中、用户纠错、注入 Token、按需主题读取、摘要陈旧时间和后台整理成本。只有固定主题页出现明显跨主题检索瓶颈时，再评估 BM25、Embedding、自由链接 Wiki 或知识图谱。

## 建议验证指标

- 纠正或删除后，旧事实是否还会被注入；
- 新 Session 首次提问能否命中刚形成的长期事实；
- global 信息是否在所有 workspace 可见，workspace 信息是否严格隔离；
- 常驻注入 Token、按需召回 Token、后台整理 Token 分别是多少；
- 模型生成内容中无法追溯来源的主张比例；
- 主题页大小、重复率、陈旧时间和候选晋升失败率；
- 人工编辑后是否能稳定保留，不被后续模型整理反向覆盖；
- 与“结构化条目检索 + 单一摘要”的当前基线相比，真实问题回答准确率是否提升。

## 一手来源

1. Anthropic, [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory), 2026-11-06.
2. Anthropic, [How Claude remembers your project](https://code.claude.com/docs/en/memory), Claude Code Docs.
3. Anthropic, [Dreams](https://platform.claude.com/docs/en/managed-agents/dreams), Claude Platform Docs, research preview.
4. Anthropic, [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool), Claude Platform Docs. 该文档同时建议限制文件大小、处理过期记忆并防止路径穿越。
5. Anthropic, [Knowledge wiki with a dynamic workflow](https://github.com/anthropics/claude-quickstarts/tree/main/managed-agents/knowledge-wiki), official quickstart.


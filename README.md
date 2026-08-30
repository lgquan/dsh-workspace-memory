# dsh-workspace-memory

为 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 提供按工作区隔离的长期记忆。

安装后，DSH 可以在后续会话中继续使用已经确认的项目事实、技术决策、工作约定和用户偏好；不同项目的记忆互不混用，全局偏好则可以跨项目共享。插件同时提供记忆检索、显式写入、删除、冲突修正和可审计的历史版本。

## 适合谁

- 希望同一项目的多个 Session 共享上下文；
- 希望普通 Agent、后台 Agent 和语音 Agent 使用同一份项目记忆；
- 希望长期记忆可查看、可纠错、可删除，而不是无法审计的黑盒；
- 不想额外部署向量数据库或 Embedding 服务。

## 安装前提

- 已安装 DeepSeek Harness；
- 使用 DSH 的 `web` profile；
- Node.js `>= 22.19.0`。

下面两种方式任选一种。推荐使用 NPM，安装的是已经构建好的发布包；GitHub 安装适合希望直接跟随仓库版本的用户。

## 方式一：通过 NPM 安装（推荐）

在 PowerShell 或终端中运行：

```powershell
dsh plugin --profile web add --config.minimumReleaseAge=0 @flowingspring/dsh-workspace-memory@0.2.12
```

NPM 包地址：[@flowingspring/dsh-workspace-memory](https://www.npmjs.com/package/@flowingspring/dsh-workspace-memory)

## 方式二：通过 GitHub 安装

直接从 GitHub 的稳定标签安装，不需要下载项目或手动执行构建：

```powershell
dsh plugin --profile web add --config.minimumReleaseAge=0 github:lgquan/dsh-workspace-memory#v0.2.12
```

GitHub 安装会在本机完成一次插件构建，因此通常比 NPM 安装稍慢。稳定使用请保留版本标签，不建议在生产环境直接安装 `#main`。

## 安装后怎么使用

1. 重启 `dsh web`。
2. 打开 DSH 设置。
3. 进入“记忆”页面。
4. 正常与 Agent 对话。插件会自动缓冲、整理并在后续任务中检索相关记忆。

安装成功后，设置页会显示：

- 全局记忆和各项目记忆；
- 自动生成的稳定摘要；
- 可展开查看的结构化记忆；
- 记忆状态、历史修订和冲突信息；
- 已删除项目对应的记忆回收区。

也可以用以下命令确认安装版本：

```powershell
dsh plugin --profile web list
```

## 更新

使用 NPM 更新到指定版本：

```powershell
dsh plugin --profile web add --config.minimumReleaseAge=0 @flowingspring/dsh-workspace-memory@0.2.12
```

使用 GitHub 更新到指定标签：

```powershell
dsh plugin --profile web add --config.minimumReleaseAge=0 github:lgquan/dsh-workspace-memory#v0.2.12
```

更新后重启 `dsh web`。

## 卸载

```powershell
dsh plugin --profile web remove --config.minimumReleaseAge=0 @flowingspring/dsh-workspace-memory
```

卸载插件不会自动删除已经保存的记忆数据。确认不再需要后，可以手动删除下文所列的数据目录。

## 它会记住什么

插件只整理适合长期复用的内容，例如：

- 项目架构、模块职责和稳定约束；
- 已确认的技术选型与决策；
- 用户明确表达的偏好和工作方式；
- 已验证的问题结论、修复方式和注意事项。

临时闲聊、一次性任务细节和明显的凭据内容不应成为长期记忆。凭据形态内容会被拒绝持久化，并在记忆输出前再次脱敏。

## 记忆什么时候整理

对话完成后，消息会先进入缓冲区，不会每轮都调用模型整理。出现以下任一情况时会评估 checkpoint：

- 后台 Agent 任务完成；
- 累计达到 10 个已完成用户轮次；
- 缓冲内容达到 4000 个字符；
- 连续空闲 5 分钟；
- Session 关闭；
- 调用方显式要求立即整理。

因此，刚聊完但尚未达到阈值、没有空闲足够时间或 Session 仍在继续时，设置页里暂时看不到新记忆是正常现象。

## 记忆如何检索和纠错

- 每个 Agent step 都会注入一份有大小上限的稳定摘要；
- Agent 第一个 step 会根据当前问题检索相关结构化记忆；
- Agent 还可以调用 `memory_search` 做第二次检索；
- `memory_remember` 可以显式保存一条长期事实；
- `memory_forget` 可以按记忆 ID 删除条目。

明确的用户纠正可以取代旧事实；证据不足的矛盾不会静默覆盖，而会保留为显式冲突。修订前的内容和被取代条目继续保留用于审计，但不会作为有效事实进入稳定摘要。

## 数据存在哪里

默认数据目录：

```text
$DSH_HOME/workspace-memory
```

未设置 `DSH_HOME` 时使用：

```text
~/.dsh/workspace-memory
```

记忆数据默认不会写入 Git 项目目录。设置页只能读取经过脱敏的摘要和结构化条目，不会展示完整 checkpoint 对话原文。

## 与 dsh-voco 一起使用

安装 [`dsh-voco`](https://github.com/lgquan/dsh-voco#readme) 后，语音 Session、普通 Session 和后台 Agent 只要使用相同的工作目录，就会共享同一个项目记忆范围。

`dsh-voco` 不是必需依赖。未安装语音插件时，`dsh-workspace-memory` 仍可独立服务普通 DSH Agent。

## 可选配置

默认配置已经可以直接使用。需要调整时，可以在插件 loader 配置中覆盖以下字段：

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

`summarizeProvider` 和 `summarizeModel` 留空时，使用 DSH 当前默认模型。

## 常见问题

### 安装后设置里没有“记忆”页面

先运行 `dsh plugin --profile web list` 确认插件已经安装，然后完整重启 `dsh web`。正在运行的 Web 进程不会自动加载新插件。

### 刚结束对话，为什么还没有新记忆

整理由任务完成、轮次、字符数、空闲时间或 Session 关闭触发。未达到任何条件时，内容仍在 checkpoint 缓冲区中。

### 为什么某些聊天内容没有保存

蒸馏器只应保留长期有效、未来可复用的事实。临时信息、重复内容、低价值闲聊和凭据形态内容会被忽略或拒绝。

### 删除项目后记忆还在吗

项目从 DSH 注册表中删除后，对应记忆会进入设置页的“回收区”，不再参与正常召回。只有在回收区确认“永久删除”后，相关摘要、结构化条目和审计历史才会物理删除。

## 更多文档

- [设计与行为契约](./DESIGN.md)
- [架构说明](./DOCS/ARCHITECTURE.md)
- [问题与处理记录](./DOCS/issues/)

## 开发

源码使用 TypeScript。开发者检出仓库后可以运行：

```powershell
pnpm install
pnpm check
pnpm build
pnpm pack --dry-run
```

`lib/` 是构建产物，不提交到 Git；通过 NPM 安装时包含预构建产物，通过 GitHub 安装时由 `prepare` 脚本自动生成。

## License

MIT

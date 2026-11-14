# dsh-workspace-memory

为 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 提供按工作区隔离的长期记忆。

安装后，DSH 可以在后续会话中继续使用已经确认的项目事实、技术决策、工作约定和用户偏好；不同项目的记忆互不混用，全局偏好则可以跨项目共享。插件同时提供记忆检索、显式写入、删除、冲突修正和可审计的历史版本。

## 适合谁

- 希望同一项目的多个 Session 共享上下文；
- 希望普通 Agent 和后台 Agent 使用同一份项目记忆；
- 希望长期记忆可查看、可纠错、可删除，而不是无法审计的黑盒；
- 不想额外部署向量数据库或 Embedding 服务。

## 安装前提

- 已安装 DeepSeek Harness `0.2.2-rc.1` 或兼容的更新版本；
- 使用 DSH 的 `web` profile；
- Node.js `>= 22.19.0`。

下面两种方式任选一种。两种方式安装的都是已经构建好的插件包，不需要下载源码或准备开发环境。推荐使用 NPM；无法访问 NPM Registry 时可以改用 GitHub Release。

## 方式一：通过 NPM 安装（推荐）

在 PowerShell 或终端中运行：

```powershell
dsh plugin --profile web add --config.minimumReleaseAge=0 @flowingspring/dsh-workspace-memory@0.2.16
```

NPM 包地址：[@flowingspring/dsh-workspace-memory](https://www.npmjs.com/package/@flowingspring/dsh-workspace-memory)

## 方式二：通过 GitHub 安装

直接安装 GitHub Release 中的预构建插件包：

```powershell
dsh plugin --profile web add --config.minimumReleaseAge=0 https://github.com/lgquan/dsh-workspace-memory/releases/download/v0.2.16/flowingspring-dsh-workspace-memory-0.2.16.tgz
```

Release 页面：[v0.2.16](https://github.com/lgquan/dsh-workspace-memory/releases/tag/v0.2.16)

## 安装后怎么使用

1. 重启 `dsh web`。
2. 打开 DSH 设置。
3. 进入“记忆”页面。
4. 正常与 Agent 对话。插件会自动缓冲、整理并在后续任务中检索相关记忆。

安装成功后，设置页会显示：

- 全局记忆和各项目记忆；
- 与 DSH 工作区列表同步的项目显示名称；
- 可固定选择的记忆整理模型及其可用状态；
- 待整理队列、下次运行、上次成功和最近错误；
- 自动生成的稳定摘要；
- 可展开查看的结构化记忆；
- 可直接编辑或删除的单条记忆；
- 记忆状态、历史修订和冲突信息；
- 已删除项目对应的记忆回收区。

也可以用以下命令确认安装版本：

```powershell
dsh plugin --profile web list
```

## 更新

使用 NPM 更新到指定版本：

```powershell
dsh plugin --profile web add --config.minimumReleaseAge=0 @flowingspring/dsh-workspace-memory@0.2.16
```

使用 GitHub 更新到指定标签：

```powershell
dsh plugin --profile web add --config.minimumReleaseAge=0 https://github.com/lgquan/dsh-workspace-memory/releases/download/v0.2.16/flowingspring-dsh-workspace-memory-0.2.16.tgz
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

普通对话完成后，消息会立即持久化到缓冲区，并在默认 5 秒合并窗口后进入后台整理。短窗口会把同一项目连续产生的消息合并，避免对流式片段或紧邻轮次逐条调用模型。前台回答不等待整理完成。

后台 Agent 任务结束、Session 关闭或调用方显式要求时仍会立即评估 checkpoint。批处理调用方还可以使用以下条件：

- 后台 Agent 任务完成；
- 累计达到 10 个已完成用户轮次；
- 缓冲内容达到 4000 个字符；
- 连续空闲 5 分钟（批处理兼容策略）；
- Session 关闭；
- 调用方显式要求立即整理。

插件在 DSH 服务运行期间持续处理后台队列，默认全局最多同时发起一个整理请求。它会在服务启动时恢复已有项目的待整理消息，并在最长 5 秒内重新调度。瞬时模型或网络故障会使用退避间隔有限重试；无效 JSON、配额、鉴权和其他确定性错误会暂停该项目的自动整理，同时保留待整理消息，避免相同请求无限消耗 token。

同一工作区的新 Session 第一次召回记忆时，如果仍有待整理内容，插件会优先触发整理并最多等待 10 秒。整理超时或失败不会无限阻塞聊天，而是继续使用已有记忆。

因此，刚结束对话后的短暂窗口内只看到“待整理”是正常现象；设置页会同时显示计划、排队、整理、重试或暂停状态，并累计展示后台整理调用数和实际输入/输出 token。暂停后可以在排除模型或配置问题后手工“立即重试”。DSH 服务停止时不会在独立进程中继续调用模型，重新启动后会恢复未被暂停的处理。

## 记忆整理模型

设置页的“记忆整理模型”可以从 DSH 当前可路由的全部 provider/model 中固定选择一个专用模型。默认固定使用 DSH 账户的 `deepseek-account / deepseek-flash`。该选择独立于具体工作区和 Session 的对话模型；工作区对话切换模型不会改变记忆整理模型。

选定模型被删除或暂时不可用时，插件不会静默回退到其他模型，待整理内容会保留并重试，设置页会明确显示不可用状态。

## 记忆如何检索和纠错

- 每个 Agent step 都会注入一份有大小上限的稳定摘要；
- Agent 第一个 step 会根据当前问题检索相关结构化记忆；
- Agent 还可以调用 `memory_search` 做第二次检索；
- `memory_remember` 可以显式保存一条长期事实；
- `memory_forget` 可以按记忆 ID 删除条目。

明确的用户纠正可以取代旧事实；证据不足的矛盾不会静默覆盖，而会保留为显式冲突。修订前的内容和被取代条目继续保留用于审计，但不会作为有效事实进入稳定摘要。

在设置页展开一条活动记忆后，可以直接编辑标题、说明、内容、标签、类型和重要度，也可以删除该条记忆。手工编辑会保存旧版本并立即重建摘要；删除采用可审计的软删除，该条目会立即退出召回和摘要。

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
        processingDelayMs: 5000
        maxConcurrentDistillations: 1
        consolidateEvery: 5
        summaryMaxBytes: 3000
        recallMaxBytes: 5000
        recallLimit: 8
        checkpointMaxChars: 40000
        keepSummaryVersions: 10
        surfacedPenalty: 8
        summarizeProvider: deepseek-account
        summarizeModel: deepseek-flash
```

`summarizeProvider` 和 `summarizeModel` 默认固定为 DSH 账户的 Flash 模型，也可以直接在设置页选择其他当前可用模型。

记忆整理不会继承聊天 Session 的思考设置。插件会按所选模型的能力自动使用最低推理档：支持 `off` 时关闭思考，只提供非关闭档位时选择最低档，不支持推理控制时不发送该参数。

插件不再写死 1500-token 的模型输出上限，而是使用所选模型与 provider 的默认能力。若 provider 明确返回 `max-tokens`，插件只进行一次有界拆批恢复；无效 JSON 也只允许一次格式恢复调用，仍失败则暂停而不是原样无限重试。

`processingDelayMs` 是普通对话完成后的合并窗口；`maxConcurrentDistillations` 是跨工作区同时整理的最大请求数。通常保留默认值即可。整理模型建议直接在设置页选择，避免手工填写 provider/model 标识。

## 常见问题

### 安装后设置里没有“记忆”页面

先运行 `dsh plugin --profile web list` 确认插件已经安装，然后完整重启 `dsh web`。正在运行的 Web 进程不会自动加载新插件。

### 刚结束对话，为什么还没有新记忆

普通对话默认在完成后等待 5 秒合并窗口再进入后台队列。若长时间停留在待整理、排队或重试状态，可在记忆设置页查看最近错误，并确认固定模型和对应 provider 可用。

### 为什么某些聊天内容没有保存

蒸馏器只应保留长期有效、未来可复用的事实。临时信息、重复内容、低价值闲聊和凭据形态内容会被忽略或拒绝。

### 删除项目后记忆还在吗

项目从 DSH 注册表中删除后，对应记忆会进入设置页的“回收区”，不再参与正常召回。只有在回收区确认“永久删除”后，相关摘要、结构化条目和审计历史才会物理删除。

## 更多文档

- [设计与行为契约](./DESIGN.md)
- [架构说明](./docs/ARCHITECTURE.md)
- [问题与处理记录](./docs/issues/)

## 开发

源码使用 TypeScript。开发者检出仓库后可以运行：

```powershell
pnpm install
pnpm check
pnpm build
pnpm pack --dry-run
```

`lib/` 是构建产物，不提交到 Git。NPM 包和 GitHub Release 附件都会包含经过发布检查的预构建产物。

## License

MIT

# DSH Workspace Memory — Design

## Goal

Provide durable, workspace-scoped memory for DeepSeek Harness while remaining
independent from any particular UI or voice plugin. Ordinary DSH Agents and
`dsh-voco` share the same memory whenever their Sessions have the same `cwd`.

The plugin owns memory. Callers only cross the `WorkspaceMemory` seam.

## External interface

```ts
interface WorkspaceMemory {
  recall(input: RecallInput): Promise<MemoryContext>
  checkpoint(input: CheckpointInput): Promise<CheckpointResult>
}
```

- `recall` returns a bounded stable summary plus query-relevant entries.
- `checkpoint` accepts newly completed conversation messages. It buffers,
  deduplicates, decides whether a stage is ready, distils durable facts, and
  persists them. Callers do not implement checkpoint policy.
- Both operations resolve scope from `sessionId` or an explicit `cwd`.
- Missing/empty `cwd` resolves to the global scope.
- A project scope recalls both global and workspace entries; writes may be classified
  as `global` or `workspace` by the distiller.
- Failure to recall memory never prevents an Agent or voice response.

The production adapter is the Cordis `workspaceMemory` service. Tests use an
in-memory/fake adapter at the same seam.

## Scope and storage

Default root: `$DSH_HOME/workspace-memory` (fallback `~/.dsh/workspace-memory`).

```text
workspace-memory/
  global/
    memory_summary.md
    memory_entries.json
    state.json
    checkpoints/
    summary_history/
  scopes/
    ws-<sha256-prefix>/
      scope.json
      memory_summary.md
      memory_entries.json
      state.json
      checkpoints/
      summary_history/
```

Workspace identity is the normalized absolute `cwd`. Runtime data stays out of
the user's Git checkout unless `memoryDir` is explicitly configured there.
Writes use a per-scope promise queue and atomic temporary-file rename.

## Retrieval

Version 1 deliberately has no BM25, vector database, or embedding dependency.
It performs structured lexical retrieval over parsed entries:

1. exact phrase and normalized substring matches;
2. title, retrieval-term, and tag matches;
3. ASCII word and CJK character-bigram coverage;
4. description/content matches;
5. importance, recency, and a short-lived surfaced-memory penalty.

The result is bounded by entry count and UTF-8 bytes. Memory is always treated
as reference data and never as an instruction overriding the current user.

## Checkpoint policy

A stage is logical, not hourly. A checkpoint becomes eligible when any of the
following is true:

- a background Agent turn/task completes;
- at least `checkpointTurns` completed user turns are buffered (default 10);
- buffered text reaches `checkpointChars` (default 4000 characters);
- the buffer remains idle for `idleCheckpointMs` (default 5 minutes);
- the Session closes or a caller explicitly forces a checkpoint.

Only completed messages enter the buffer. Checkpointing is asynchronous from
Agent/voice response delivery. A scope queue prevents concurrent mutations.

The distiller outputs durable atomic facts only: preferences, project facts,
decisions, conventions, fixes, and explicitly requested memories. Greetings,
temporary instructions, progress chatter, and unconfirmed speculation are
discarded. Similar existing entries are updated instead of duplicated.

After `consolidateEvery` successful checkpoints (default 5), the summary is
rebuilt from active entries. A bounded history is kept before replacement.

## DSH integration

- `systemPrompt.context` injects the stable summary on every Agent step.
- `agent/pre-step` calls `recall` for the current user message and appends only
  relevant entries on step 1.
- `agent/turn-stopping` submits that turn to `checkpoint` without blocking turn
  completion.
- memory tools provide explicit search, remember, and forget operations.
- `memory_search` remains the Agentic second-search seam: an Agent can issue
  alternate queries when the automatic first recall is insufficient.

## Voco integration

- Before frontend routing, Voco optionally calls `workspaceMemory.recall`.
- The returned context is included as quoted reference material for the router.
- Completed voice utterances are submitted to `checkpoint`; policy remains
  inside the memory module.
- Voice Session close forces a final evaluation of the buffered stage.
- If the service is absent or fails, Voco uses its existing behavior unchanged.
- Delegated background Agents already inherit the source `cwd`, so they resolve
  the same workspace scope without a Voco-specific storage path.

## Safety and failure behavior

- Obvious credential-shaped values are rejected from automatic persistence and
  redacted from recall output.
- Malformed LLM output leaves the store unchanged.
- Memory I/O, retrieval, or distillation failure is logged and never fails the
  foreground Agent/voice operation.
- Checkpoint input has a hard byte cap.
- Memory context is clearly delimited and labelled as untrusted reference data.

## Initial acceptance criteria

1. Two Sessions with the same normalized `cwd` recall the same entries.
2. Different workspaces remain isolated.
3. Exact, ASCII-token, and Chinese-bigram queries return ranked entries.
4. Repeated checkpoint messages are deduplicated by message id.
5. Threshold, idle, task-end, and close triggers are deterministic in tests.
6. Voco behaves exactly as before when `workspaceMemory` is unavailable.
7. A Voco frontend query receives bounded memory when it is available.
8. Core store/retrieval tests require no running DSH process or remote model.

# DSH Workspace Memory — Design

## Goal

Provide durable, workspace-scoped memory for DeepSeek Harness while remaining
independent from any particular UI. DSH Agents share the same memory whenever
their Sessions have the same `cwd`.

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
- Failure to recall memory never prevents an Agent response.

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
  archived/
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
Writes use a per-scope promise queue and atomic temporary-file rename. Read-only
recall uses an immutable in-process snapshot cache and does not wait behind the
scope mutation queue. Checkpointing claims a bounded batch under the queue,
distils that batch outside the queue, then briefly reacquires the queue to merge
the result; messages appended while distillation is running remain pending.

When a workspace disappears from the DSH workspace registry, its persisted scope
is moved from `scopes/` to `archived/`. Archived scopes are excluded from normal
recall and active-scope listings, but remain readable through the settings
recycle bin. A confirmed purge physically removes the archived directory and
all of its checkpoints and summary history. The global scope is never archived
or removed by workspace cleanup.

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

A stage is logical, not hourly. Completed foreground turns are persisted first
and scheduled for distillation after `processingDelayMs` (default 5 seconds).
The short debounce merges adjacent activity without delaying the foreground
response. Explicit and task-end checkpoints remain immediately eligible. Batch
callers may also become eligible when any of the following is true:

- a background Agent turn/task completes;
- at least `checkpointTurns` completed user turns are buffered (default 10);
- buffered text reaches `checkpointChars` (default 4000 characters);
- the buffer remains idle for `idleCheckpointMs` (default 5 minutes);
- the Session closes or a caller explicitly forces a checkpoint.

Only completed messages enter the buffer. Checkpointing is asynchronous from
Agent/voice response delivery. A scope queue prevents concurrent mutations, and
a bounded runtime queue limits cross-scope model work to
`maxConcurrentDistillations` (default 1). Pending messages are durable, restored
on service startup, and retried with exponential backoff after failures.
Before a new Session's first recall, pending messages for the same workspace are
prioritized and awaited for at most 10 seconds. Failure or timeout falls back to
the last committed memory so foreground chat cannot be blocked indefinitely.

The distiller receives a bounded set of relevant existing entries and emits
versioned operations: add, revise, supersede, or flag-conflict. Explicit user
corrections may supersede an older fact only when verbatim user and target
quotes validate against the checkpoint and current target. Uncertain conflicts
remain visible as a conflict group instead of silently disabling either fact.
Revisions and superseded entries remain auditable, while only active facts enter
the stable summary. Legacy proposal arrays remain compatible as add operations.

Any memory mutation immediately rebuilds the affected scope summary so corrected
facts cannot remain injected. `consolidateEvery` successful checkpoints (default
5) provides a periodic fallback rebuild. A bounded history is kept before replacement.

## DSH integration

- `systemPrompt.context` injects the stable summary on every Agent step.
- `agent/pre-step` calls `recall` for the current user message and appends only
  relevant entries on step 1.
- `agent/turn-stopping` persists the completed turn without invoking the LLM in
  the foreground path, then schedules it through the short debounce window.
- memory tools provide explicit search, remember, and forget operations.
- `memory_search` remains the Agentic second-search seam: an Agent can issue
  alternate queries when the automatic first recall is insufficient.

### Settings memory browser

The Web client contributes a top-level `settings.section` named `记忆`. Active
workspace labels come from the Host `WorkspaceRegistry.title`, while normalized
`cwd` remains the stable memory identity. Duplicate labels include the path for
disambiguation. The page reads the same store through loopback Host routes:

- `GET /workspace-memory/api/v1/scopes` lists the global scope and persisted
  workspace descriptors.
- `GET /workspace-memory/api/v1/scope?cwd=...` returns a redacted summary,
  active entries, and checkpoint counters for one scope.
- `GET /workspace-memory/api/v1/archived-scopes` lists workspace scopes in the
  recoverable archive.
- `GET /workspace-memory/api/v1/archived-scope?key=...` reads one archived
  scope, and `DELETE` permanently purges it after UI confirmation.
- `GET /workspace-memory/api/v1/settings` returns the routable DSH model catalog
  and current fixed memory route; `PUT` persists a provider/model pair through
  DSH settings.
- `PUT /workspace-memory/api/v1/entry?cwd=...&id=...` performs a versioned manual
  edit, and `DELETE` soft-deletes one active entry. Both operations rebuild the
  affected stable summary immediately.

The fixed memory route is independent from Session model selection. An
unavailable fixed route remains selected and visible; distillation fails and
retries without silently falling back. The initial route is
`deepseek-account/deepseek-flash`.

The browser never opens checkpoint Markdown or writes the JSON files directly.
Mutations continue to go through the memory engine so its per-scope locks,
deduplication, secret checks, and atomic writes remain authoritative.

## Safety and failure behavior

- Obvious credential-shaped values are rejected from automatic persistence and
  redacted from recall output.
- Malformed LLM output leaves the store unchanged.
- Memory I/O, retrieval, or distillation failure is logged and never fails the
  foreground Agent operation.
- Checkpoint input has a hard byte cap.
- Memory context is clearly delimited and labelled as untrusted reference data.

## Initial acceptance criteria

1. Two Sessions with the same normalized `cwd` recall the same entries.
2. Different workspaces remain isolated.
3. Exact, ASCII-token, and Chinese-bigram queries return ranked entries.
4. Repeated checkpoint messages are deduplicated by message id.
5. Threshold, idle, task-end, and close triggers are deterministic in tests.
6. Manual edits retain the prior revision and immediately rebuild the summary.
7. Manual deletes immediately remove an entry from recall and the summary.
8. Core store/retrieval tests require no running DSH process or remote model.

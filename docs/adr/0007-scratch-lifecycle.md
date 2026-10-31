# Retain scratch directories only when they are actionable

Each tool call creates a scratch directory under `<workspace>/.dsh-java/` (configurable with `scratchRoot`). The plugin deletes it after a fully successful call unless `keepWorkdir` is set; it retains the directory when compilation fails, the process times out or is killed, output was truncated, or compiler output contained unclassified lines.

Alternatives were "always delete" and "always retain". Always deleting removes the evidence a user needs after a failure — the generated source, class files, and full spill files. Always retaining fills the workspace with per-call directories and no session-end cleanup hook exists to reclaim them. The chosen policy keeps exactly the calls a human or agent may need to inspect and returns `workdir`, `retained`, and `retainedReason` so the model can tell which case it got. A successful `java_compile` therefore reports `workdir: null` by default: its purpose is diagnostics, not artifacts, and `java_run` compiles its own sources.

The cost is that a caller cannot compile once and reuse `outDir` later without `keepWorkdir`. The benefit is bounded workspace growth and explicit retention semantics.

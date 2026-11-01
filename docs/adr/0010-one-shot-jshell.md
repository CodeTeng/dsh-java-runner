# Evaluate expressions with one-shot JShell, not a resident JVM

`java_eval` writes the supplied code to a script file in the scratch directory and runs `jshell --feedback concise <script>` in one process per call. Classpath entries are validated like `java_run`; the heap cap is applied with both `-J-Xmx` (the JShell front end) and `-R-Xmx` (the execution engine); English and UTF-8 flags are passed through `-J` and `-R`; Docker execution reuses the same script through a bind mount.

The alternative was a persistent JVM whose state survives across calls ("hot JVM"). It would avoid JVM startup and let a session build up definitions, but it needs a lifecycle: who owns the process, when does it die, what happens on plugin reload or a concurrent call, and how is a runaway loop stopped without poisoning later calls. A resident process also holds memory between calls and turns every tool error into a possible session-corruption bug. The MVP can afford the startup cost.

JShell brings its own semantics that the tool must model, and the tool description states them:

- A bare expression whose value is not consumed prints nothing; use `System.out.println`.
- Compilation and runtime errors go to stderr while the process exit code stays 0, so success also requires that no `Error:` or `Exception` line was found.
- Output carries CRLF endings and a trailing `jshell> ` prompt, and the welcome banner is removed before returning `stdout`.

The trade-off is per-call startup (roughly a second) and no state sharing; the benefit is a stateless, timeout- and sandbox-safe execution path that behaves like every other tool in the plugin.

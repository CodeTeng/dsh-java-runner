# dsh-java-runner — design

Status: draft, 2026-10-31. Verified against DSH 0.2.1-rc.5. Decisions live in `docs/adr/`; if this document contradicts an ADR, the ADR wins.

## 1. Summary

`dsh-java-runner` is a DeepSeek Harness plugin that gives an agent session first-class Java execution: discover JDKs, compile source, run a Java entry point, and run JUnit 5 tests. Every tool returns canonical, structured JSON; the model sees actionable diagnostics instead of raw compiler stderr.

## 2. Goals and non-goals

Goals:

- Make Java compile/run/test a single tool call in a DSH session.
- Normalize compiler output into diagnostics with positions and a parse-coverage signal.
- Handle encoding, locale, timeouts, heap limits, and process-tree termination correctly on every supported host.
- Consume DSH's sandbox seam so file effects follow the session policy.

Non-goals for the MVP:

- Maven or Gradle project builds.
- Network isolation or a Docker backend.
- A client-side config card; configuration is host-side and set through the profile.
- Being a sandbox backend.

## 3. Scenarios

- Validate generated Java code in conversation ("write a program that computes X and prove it runs").
- Check algorithm implementations against test inputs.
- Agent self-repair loop: generate → `java_test` → read structured failures → fix → rerun.
- Content demos where the agent writes, runs, and fixes Java live.

## 4. Tool surface

### `java_env`

Input: none.

Output: `resolved` (the candidate `java_compile`/`java_run` will use, or null), `candidates` (source, home, javac/java paths, version, vendor, probe error), and `guidance` when no candidate works. Candidates come from `javacPath`, `javaHome`, `JAVA_HOME`, and `PATH`, deduplicated by home. Both `javac -version` and `java -XshowSettings:properties -version` are probed; discoveries are cached for 30 seconds.

### `java_compile`

Input:

- `files`: entries of `{ path, content? }`; a missing `content` means "read from the session workspace".
- `release?`: Java release for `javac --release` (8–99).
- `classpath?`: additional classpath entries; relative entries resolve against the workspace.
- `keepWorkdir?`: retain the scratch directory.

Output: `success`, `exitCode`, `diagnostics`, `unknownLines`, `coverage`, `durationMs`, `workdir`, `outDir`, `retained`, `retainedReason`, `sandbox`, `sandboxDenied`, `runnerFailure`, `outputTruncated`, and spill paths.

### `java_run`

Input: `main` (required), optional `files`, `args`, `stdin`, `timeoutMs`, `maxHeapMb`, `release`, `classpath`, `keepWorkdir`.

Output: `success`, `timedOut`, `exitCode`, `signal`, `stdout`, `stderr`, truncation facts and spill paths, `durationMs`, `main`, the `compile` summary (or null when no files were given), `workdir`, `retained`, `retainedReason`, `sandbox`, `sandboxDenied`, and `runnerFailure`. Compilation failure returns `success: false`, a null exit code, and the compile diagnostics without starting the JVM.

### `java_test`

Input: `files` (required; production and test sources), optional `tests` selectors (`com.example.FooTests` or `com.example.FooTests#method`), `classpath`, `timeoutMs`, `maxHeapMb`, `release`, and `keepWorkdir`.

Output: `success`, `timedOut`, `exitCode`, `durationMs`, `total`, `passed`, `failed`, `skipped`, `failures` (test id, message, stack trace), `reportFiles`, the `compile` summary, `jar` (path, version, source), `reportsDir`, `workdir`, `outDir`, retention facts, console `stdout`/`stderr` with truncation and spill paths, and sandbox facts. A compile failure returns `success: false` with the diagnostics and does not start the JUnit process; a run that discovers no tests also fails (`--fail-if-no-tests`).

## 5. Execution pipeline

1. Resolve the JDK: configured `javacPath` → configured `javaHome` → `JAVA_HOME` → `PATH`; probe each candidate and cache the discovery for 30 seconds.
2. For `java_test`, resolve the JUnit console jar: `junitJarPath` → `~/.m2` → the verified host cache → a SHA-256-verified download (ADR-0008).
3. Create the scratch directory with `mkdtemp` under `<workspace>/.dsh-java/` (or `scratchRoot`), including `classes/` and, for tests, `reports/`.
4. Materialize sources: inline content is written as-is; path-only entries are read from the workspace after boundary validation.
5. Compile with `javac` into `classes/`, then run with `java -cp` from the workspace root. Tests compile against the JUnit jar and run through the console launcher with `--reports-dir` pointing into the scratch directory.
6. Resolve the sandbox policy for the session. Under `read-only` or `workspace-write`, confine the argv with `ctx.sandbox.confine`; under `danger-full-access`, spawn the raw argv. A confined mode with no sandbox provider fails closed.
7. Spawn with `ctx.subprocess.spawn({ argv, cwd, stdio, graceMs, signal, env })`, enforce the timeout by aborting the signal (the provider terminates the managed process range), and collect capped stdout and stderr with 8 MiB spill files.
8. Parse diagnostics, compute coverage, and collect unclassified lines. For tests, parse the JUnit XML reports into totals and failures.
9. Return the canonical JSON value; render model text and a terminal card for `java_run`/`java_test`.
10. Delete the scratch directory on success unless `keepWorkdir`; retain it on failure, timeout, truncation, or unclassified compiler output (ADR-0007).

## 6. Encoding and locale invariants

All Java subprocesses run in English with UTF-8 I/O (ADR-0002):

- `javac`: `-encoding UTF-8 -XDrawDiagnostics -J-Duser.language=en -J-Duser.country=US -J-Dfile.encoding=UTF-8 -J-Dstdout.encoding=UTF-8 -J-Dstderr.encoding=UTF-8 -J-Dsun.stdout.encoding=UTF-8 -J-Dsun.stderr.encoding=UTF-8`
- `java`: the `-D` forms of `user.language`, `user.country`, `file.encoding`, `stdout.encoding`, `stderr.encoding`, `sun.stdout.encoding`, and `sun.stderr.encoding`

`java_test` reuses the `java` option set for the JUnit launcher, so console output and XML report metadata stay UTF-8 and English.

The plugin also tombstones `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`, and `_JAVA_OPTIONS` in child environments so ambient flags cannot change parser-relevant output.

`-XDrawDiagnostics` emits `file:line:column: compiler.err.key: args`, which gives exact positions and stable codes without parsing prose. Source-file mode rejects this option and reports no columns or codes, so the runner always compiles with `javac` (ADR-0006).

## 7. Diagnostics contract

A diagnostic is a normalized compiler message, not a line of stderr. The contract has three parts:

- `diagnostics`: records with file, line, column, severity, code, and message. File-less diagnostics (for example, a bad classpath element) keep a null position.
- `unknownLines`: output that no rule matched, returned verbatim.
- `coverage`: the share of compiler output classified into diagnostics.

A successful compile with empty output reports full coverage. A parser gap must surface as `unknownLines`; it must never be silently treated as success. Parsing is English-only by construction (ADR-0002) and reads javac's machine-readable format (ADR-0006).

## 8. Input boundary

Sources are either inline content or workspace-relative paths (ADR-0003). The host process reads path-only entries outside the sandbox, so the plugin enforces containment itself:

- Resolve the real path before checking containment.
- Reject absolute paths.
- Reject `..` traversal after resolution.
- Reject symlinks that resolve outside the workspace.
- Copy accepted files into the scratch directory before compiling.

## 9. Isolation and limits

| Layer | Provided by | Behavior |
| --- | --- | --- |
| File writes | DSH sandbox | `read-only` / `workspace-write`; `danger-full-access` bypasses confinement |
| Time | Plugin | `timeoutMs`; the abort signal makes the subprocess provider terminate its managed process range |
| Heap | Plugin | `-Xmx` |
| Directory | Plugin | Per-call scratch directory, deleted on success (ADR-0007) |
| Output | Plugin | 128–512 KiB in-memory caps plus 8 MiB spill files; truncation is reported |
| Source reads | Plugin | Inline content or workspace-contained paths (ADR-0003) |
| Network | Not isolated | Java code can open sockets |
| Fork bombs | Not prevented | Documented limitation |

The plugin surfaces DSH's enforcement facts (`enforcement`, denial signatures, runner-failure rules) rather than claiming absolute isolation.

## 10. Configuration

Deployment-specific values are configuration, with defaults in the schema:

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `javaHome` | string? | auto-detect | Select a JDK |
| `javacPath` | string? | auto-detect | Override the compiler executable |
| `timeoutMs` | number | 15000 | Default execution timeout |
| `maxHeapMb` | number | 256 | Default `-Xmx` |
| `scratchRoot` | string? | `<workspace>/.dsh-java` | Scratch root |
| `junitJarPath` | string? | m2 → cache → verified download | JUnit console launcher jar |

The plugin receives configuration as the second `apply(ctx, config)` argument. Invalid configuration fails plugin load.

There is no `networkAllowed` flag: the plugin cannot enforce network policy, so a configuration key would imply a guarantee it does not provide.

## 11. Packaging and distribution

- ESM package with a built `lib/index.js` and a `cordis.patch.yml` bundle patch.
- `engines.dsh` is `>=0.2.1-rc.5 <0.3.0`; the verified runtime is 0.2.1-rc.5.
- DSH packages are optional peer dependencies plus dev dependencies; at runtime they resolve from the host installation.
- npm publishes prebuilt artifacts. A GitHub tarball is the secondary channel and needs a self-contained `prepare` plus the user's `allowBuilds`.
- A source checkout can load the plugin with `--patch`. The Electron desktop profile loads a development checkout through a `link:` dependency listed in `dsh.profile.bundles`; rebuild and restart the app to pick up changes. The CLI cannot boot the desktop profile directly.

## 12. Phases and acceptance

Implemented in `0.1.0-alpha.0`:

- The plugin builds and registers `java_env`, `java_compile`, `java_run`, and `java_test` in a real `ToolRuntime` with the local subprocess provider.
- `java_env` discovers the JDK from config, `JAVA_HOME`, or `PATH`, probes its version and vendor, and reports failed candidates.
- `java_run` compiles and runs multi-file programs, passes arguments and stdin, accepts Unicode class names, and returns a terminal card presenter.
- `java_compile` returns structured diagnostics with file, line, column, severity, code, and message; non-ASCII identifiers survive on a zh-CN Windows host.
- Timeout aborts and terminates the managed process range; the heap cap produces `OutOfMemoryError` under a 16 MiB cap.
- `read-only`/`workspace-write` calls are confined; `workspace-write` results report the provider's enforcement value.
- Scratch directories are removed on success and retained with a reason on failure (ADR-0007).
- `java_test` compiles production and test sources against the pinned JUnit console jar, runs scanned or selected tests, and returns totals plus failures with stack traces. The jar resolves through `junitJarPath`, m2, the verified cache, or a verified download (ADR-0008).
- JUnit XML parsing covers passing, failing, erroring, and skipped cases, CDATA stack traces, XML entities, and Unicode test names.
- A fake-JDK harness replaces the subprocess service with canned `javac`/`java` results, so the full compile/run/test path is covered deterministically without a local JDK or network. GitHub Actions runs typecheck, tests, and build on Ubuntu and Windows without installing a JDK.
- The plugin loads in the Electron desktop app through the bundled profile patch with a `link:` dependency in the desktop profile.

Outstanding before the probe release:

- Verify `workspace-write` confinement in the Electron desktop app, not only in the test harness.
- Publish the probe release and collect feedback.

Phase 2 (implemented): `java_test` with a pinned JUnit 5 console jar. A client-side config card remains deferred; configuration is set host-side through the profile.

Phase 3: Maven/Gradle delegation, JShell or a hot JVM, an optional Docker backend for network isolation.

## 13. Testing

- Unit: `javac` diagnostic parser (positions, file-less diagnostics, Windows drive paths, coverage, unknown lines) and JUnit XML parser (failures, errors, skipped cases, CDATA, entities, Unicode, missing directory).
- Integration: real `ToolRuntime` + `LocalSubprocessRuntime` + a temporary workspace; JDK-dependent cases skip when `javac` is absent. JUnit cases additionally require JDK 17+ and a resolvable console jar.
- Fake-JDK: a fake `subprocess` service returns canned `javac`/`java` output, rejects or delays commands on demand, and records every argv/stdin/env/cwd. It covers JDK discovery and failure, compile diagnostics, run argv and stdin, nonzero exits, timeout termination, sandbox confinement, JUnit totals and failures, no-tests failure, and compile-failure short circuit without a JDK. A fake executable was rejected because the Windows provider resolves only `.com`/`.exe`, so a portable fake needs the service seam.
- Covered: multi-file compile, cleanup and retention, structured errors, non-ASCII diagnostics and program output, stdin/args, nonzero exits, timeout termination, heap cap, sandbox confinement, the input boundary, and `java_test` pass/fail/skip totals, failure stack traces, method selectors, no-tests failure, compile-failure short circuit, and test timeout.
- CI: `.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile`, typecheck, test, and build on Ubuntu and Windows with Node 24 and pnpm 10.12.1. No JDK is installed, so the real-JDK suites skip and the fake-JDK suite provides coverage.
- Planned: a Windows/Linux CI matrix that installs JDK 17 and 21 and seeds the JUnit jar to exercise the real-JDK suites.

## 14. Risks

| Risk | Mitigation |
| --- | --- |
| DSH developer preview breaks APIs | Pin `engines.dsh`; run integration tests against release candidates |
| No JDK on the user's machine | `java_env` returns installation guidance instead of `ENOENT` |
| JUnit jar availability | Pinned version and SHA-256; m2 → verified cache → verified download (ADR-0008); `junitJarPath` covers offline deployments |
| JUnit requires JDK 17+ | Documented requirement; the probe reports the resolved JDK |
| The model prefers bash | Tool descriptions state the Java-specific benefits; README shows a conversation example |
| Incomplete sandbox coverage on Windows | Return enforcement facts; do not claim absolute isolation |
| Tool name collisions | Verify DSH tool naming rules before publishing |

## 15. Open questions

- Whether a client config card is worth adding after profile-based configuration is documented for users.
- Tool naming and collision rules in DSH 0.2.1 beyond the reserved `run_code`.

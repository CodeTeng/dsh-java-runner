# dsh-java-runner — design

Status: draft, 2026-11-01. Verified against DSH 0.2.1-rc.5. Decisions live in `docs/adr/`; if this document contradicts an ADR, the ADR wins.

## 1. Summary

`dsh-java-runner` is a DeepSeek Harness plugin that gives an agent session first-class Java execution: discover JDKs, compile source, run a Java entry point, run JUnit 5 tests, delegate project tests to Maven or Gradle, and evaluate JShell snippets. Every tool returns canonical, structured JSON; the model sees actionable diagnostics instead of raw compiler stderr. When `dockerImage` is configured, user code runs inside a container with optional network isolation.

## 2. Goals and non-goals

Goals:

- Make Java compile/run/test/evaluate a single tool call in a DSH session.
- Normalize compiler output into diagnostics with positions and a parse-coverage signal.
- Handle encoding, locale, timeouts, heap limits, and process-tree termination correctly on every supported host.
- Consume DSH's sandbox seam so file effects follow the session policy.
- Defer to Maven and Gradle for project tests instead of reimplementing a build system (ADR-0009).
- Offer an opt-in Docker execution path for user code, including network isolation (ADR-0011).

Non-goals:

- A persistent REPL or hot JVM; `java_eval` is one-shot (ADR-0010).
- Compiling or building projects inside the Docker container.
- Managing Docker images, dependency caches, or a container daemon.
- A client-side config card; configuration is host-side and set through the profile.
- Being a sandbox backend; the plugin consumes DSH's policy and reports its facts.

## 3. Scenarios

- Validate generated Java code in conversation ("write a program that computes X and prove it runs").
- Check algorithm implementations against test inputs.
- Probe a library or JDK API with `java_eval` before writing a full class.
- Agent self-repair loop: generate → `java_test` → read structured failures → fix → rerun.
- Run an existing Maven or Gradle project's test suite without leaving the session.
- Demo untrusted or network-sensitive code inside a container with no network.
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

### `java_project_test`

Input: workspace-relative `directory` (default `.`), optional `system` (`auto`, `maven`, `gradle`), `offline`, `timeoutMs` (default `buildTimeoutMs`), and `keepWorkdir`.

Output: `success`, `timedOut`, `exitCode`, `signal`, `durationMs`, `system`, `command`, `projectDir`, `wrapper` (whether the project wrapper was used), `jdkHome`, test totals and `failures`, `reportFiles`, `workdir`/retention facts, build `stdout`/`stderr` with truncation and spill paths, and sandbox facts. Compilation, dependency resolution, and report generation belong to the build tool (ADR-0009). A build with no parsed reports is a failure even when the exit code is zero.

### `java_eval`

Input: `code` (required JShell script), optional `classpath`, `timeoutMs`, `maxHeapMb`, and `keepWorkdir`.

Output: `success`, `timedOut`, `exitCode`, `durationMs`, `jshell` (executable), `stdout`, `stderr`, `errors` (stderr lines starting with `Error:` or an exception), `classpath`, `workdir`, `scriptPath`, retention facts, truncation and spill paths, sandbox facts, and `docker` facts. One script runs per call in a fresh JShell process (ADR-0010); JShell exits 0 even when snippets fail, so `errors` participates in success. When `dockerImage` is configured, `java_run`, `java_test`, and `java_eval` report a `docker` record with the image, network mode, and container name; `java_compile` and `java_project_test` do not use Docker.

## 5. Execution pipeline

1. Resolve the sandbox policy for the session and take `workspaceRoot` from it.
2. Resolve the JDK: configured `javacPath` → configured `javaHome` → `JAVA_HOME` → `PATH`; probe each candidate and cache the discovery for 30 seconds. `java_eval` skips this step when Docker execution is configured; every other path compiles or builds on the host and therefore needs it.
3. For `java_test`, resolve the JUnit console jar: `junitJarPath` → `~/.m2` → the verified host cache → a SHA-256-verified download (ADR-0008).
4. For `java_project_test`, resolve the workspace-contained project directory, detect Maven or Gradle (or require `system` when both exist), and build the invocation: project wrapper first (`mvnw`/`mvnw.cmd`, `gradlew`/`gradlew.bat`), then `PATH`. Windows `.cmd`/`.bat` invocations go through `cmd.exe /d /s /c`.
5. Create scratch state: `createScratch` adds `classes/` and `reports/` for source tools; `createWorkdir` holds only build logs and spill files for `java_project_test`. Both live under `<workspace>/.dsh-java/` or `scratchRoot`.
6. Materialize sources: inline content is written as-is; path-only entries are read from the workspace after boundary validation. `java_eval` writes `snippet.jsh`.
7. Host compilation: run `javac` into `classes/`. Tests compile production and test sources against the JUnit jar, then run the console launcher with `--reports-dir` inside the scratch directory. When Docker execution is configured and the call has user code to execute, the plugin maps classpath entries (scratch → `/dsh-work`, workspace → `/workspace`, JUnit jar → `/dsh-libs/junit.jar`, external entries → `/dsh-libs/cp-N`) and launches the container (ADR-0011). `java_project_test` always runs the build tool on the host.
8. Resolve the sandbox policy for the spawned process. Under `read-only` or `workspace-write`, confine the argv with `ctx.sandbox.confine`; under `danger-full-access`, spawn the raw argv. A confined mode with no sandbox provider fails closed. The Docker CLI is confined by the same policy, and the container mounts the workspace `ro` under `read-only`.
9. Spawn with `ctx.subprocess.spawn({ argv, cwd, stdio, graceMs, signal, env })`, enforce the timeout by aborting the signal (the provider terminates the managed process range), and collect capped stdout and stderr with 8 MiB spill files. On a Docker timeout or abort, best-effort `docker rm --force` the container.
10. Parse outputs: javac diagnostics and coverage; JUnit XML totals and failures for `java_test`; surefire/Gradle XML for `java_project_test`; JShell stdout plus `Error:`/exception lines for `java_eval`.
11. Return the canonical JSON value; render model text and a terminal card.
12. Delete the scratch directory on success unless `keepWorkdir`; retain it on failure, timeout, truncation, or unclassified compiler output (ADR-0007). A project build that parses no reports is a failure and retains the log directory.

## 6. Encoding and locale invariants

All Java subprocesses run in English with UTF-8 I/O (ADR-0002):

- `javac`: `-encoding UTF-8 -XDrawDiagnostics -J-Duser.language=en -J-Duser.country=US -J-Dfile.encoding=UTF-8 -J-Dstdout.encoding=UTF-8 -J-Dstderr.encoding=UTF-8 -J-Dsun.stdout.encoding=UTF-8 -J-Dsun.stderr.encoding=UTF-8`
- `java`: the `-D` forms of `user.language`, `user.country`, `file.encoding`, `stdout.encoding`, `stderr.encoding`, `sun.stdout.encoding`, and `sun.stderr.encoding`

`java_test` reuses the `java` option set for the JUnit launcher, so console output and XML report metadata stay UTF-8 and English. `java_eval` passes the same option set through `-J` (JShell front end) and `-R` (execution engine). `java_project_test` sets `MAVEN_OPTS` or `GRADLE_OPTS` to the English/UTF-8 properties, exports a resolver-selected `JAVA_HOME`, and invokes the build with plain/no-color flags.

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
| Time | Plugin | `timeoutMs`; the abort signal makes the subprocess provider terminate its managed process range; Docker containers are force-removed after a timeout |
| Heap | Plugin | `-Xmx` |
| Directory | Plugin | Per-call scratch directory, deleted on success (ADR-0007) |
| Output | Plugin | 128–512 KiB in-memory caps plus 8 MiB spill files; truncation is reported |
| Source reads | Plugin | Inline content or workspace-contained paths (ADR-0003) |
| Network (host) | Not isolated | Java code can open sockets |
| Network (Docker) | Docker, optional | `dockerNetwork: none` by default; set `bridge` to opt in |
| Filesystem (Docker) | Docker, optional | Only the workspace, scratch, JUnit jar, and external classpath entries are mounted; no host environment is passed into the container; workspace mount is `ro` under `read-only` |
| Fork bombs | Not prevented | Documented limitation on the host and in the container |

The plugin surfaces DSH's enforcement facts (`enforcement`, denial signatures, runner-failure rules) rather than claiming absolute isolation. Docker is an operator-provided extra boundary, not a sandbox backend: the Docker CLI still runs under DSH's policy, mounts enforce the workspace access mode, and the plugin cannot constrain how the image itself is built or what privileges the Docker daemon grants.

## 10. Configuration

Deployment-specific values are configuration, with defaults in the schema:

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `javaHome` | string? | auto-detect | Select a JDK |
| `javacPath` | string? | auto-detect | Override the compiler executable |
| `timeoutMs` | number | 15000 | Default execution timeout |
| `buildTimeoutMs` | number | 120000 | Default `java_project_test` timeout |
| `maxHeapMb` | number | 256 | Default `-Xmx` |
| `scratchRoot` | string? | `<workspace>/.dsh-java` | Scratch root |
| `junitJarPath` | string? | m2 → cache → verified download | JUnit console launcher jar |
| `dockerImage` | string? | unset (host execution) | Run `java_run`, `java_test`, and `java_eval` user code in this image |
| `dockerNetwork` | `none` \| `bridge` | `none` | Network mode for the execution container |

The plugin receives configuration as the second `apply(ctx, config)` argument. Invalid configuration fails plugin load.

`dockerNetwork` is meaningful only when `dockerImage` is set. Host execution has no network policy and the plugin does not pretend otherwise; the Docker backend is the supported way to remove network access, and `none` is its default.

## 11. Packaging and distribution

- ESM package with a built `lib/index.js` and a `cordis.patch.yml` bundle patch.
- `engines.dsh` is `>=0.2.1-rc.5 <0.3.0`; the verified runtime is 0.2.1-rc.5.
- DSH packages are optional peer dependencies plus dev dependencies; at runtime they resolve from the host installation.
- npm publishes prebuilt artifacts. A GitHub tarball is the secondary channel and needs a self-contained `prepare` plus the user's `allowBuilds`.
- A source checkout can load the plugin with `--patch`. The Electron desktop profile loads a development checkout through a `link:` dependency listed in `dsh.profile.bundles`; rebuild and restart the app to pick up changes. The CLI cannot boot the desktop profile directly.

## 12. Phases and acceptance

Implemented in the current unreleased tree (package version `0.1.0-alpha.0`):

Phase 1 — compile, run, environment:

- The plugin builds and registers `java_env`, `java_compile`, and `java_run` in a real `ToolRuntime` with the local subprocess provider.
- `java_env` discovers the JDK from config, `JAVA_HOME`, or `PATH`, probes its version and vendor, and reports failed candidates.
- `java_run` compiles and runs multi-file programs, passes arguments and stdin, accepts Unicode class names, and returns a terminal card presenter.
- `java_compile` returns structured diagnostics with file, line, column, severity, code, and message; non-ASCII identifiers survive on a zh-CN Windows host.
- Timeout aborts and terminates the managed process range; the heap cap produces `OutOfMemoryError` under a 16 MiB cap.
- `read-only`/`workspace-write` calls are confined; `workspace-write` results report the provider's enforcement value.
- Scratch directories are removed on success and retained with a reason on failure (ADR-0007).

Phase 2 — JUnit:

- `java_test` compiles production and test sources against the pinned JUnit console jar, runs scanned or selected tests, and returns totals plus failures with stack traces. The jar resolves through `junitJarPath`, m2, the verified cache, or a verified download (ADR-0008).
- JUnit XML parsing covers passing, failing, erroring, and skipped cases, CDATA stack traces, XML entities, and Unicode test names.
- A fake subprocess harness replaces the service with canned results, so the full compile/run/test path is covered deterministically without a local JDK or network. GitHub Actions runs typecheck, tests, and build on Ubuntu and Windows without installing a JDK.
- The plugin loads in the Electron desktop app through the bundled profile patch with a `link:` dependency in the desktop profile.

Phase 3 — projects, JShell, Docker:

- `java_project_test` detects Maven or Gradle, prefers project wrappers, falls back to `PATH`, applies a longer build timeout and offline mode, and parses surefire/Gradle XML into the same totals and failure records as `java_test` (ADR-0009).
- `java_eval` runs one JShell script per call with classpath, heap cap, timeout, and error detection from JShell output (ADR-0010).
- Setting `dockerImage` runs user code from `java_run`, `java_test`, and `java_eval` in a container with no host environment passed in, constrained mounts, and `--network none` by default; timeouts force-remove the container (ADR-0011). Compilation and `java_project_test` stay on the host.
- The fake harness covers project detection and report parsing, JShell argv/output handling, Docker argv/mount/network/classpath mapping, and container cleanup, so CI still runs without Maven, Gradle, or Docker.

Outstanding before the probe release:

- Verify `workspace-write` confinement in the Electron desktop app, not only in the test harness.
- Verify `java_project_test` against a real Maven project and a real Gradle project on Windows and Linux.
- Verify Docker execution against a running daemon and a real `eclipse-temurin` image, including bind mounts and `--network none`.
- Publish the probe release and collect feedback.

## 13. Testing

- Unit: `javac` diagnostic parser (positions, file-less diagnostics, Windows drive paths, coverage, unknown lines), JUnit XML parser (failures, errors, skipped cases, CDATA, entities, Unicode, missing directory), JShell output cleaning and error extraction, project report discovery, and Docker path mapping.
- Integration: real `ToolRuntime` + `LocalSubprocessRuntime` + a temporary workspace; JDK-dependent cases skip when `javac` is absent. JUnit cases additionally require JDK 17+ and a resolvable console jar. JShell cases require a full JDK with `jshell`.
- Fake-JDK: a fake `subprocess` service returns canned `javac`/`java`/`jshell`/`mvn`/`gradle`/`docker` output, rejects or delays commands on demand, and records every argv/stdin/env/cwd. It covers JDK discovery and failure, compile diagnostics, run argv and stdin, nonzero exits, timeout termination, sandbox confinement, JUnit totals and failures, no-tests failure, compile-failure short circuit, Maven/Gradle detection, wrapper preference, report parsing, JShell argv/cleaning/errors, and Docker mounts, network mode, classpath mapping, and timeout cleanup without a local JDK, Maven, Gradle, or Docker.
- Covered: multi-file compile, cleanup and retention, structured errors, non-ASCII diagnostics and program output, stdin/args, nonzero exits, timeout termination, heap cap, sandbox confinement, the input boundary, `java_test` pass/fail/skip totals, failure stack traces, method selectors, no-tests failure, compile-failure short circuit, and test timeout; project offline flags, ambiguous build files, missing build files, and no-report builds; and Docker read-only workspace mounts and external classpath entries.
- CI: `.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile`, typecheck, test, and build on Ubuntu and Windows with Node 24 and pnpm 10.12.1. No JDK, Maven, Gradle, or Docker daemon is installed, so the real-tool suites skip and the fake suite provides coverage.
- Planned: a Windows/Linux CI matrix that installs JDK 17 and 21 and seeds the JUnit jar to exercise the real-JDK suites. Real Maven, Gradle, and Docker remain desktop acceptance items because their daemons, caches, and images are environment-specific.

## 14. Risks

| Risk | Mitigation |
| --- | --- |
| DSH developer preview breaks APIs | Pin `engines.dsh`; run integration tests against release candidates |
| No JDK on the user's machine | `java_env` returns installation guidance instead of `ENOENT` |
| JUnit jar availability | Pinned version and SHA-256; m2 → verified cache → verified download (ADR-0008); `junitJarPath` covers offline deployments |
| JUnit requires JDK 17+ | Documented requirement; the probe reports the resolved JDK |
| No Maven/Gradle or wrapper | Error names the missing tool and points to the wrapper; `offline` uses cached dependencies; `java_test` remains the ad-hoc path |
| Project builds produce no XML reports | Treated as failure with build output and guidance, never as a green run |
| JShell suppresses bare values and exits 0 on errors | Tool description states the `System.out.println` rule; stderr is scanned for `Error:`/exceptions and counts toward success |
| Docker daemon or image missing | A missing `docker` binary gets an explicit plugin error; daemon or image failures surface `docker run` stderr and the exit code. When `dockerImage` is unset the host path is unchanged |
| Docker bind mounts on Windows | Paths are mapped explicitly and covered by fake tests; real-daemon validation is a desktop acceptance item |
| Docker is mistaken for a sandbox | Documented as an optional extra boundary with reported facts; the Docker CLI still runs under DSH's policy |
| The model prefers bash | Tool descriptions state the Java-specific benefits; README shows a conversation example |
| Incomplete sandbox coverage on Windows | Return enforcement facts; do not claim absolute isolation |
| Tool name collisions | Verify DSH tool naming rules before publishing |

## 15. Open questions

- Whether a client config card is worth adding after profile-based configuration is documented for users.
- Whether `java_project_test` should support container execution for projects with a prepared dependency cache.
- Tool naming and collision rules in DSH 0.2.1 beyond the reserved `run_code`.

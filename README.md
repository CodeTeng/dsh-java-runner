# dsh-java-runner

Java compile, run, test, and evaluate tools for [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/).

> **Status: alpha.** `java_env`, `java_compile`, `java_run`, `java_test`, `java_project_test`, and `java_eval` are implemented and covered by a deterministic fake-tool suite plus local JDK integration tests. Docker execution is opt-in and covered by fake-process tests. The plugin is not published yet; schemas may change before the probe release.

## Why

Bash can invoke `javac`, but agent sessions systematically get five things wrong:

1. **Encoding and locale.** On zh-CN Windows, `javac` reports errors in GBK and captured `System.out` follows the console encoding; decoding either as UTF-8 produces mojibake. The plugin pins UTF-8 for source, diagnostics, and program output, and forces an English locale.
2. **Raw stderr is not actionable.** The plugin returns diagnostics as structured records, plus every line it could not parse, so a parser gap never looks like a successful compile.
3. **JUnit orchestration.** Finding the standalone jar, building the classpath, scanning tests, parsing XML, and extracting failure stack traces are easy to get subtly wrong in every session (ADR-0008).
4. **Project builds.** Wrappers, `PATH` fallbacks, offline flags, multi-module report directories, and "the build succeeded but no tests ran" are handled once (ADR-0009).
5. **Process hygiene.** Timeouts, heap limits, process-range termination, scratch isolation, output caps, the Windows command-line limit, and Docker container cleanup are handled in one place.

## Tools

| Tool | Purpose | Status |
| --- | --- | --- |
| `java_env` | Report the resolved JDK and the candidates probed from config, `JAVA_HOME`, and `PATH` | Implemented |
| `java_compile` | Compile inline or workspace-relative sources; return structured diagnostics | Implemented |
| `java_run` | Compile if needed and run a Java entry point with args, stdin, timeout, and heap cap | Implemented |
| `java_test` | Compile sources and run JUnit 5 tests; return totals and failures with stack traces | Implemented |
| `java_project_test` | Run an existing Maven or Gradle project's tests through its build tool | Implemented |
| `java_eval` | Evaluate one JShell script with classpath, timeout, and heap cap | Implemented |

Maven and Gradle are used only through `java_project_test`; the plugin does not manage dependencies or caches. `java_eval` is one-shot: definitions do not carry over between calls, bare expression values are not printed (use `System.out.println`), and JShell exits 0 on errors, so the tool detects them from its output.

## Execution model

- Every source run compiles with `javac` into a scratch directory, then runs with `java -cp`.
- Compiler output is requested in javac's machine-readable diagnostic format, so every diagnostic carries an exact position and a stable code.
- `java_project_test` resolves the project directory inside the workspace, prefers the checked-in wrapper, and runs `test` through Maven or Gradle on the host. Surefire and Gradle XML reports are parsed after the build; a build that produces no reports is a failure, not a green run.
- `java_eval` writes one script and runs `jshell --feedback concise` per call. Errors and exceptions are read from stderr because JShell returns exit code 0 even when snippets fail.
- Scratch directories live under `<workspace>/.dsh-java/` and are deleted after a clean success; failures, timeouts, truncated output, and `keepWorkdir` retain them with an explicit `retainedReason`.
- `java_test` compiles production and test sources against a pinned JUnit Platform console launcher, then parses its XML reports. The jar comes from `junitJarPath`, `~/.m2`, a SHA-256-verified host cache (`~/.dsh-java-runner/junit/`), or a verified Maven Central download. Offline machines should set `junitJarPath` or rely on m2.
- Setting `dockerImage` switches user code from `java_run`, `java_test`, and `java_eval` into `docker run`; compilation stays on the host, and `java_project_test` never uses Docker. The container gets only the workspace, scratch directory, JUnit jar, and external classpath entries as mounts, no host environment, and `--network none` by default. Timeouts force-remove the container.
- The plugin consumes DSH's sandbox seam; it does not provide a sandbox backend.

## Isolation and limits

| Layer | Provided by | Notes |
| --- | --- | --- |
| File writes | DSH sandbox | `read-only` and `workspace-write` policies; enforcement facts are reported |
| Time | Plugin | `timeoutMs`; aborting the signal terminates the provider's managed process range; Docker containers are force-removed after a timeout |
| Heap | Plugin | `-Xmx` |
| Directory | Plugin | Per-call scratch directory; the user's project is not polluted |
| Output | Plugin | In-memory caps (128–512 KiB) plus 8 MiB spill files; truncation is explicit |
| Source reads | Plugin | Inline content, or paths contained by the session workspace |
| Network (host) | **Not isolated** | Java code can open sockets |
| Network (Docker) | Docker, optional | `dockerNetwork: none` by default; set `bridge` to opt in |
| Container filesystem | Docker, optional | Only the workspace, scratch, JUnit jar, and external classpath entries are mounted; workspace is `ro` under `read-only` |
| Fork bombs | **Not prevented** | Do not run untrusted code in a privileged session |

The plugin reports the sandbox enforcement facts returned by DSH. It does not claim absolute isolation. Docker is an optional extra boundary, not a sandbox backend: the Docker CLI still runs under DSH's policy, and the plugin cannot constrain how the image is built.

## Requirements

- DSH 0.2.1.x
- JDK 17 or newer; JDK 17 is verified locally. `java_eval` needs a full JDK that includes `jshell` (or an image that does).
- Maven or Gradle only when using `java_project_test`; the project wrapper can supply it.
- Docker only when `dockerImage` is set, with the image already pulled.
- Windows and Linux are primary targets; macOS is best-effort.

## Configuration

Host configuration:

| Key | Default | Purpose |
| --- | --- | --- |
| `javaHome` | auto-detect | Select a JDK |
| `javacPath` | auto-detect | Override the compiler executable |
| `timeoutMs` | `15000` | Default execution timeout |
| `buildTimeoutMs` | `120000` | Default `java_project_test` timeout |
| `maxHeapMb` | `256` | Default `-Xmx` |
| `scratchRoot` | `<workspace>/.dsh-java` | Scratch directory root |
| `junitJarPath` | m2 → verified cache → download | JUnit console launcher jar used by `java_test` |
| `dockerImage` | unset | Run `java_run`, `java_test`, and `java_eval` user code in this image, for example `eclipse-temurin:17-jdk` |
| `dockerNetwork` | `none` | Container network mode: `none` or `bridge` |

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` runs a fake-tool harness that needs no JDK, Maven, Gradle, Docker, or network access: a fake subprocess service returns canned `javac`/`java`/`jshell`/`mvn`/`gradle`/`docker` output, so compile, run, test, project, eval, and Docker paths are deterministic on any machine. Real-JDK integration tests run additionally when `javac` is on `PATH`; `java_test` cases require JDK 17+ and a JUnit jar in `~/.m2`, `~/.dsh-java-runner/junit/`, or `JUNIT_JAR`, and `java_eval` cases require `jshell`. CI runs typecheck, tests, and build on Ubuntu and Windows without installing a JDK. Real Maven, Gradle, and Docker runs are desktop acceptance items, not CI steps.

For local development, the Electron desktop profile loads the plugin through its bundle patch: add a `link:` dependency on this checkout to `~/.dsh/profiles/desktop/package.json`, list `dsh-java-runner` under `dsh.profile.bundles`, install with the pnpm bundled with the app, and restart the app.

## License

MIT

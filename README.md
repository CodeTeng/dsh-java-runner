# dsh-java-runner

Java compile, run, and test tools for [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/).

> **Status: alpha.** `java_env`, `java_compile`, `java_run`, and `java_test` are implemented and covered by a deterministic fake-JDK suite plus local JDK integration tests. The plugin is not published yet; schemas may change before the probe release.

## Why

Bash can invoke `javac`, but agent sessions systematically get four things wrong:

1. **Encoding and locale.** On zh-CN Windows, `javac` reports errors in GBK and captured `System.out` follows the console encoding; decoding either as UTF-8 produces mojibake. The plugin pins UTF-8 for source, diagnostics, and program output, and forces an English locale.
2. **Raw stderr is not actionable.** The plugin returns diagnostics as structured records, plus every line it could not parse, so a parser gap never looks like a successful compile.
3. **JUnit orchestration.** Finding the standalone jar, building the classpath, scanning tests, parsing XML, and extracting failure stack traces are easy to get subtly wrong in every session (ADR-0008).
4. **Process hygiene.** Timeouts, heap limits, process-range termination, scratch isolation, output caps, and the Windows command-line limit are handled once, in one place.

## Tools

| Tool | Purpose | Status |
| --- | --- | --- |
| `java_env` | Report the resolved JDK and the candidates probed from config, `JAVA_HOME`, and `PATH` | Implemented |
| `java_compile` | Compile inline or workspace-relative sources; return structured diagnostics | Implemented |
| `java_run` | Compile if needed and run a Java entry point with args, stdin, timeout, and heap cap | Implemented |
| `java_test` | Compile sources and run JUnit 5 tests; return totals and failures with stack traces | Implemented |

Maven and Gradle project builds are out of scope for the MVP.

## Execution model

- Every run compiles with `javac` into a scratch directory, then runs with `java -cp`.
- Compiler output is requested in javac's machine-readable diagnostic format, so every diagnostic carries an exact position and a stable code.
- Scratch directories live under `<workspace>/.dsh-java/` and are deleted after a clean success; failures, timeouts, truncated output, and `keepWorkdir` retain them with an explicit `retainedReason`.
- `java_test` compiles production and test sources against a pinned JUnit Platform console launcher, then parses its XML reports. The jar comes from `junitJarPath`, `~/.m2`, a SHA-256-verified host cache (`~/.dsh-java-runner/junit/`), or a verified Maven Central download. Offline machines should set `junitJarPath` or rely on m2.
- The plugin consumes DSH's sandbox seam; it does not provide a sandbox backend.

## Isolation and limits

| Layer | Provided by | Notes |
| --- | --- | --- |
| File writes | DSH sandbox | `read-only` and `workspace-write` policies; enforcement facts are reported |
| Time | Plugin | `timeoutMs`; aborting the signal terminates the provider's managed process range |
| Heap | Plugin | `-Xmx` |
| Directory | Plugin | Per-call scratch directory; the user's project is not polluted |
| Output | Plugin | In-memory caps (128–512 KiB) plus 8 MiB spill files; truncation is explicit |
| Source reads | Plugin | Inline content, or paths contained by the session workspace |
| Network | **Not isolated** | Java code can open sockets |
| Fork bombs | **Not prevented** | Do not run untrusted code in a privileged session |

The plugin reports the sandbox enforcement facts returned by DSH. It does not claim absolute isolation.

## Requirements

- DSH 0.2.1.x
- JDK 17 or newer; JDK 17 is verified locally
- Windows and Linux are primary targets; macOS is best-effort

## Configuration

Host configuration:

| Key | Default | Purpose |
| --- | --- | --- |
| `javaHome` | auto-detect | Select a JDK |
| `javacPath` | auto-detect | Override the compiler executable |
| `timeoutMs` | `15000` | Default execution timeout |
| `maxHeapMb` | `256` | Default `-Xmx` |
| `scratchRoot` | `<workspace>/.dsh-java` | Scratch directory root |
| `junitJarPath` | m2 → verified cache → download | JUnit console launcher jar used by `java_test` |

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` runs a fake-JDK harness that needs neither a JDK nor network access: a fake subprocess service returns canned `javac`/`java` output, so compile, run, and test paths are deterministic on any machine. Real-JDK integration tests run additionally when `javac` is on `PATH`; `java_test` cases require JDK 17+ and a JUnit jar in `~/.m2`, `~/.dsh-java-runner/junit/`, or `JUNIT_JAR`. CI runs typecheck, tests, and build on Ubuntu and Windows without installing a JDK.

For local development, the Electron desktop profile loads the plugin through its bundle patch: add a `link:` dependency on this checkout to `~/.dsh/profiles/desktop/package.json`, list `dsh-java-runner` under `dsh.profile.bundles`, install with the pnpm bundled with the app, and restart the app.

## License

MIT

# dsh-java-runner

A DSH plugin that compiles, runs, and tests Java code inside an agent session and returns structured results.

## Language

### Execution

**Scratch directory**:
The per-call directory where generated sources, class files, and test artifacts live, isolated from the user's project.
_Avoid_: temp directory, workdir

**Retained scratch directory**:
A scratch directory kept because the call failed, timed out, produced truncated output, or requested `keepWorkdir`, so the caller can inspect sources, class files, and spill files.
_Avoid_: leftover directory, temp cache

**Spill file**:
The complete captured output stream stored in the scratch directory when the in-memory cap truncated it.
_Avoid_: log file, dump

**Workspace-relative input**:
A source file supplied to a tool by its path inside the session workspace, rather than by inline content.
_Avoid_: local file, disk file

**Project test**:
A test run delegated to a project's own Maven or Gradle build, as opposed to the plugin's own compiler and JUnit launcher.
_Avoid_: build test, integration test

**Build wrapper**:
The checked-in `mvnw`/`mvnw.cmd` or `gradlew`/`gradlew.bat` script that a project test prefers over a PATH-installed build tool.
_Avoid_: build script, launcher

**JShell evaluation**:
A single stateless execution of a script through `jshell`; it does not preserve definitions between calls.
_Avoid_: REPL, interactive session

**Execution container**:
The Docker container that runs user code from `java_run`, `java_test`, or `java_eval` when `dockerImage` is configured.
_Avoid_: sandbox, VM

**Container path mapping**:
The translation of host paths into container mount targets for the workspace, scratch directory, JUnit jar, and external classpath entries.
_Avoid_: path rewrite, volume path

### Diagnostics

**Diagnostic**:
A compiler message normalized to a file position, severity, stable code, and human-readable text.
_Avoid_: error line, compiler output, stderr

**Diagnostic code**:
The stable javac key identifying a diagnostic, such as `compiler.err.illegal.start.of.expr`.
_Avoid_: error id, message key

**Coverage**:
The share of compiler output that was classified into diagnostics; it is always reported alongside the lines that could not be classified.
_Avoid_: parse rate, success rate

**Unclassified line**:
A line of compiler output that no diagnostic rule matched, surfaced verbatim so a parser gap is never mistaken for a clean compile.
_Avoid_: noise, leftover

### Testing

**JUnit console jar**:
The pinned `junit-platform-console-standalone` launcher that discovers and runs tests and writes XML reports.
_Avoid_: junit jar, runner jar, standalone runner

**Test selector**:
A class or method reference (`Class` or `Class#method`) that limits which tests run; omitting selectors scans the classpath.
_Avoid_: filter, test name

**Test report**:
The JUnit XML files written under the scratch `reports/` directory and parsed into totals.
_Avoid_: XML output, results file

**Test failure**:
A failing or erroring test case normalized to a test id, message, and stack trace.
_Avoid_: exception, broken test

### Environment

**JDK candidate**:
A Java installation discovered on the machine, identified by its home directory, version, and vendor.
_Avoid_: JAVA_HOME, java path

**Resolved JDK**:
The candidate selected for a single tool call after applying configuration and discovery precedence.
_Avoid_: current JDK, default Java

### Delivery

**Host tool**:
A model-invocable capability implemented entirely in the DSH host process, with no client-side UI.
_Avoid_: backend tool, server tool

**Config card**:
A client-side settings surface rendered by the DSH app for editing plugin configuration.
_Avoid_: settings page, config UI

**Probe release**:
An early public release whose purpose is to validate the plugin in real sessions before the full MVP is complete.
_Avoid_: beta, preview

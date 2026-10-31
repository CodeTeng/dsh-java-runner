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

# Delegate project tests to Maven or Gradle

`java_project_test` runs the project's own test goal instead of re-implementing a build. It accepts a workspace-relative `directory`, detects `pom.xml` or `build.gradle`/`build.gradle.kts` (with `system: "auto" | "maven" | "gradle"`), prefers the project wrapper (`mvnw`/`mvnw.cmd`, `gradlew`/`gradlew.bat`), and otherwise resolves `mvn`/`gradle` from `PATH`. The command is `test` with batch/plain flags and optional offline flags, and results are read from `surefire-reports/` and `test-results/` XML files after the process exits.

The alternatives were compiling project sources with the plugin's own `javac` path and shelling out to a hardcoded Maven layout. Both fail the actual problem: dependency resolution, plugins, annotation processors, generated sources, multi-module ordering, and per-project test configuration are the build tool's job. Reproducing them would be a second, worse build system.

The costs are real. The tool requires a wrapper or a locally installed build tool, needs the host JDK, runs on the host rather than in an optional Docker backend, and can take minutes. It also cannot distinguish "the build failed before tests" from "tests failed" from XML alone, so the console output and exit code are returned alongside the totals, and a run that produces no reports is a failure with guidance rather than a green result.

Offline mode is a single flag (`offline`) that passes `-o` or `--offline` unchanged; the plugin does not manage dependency caches.

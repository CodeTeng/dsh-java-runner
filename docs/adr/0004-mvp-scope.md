# The MVP validates snippets, not projects

The MVP ships `java_env`, `java_compile`, and `java_run` for self-contained source snippets. `java_test`, Maven/Gradle project builds, JShell, and a client config card are explicitly out of scope until a probe release has validated JDK execution under DSH's sandbox.

The trade-off is a less differentiated first release. The benefit is testing the riskiest assumption first: that a JDK subprocess can compile and run reliably under read-only and workspace-write policies on supported platforms, before investing in test orchestration.

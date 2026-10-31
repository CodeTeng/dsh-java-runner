# Compile every run with javac and parse machine-readable diagnostics

Every `java_run` call compiles with `javac` into the scratch directory before launching `java -cp`, including single-file programs. `javac` receives `-XDrawDiagnostics`, which emits `file:line:column: compiler.err.key: args`: exact positions and stable diagnostic codes without parsing English prose. The obvious faster path, `java Foo.java` source-file mode, rejects `-XDrawDiagnostics`, reports no column or code, and cannot accept `-J` options. Since structured diagnostics are the reason this plugin exists, the extra compilation step is the right cost.

A fallback parser for human-readable javac output can be added if a future JDK rejects the option; the MVP does not need it.

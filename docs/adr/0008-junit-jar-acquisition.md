# Acquire the JUnit console jar from m2, then a verified download

`java_test` needs a JUnit Platform console launcher at compile and run time. The plugin pins `junit-platform-console-standalone` 1.13.4 and resolves it in this order:

1. The `junitJarPath` configuration key.
2. `~/.m2/repository/org/junit/platform/junit-platform-console-standalone`, preferring the pinned version and otherwise the highest version present.
3. A host cache at `~/.dsh-java-runner/junit/`, accepted only when its SHA-256 matches the pinned digest.
4. A download from Maven Central, verified against the same digest before an atomic rename into the cache.

The alternatives were bundling the jar in the npm package, requiring the user to install it, and using whatever JUnit the workspace already depends on. Bundling adds roughly 3 MiB to every install and mixes a Java dependency into the plugin's versioning. Requiring manual installation makes the first `java_test` call fail on a fresh machine. Trusting the workspace's JUnit makes results depend on project state, which is out of scope for standalone snippets and risks version drift in parsing behavior.

The chosen policy keeps the first call working offline when Maven has already provisioned the jar, and otherwise works with one network request. Pinning both the version and the digest means a compromised or changed artifact is rejected rather than silently used, and the host-level cache is safe to share across workspaces because the jar is immutable. Users behind a firewall set `junitJarPath`; the error text from a failed download says so.

The cost is one network request on a machine with neither an m2 copy nor the cache, and the plugin must be updated to move to a newer JUnit release. The benefits are reproducible parsing behavior, no package bloat, and an offline path that uses artifacts the user already has.

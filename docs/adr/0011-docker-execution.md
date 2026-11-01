# Run user code in Docker only when configured

Setting `dockerImage` switches `java_run`, `java_test`, and `java_eval` to execute user code inside `docker run` instead of on the host. Compilation (`javac`) and `java_project_test` stay on the host.

The container is created with `--rm --init --name dsh-java-<pid>-<callId> --network none|bridge --stop-timeout 2` and bind mounts:

- the workspace at `/workspace`, `ro` under `read-only` and `rw` under `workspace-write` or `danger-full-access`;
- the per-call scratch directory at `/dsh-work` (read-write);
- the JUnit console jar at `/dsh-libs/junit.jar` (read-only);
- each external classpath entry at `/dsh-libs/cp-N` (read-only), deduplicated case-insensitively on Windows.

No host environment is forwarded. Classpath separators are rewritten to `:`, and the working directory is `/workspace`. On timeout or abort, the plugin best-effort runs `docker rm --force` because aborting the CLI does not necessarily stop the container.

Why not compile in the container: the image's JDK may differ from the JDK that `java_env` reports, and diagnostics are the plugin's contract; compiling at home keeps error positions and class output on paths the caller can inspect. Why not delegate project builds into the container: Maven and Gradle need their dependency caches and usually the network, which defeats the point of `--network none`.

The costs: Docker must be installed and running, the image must already be pulled, Windows requires shared drives for bind mounts, and URL or wildcard classpath entries are rejected because they cannot be mapped deterministically. Docker is not a sandbox the plugin enforces itself; the host Docker CLI still runs under the DSH sandbox policy, and the container restricts network only when `dockerNetwork` is `none` (the default). Fork bombs remain unmitigated. When `dockerImage` is unset, nothing changes from the host-only behavior.

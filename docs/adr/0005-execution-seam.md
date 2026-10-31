# Use ctx.subprocess with explicit sandbox confinement

Java processes are spawned through `ctx.subprocess.spawn` and, for `read-only` and `workspace-write` sessions, confined with `ctx.sandbox.confine`; `danger-full-access` sessions spawn the raw argv. `ctx.shell` was the alternative, but it takes a command string, which reintroduces quoting and platform-shell differences for paths with spaces, and it hides the argv-level control needed to inject javac and java flags.

The cost is that this plugin owns timeout enforcement, stdio collection, and process-tree termination. The benefit is that the sandbox decision and its `enforcement`, denial signatures, and runner-failure rules are explicit values in the tool result. In DSH 0.2.1-rc.5, `SubprocessSpawnSpec` requires `cwd`, nested `stdio`, and `graceMs`.

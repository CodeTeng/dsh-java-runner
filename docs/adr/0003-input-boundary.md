# Source input is inline content or workspace-contained paths

`java_compile` and `java_run` accept either inline `{ path, content }` entries or path-only entries resolved inside the session workspace. Path-only entries are rejected when they escape the workspace, including absolute paths, `..` traversal, and symlinks that resolve outside it. The plugin reads files in the host process, outside `ctx.sandbox`, so this boundary is enforced by the plugin itself.

Inline-only input avoids the boundary entirely, but costs tokens and makes "run this file that is already in my workspace" awkward. Unrestricted paths would let a tool argument read files that the session's file policy may not cover.

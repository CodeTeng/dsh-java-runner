# Plugin name: dsh-java-runner

The plugin is published as `dsh-java-runner`, not `dsh-sandbox-java`. In DSH, "sandbox" names the file-effect confinement seam that this plugin consumes rather than provides; a sandbox-prefixed name would imply a backend it does not implement. The public name is expensive to change once it appears in npm packages and install instructions.

## Considered Options

- `dsh-sandbox-java` (original name): rejected because it misstates the plugin's relationship to the sandbox seam.
- `dsh-java-runner`: chosen; it describes the capability and leaves room for compile, run, and test tools.

import Schema from '@deepseek-ai/schemastery'

export interface Config {
  javaHome?: string
  javacPath?: string
  timeoutMs: number
  buildTimeoutMs: number
  maxHeapMb: number
  scratchRoot?: string
  junitJarPath?: string
  dockerImage?: string
  dockerNetwork: 'none' | 'bridge'
}

export const Config: Schema<Config> = Schema.object({
  javaHome: Schema.string().description('JDK home to use; auto-detected when omitted'),
  javacPath: Schema.string().description('javac executable to use; derived from the resolved JDK when omitted'),
  timeoutMs: Schema.number().default(15000).description('Default execution timeout in milliseconds'),
  buildTimeoutMs: Schema.number().default(120000).description(
    'Default timeout for Maven/Gradle project test runs in milliseconds',
  ),
  maxHeapMb: Schema.number().default(256).description('Default maximum heap in MiB'),
  scratchRoot: Schema.string().description('Scratch directory root; defaults to <workspace>/.dsh-java'),
  junitJarPath: Schema.string().description(
    'junit-platform-console-standalone jar; defaults to ~/.m2, then a verified download into ~/.dsh-java-runner/junit',
  ),
  dockerImage: Schema.string().description(
    'Run java_run, java_test, and java_eval user code inside this Docker image (for example eclipse-temurin:17-jdk); compilation and project builds stay on the host',
  ),
  dockerNetwork: Schema.union(['none', 'bridge'] as const)
    .default('none')
    .description('Docker network mode for the execution container; "none" isolates user code from the network'),
})

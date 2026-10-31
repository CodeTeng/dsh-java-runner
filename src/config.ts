import Schema from '@deepseek-ai/schemastery'

export interface Config {
  javaHome?: string
  javacPath?: string
  timeoutMs: number
  maxHeapMb: number
  scratchRoot?: string
}

export const Config: Schema<Config> = Schema.object({
  javaHome: Schema.string().description('JDK home to use; auto-detected when omitted'),
  javacPath: Schema.string().description('javac executable to use; derived from the resolved JDK when omitted'),
  timeoutMs: Schema.number().default(15000).description('Default execution timeout in milliseconds'),
  maxHeapMb: Schema.number().default(256).description('Default maximum heap in MiB'),
  scratchRoot: Schema.string().description('Scratch directory root; defaults to <workspace>/.dsh-java'),
})

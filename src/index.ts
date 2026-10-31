import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import { Config } from './config.js'
import type { Config as RunnerConfig } from './config.js'
import { JdkResolver } from './jdk.js'
import { registerCompileTool } from './tools/compile.js'
import { registerEnvTool } from './tools/env.js'
import { registerRunTool } from './tools/run.js'
import { registerTestTool } from './tools/test.js'

export { Config }

export const name = 'dsh-java-runner'
export const inject = ['tools', 'subprocess']

export function apply(ctx: Context, config: RunnerConfig): void {
  const resolver = new JdkResolver(ctx, config)
  registerEnvTool(ctx, resolver)
  registerCompileTool(ctx, config, resolver)
  registerRunTool(ctx, config, resolver)
  registerTestTool(ctx, config, resolver)
}

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JdkResolver } from '../jdk.js'
import { nullableString, resolvePolicy } from './shared.js'

const jdkObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', required: true },
    home: { type: 'string', required: true },
    javacPath: nullableString,
    javaPath: nullableString,
    version: nullableString,
    vendor: nullableString,
    error: nullableString,
  },
} as const

export function registerEnvTool(ctx: Context, resolver: JdkResolver): void {
  ctx.tools.register(
    defineTool({
      name: 'java_env',
      description:
        'Report which JDK java_compile and java_run will use. Candidates are probed in order from the plugin config, JAVA_HOME, then PATH; failed candidates are shown with their error. Prefer this over running "java -version" in a shell: the result is structured and consistent across hosts.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            resolved: {
              oneOf: [{ type: 'null' }, jdkObject],
              required: true,
            },
            candidates: {
              type: 'array',
              required: true,
              items: jdkObject,
            },
            guidance: nullableString,
          },
        },
        render: (_args, value) => {
          const resolved = value.resolved
          if (resolved === null) {
            return [
              {
                type: 'text',
                text: `No usable JDK found.\n${value.guidance ?? ''}`,
              },
            ]
          }
          const lines = [
            `Resolved JDK ${resolved.version ?? 'unknown version'}${
              resolved.vendor ? ` (${resolved.vendor})` : ''
            } at ${resolved.home}`,
            `javac: ${resolved.javacPath ?? 'missing'}`,
            `java: ${resolved.javaPath ?? 'missing'}`,
          ]
          lines.push(
            '',
            'Discovery order: plugin config, JAVA_HOME, PATH. Set "javaHome" in the plugin configuration to select a different JDK.',
          )
          const failed = value.candidates.filter(
            (candidate) => candidate.error !== null && candidate.home !== resolved.home,
          )
          if (failed.length > 0) {
            lines.push('Other candidates:')
            for (const candidate of failed) {
              lines.push(`- ${candidate.source} ${candidate.home}: ${candidate.error}`)
            }
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall: () => ({
        card: 'generic',
        title: 'Inspect the Java toolchain',
        kind: 'read',
      }),
      async execute(_args, exec) {
        const policy = resolvePolicy(ctx, exec)
        const discovery = await resolver.discover({
          workspaceRoot: policy.workspaceRoot,
          signal: exec.signal,
        })
        return discovery
      },
    }),
  )
}

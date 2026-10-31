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
        'Discover the JDKs available to this session and show which one java_compile and java_run will use. Reports javac/java paths, versions, vendors, and actionable guidance when no JDK is installed. Prefer this over running "java -version" in a shell: the result is structured and consistent across hosts.',
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

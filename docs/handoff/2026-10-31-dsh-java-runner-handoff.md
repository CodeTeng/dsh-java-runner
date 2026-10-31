# Handoff: dsh-java-runner（DeepSeek Harness Java 执行插件）

> 生成时间：2026-10-31
> 下一阶段目标：**新建仓库，启动 MVP 开发**

---

## 1. 项目一句话

为 DeepSeek Harness（DSH）开发一个 Java 代码执行插件：在 DSH 会话中编译、运行 Java 代码与 JUnit 测试，返回**结构化诊断/测试结果**，跑在 DSH 现有沙箱策略下。

- 用户原始命名：`dsh-sandbox-java`
- 建议改名：`dsh-java-runner`（原因：DSH 的 "sandbox" 特指文件效果沙箱 seam，本插件是**消费**该 seam，不是提供沙箱后端，命名易混淆）
- 最终命名待用户拍板

---

## 2. 背景与动机（为什么做）

用户：计算机研究生，2026 秋招已获大厂 offer，Java 后端 + AI 全栈 + Agent 背景。两条线：GitHub 开源贡献 + 自媒体。此项目作为开源主线和内容素材。

### 生态空白（2026-10-31 调研结论）

- DSH 插件生态 4000+，有 Python/Node 代码执行（`dsh-plugin-interpreters`），**没有任何 Java 编译/运行/JUnit 插件**
- 相邻插件都不覆盖该场景：
  - `dsh-spring-boot-launcher`：启停已有 Maven Spring Boot 服务，不编译代码片段
  - `dsh-api-runner` / `dsh-service-runner`：Java 服务调试/启停
  - `dsh-jvm-doctor`：纯离线文本诊断（jstack/GC/依赖树），明确不接触进程
  - `deepseek-harness-java` 组织的 27 个 `dsh-java-*`：Java 写的工具类插件，非代码执行
- GitHub API 检索 `topic:dsh-plugin` + jshell/junit/maven/gradle/"java code" 均无执行类插件

### 为什么不是"bash 已经能做"

bash 能跑 `javac`，但模型会系统性做错四件事，插件把"正确性"编码下来：

1. **编码/locale**：中文 Windows 下 `javac` 输出 GBK 中文报错 → 子进程按 UTF-8 捕获 → 乱码不可读。固定 `-encoding UTF-8`、`-J-Duser.language=en -J-Duser.country=US`，统一 UTF-8 解码。
2. **原始 stderr 不可用**：解析为 `{file,line,column,code,message}` JSON，并返回 `unknown_lines`/`coverage`，避免"解析失败"被当"无错误"。
3. **JUnit 多步骤编排**：找 standalone jar → 编译 classpath → `--scan-class-path` → 解析 XML → 提取失败堆栈。模型每次现拼必然出错；封装成一次调用才能支撑"写→测→修→重测"闭环。
4. **进程卫生与安全**：timeout、`-Xmx`、进程树终止（Windows）、草稿目录隔离、`@argfile` 规避 32767 命令行上限。

### 使用场景

- 对话内验证代码（"写个程序算 X 并证明能跑"）
- 算法题/测试用例验证
- Agent 自修复循环（生成 → `java_test` → 读结构化失败 → 修 → 重跑）
- 自媒体内容素材（现场演示 Agent 自己写、跑、修 Java）

---

## 3. DSH 官方文档关键约束（务必遵守）

文档入口：https://deepseek-harness.github.io/deepseek-harness/develop/basic/
（VitePress 站点支持在 URL 后加 `.md` 直接取原始 Markdown，调试时很有用）

### 3.1 插件模型

- 插件 = 导出 `apply(ctx)` 的 TS 模块，可带 `name`、`inject`
- 注册的一切（工具/事件/定时器）随插件卸载自动清理；外部资源用 `ctx.effect(() => cleanup)`
- 本地开发：`pnpm dsh web --patch ./cordis.yml`，插件路径必须绝对路径

### 3.2 工具 DSL（defineTool）

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'greet',
  description: '...',
  parameters: { name: { type: 'string', required: true, description: '...' } },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) { return `Hello, ${args.name}!` },
}))
```

硬性规则：
- `execute` 必须返回 `output.schema` 声明的**规范 JSON 值**，不能返回内容块
- 抛异常/返回非法值 = `isError`；"进程非零退出"应写入规范值，由 render 解释
- 必须响应 `exec.signal`
- 长任务用 `ctx.jobs.start({ kind, label, owner: exec.agent, run })`
- UI 卡片独立：`presentCall`/`presentResult`，类型 `generic | terminal | diff | read | search | web`；编译/运行输出用 `terminal`；需回放的事实放 `output.presentationMeta`
- 策略钩子：`tools/pre-execute`、`ctx.tools.guard()`、`tools/post-execute`、`tools/result`

### 3.3 配置

- 导出 `Config` 接口 + Schemastery schema（`@deepseek-ai/schemastery`），默认值写在 schema
- 约定：**不同部署可能取不同值的参数必须做成配置**
- 配置非法要加载失败并报明确错误；配置变更触发 HMR

### 3.4 打包分发

- 组合包：`package.json` 中 `dsh.bundle.patch` 指向 `cordis.patch.yml`
- `engines.dsh` 声明兼容范围（开发者预览，会有破坏性变更）
- GitHub 直装不跑 build：TS 包必须提供自包含 `prepare`；用户需在 profile 的 `pnpm-workspace.yaml` 配 `allowBuilds`
- 推荐：npm 发布预构建产物 + tarball 双通道

### 3.5 执行与沙箱（核心）

| 服务 | 用法 |
|------|------|
| `ctx.shell` | `resolve(ShellExecRequest) → ShellExecSpec`；`execute(spec)`；字段：`command/workdir/timeoutMs/onExpiry/stdin/env/signal/stdoutMaxBytes` |
| `ctx.subprocess` | `spawn(SubprocessSpawnSpec)`、`resolveExecutable()`；spawn spec 完全显式无默认值 |
| `ctx.sandbox` | `confine(argv, policy, signal) → ConfinedArgv`（含 `enforcement`、`denialSignatures`、`runnerFailureRules`） |
| `ctx.sandboxPolicy` | `resolve({ session?, mode? })` 取逐调用策略 |

- `SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'`（仅前两种可交给 sandbox）
- 后端：Linux bwrap/Landlock、macOS Seatbelt、Windows ACL 受限令牌；`partial` 表示覆盖缺口
- **重要限制：沙箱只管文件效果，不管网络/进程可见性** —— README 必须明示
- `danger-full-access` 消费者直接 spawn，不调 `ctx.sandbox`

### 3.6 参考实现

- `packages/shell/tool-bash`：官方生产级三包示例
- `HuanLinOTO/dsh-plugin-interpreters`：Python/Node 执行器，含配置卡片、settings RPC 白名单、client bundle、行 id 命名等实测坑，**建议精读其 README 与 src 结构**

---

## 4. 插件设计（已达成共识的草案）

### 4.1 工具集（MVP）

| 工具 | 输入 | 输出（规范 JSON） |
|------|------|-------------------|
| `java_env` | 无 | JDK 列表/版本/vendor/路径/当前选用 |
| `java_compile` | `files:[{path,content}]`、`release?`、`classpath?`、`keepWorkdir?` | `{success, diagnostics[], outDir, unknownLines, durationMs}` |
| `java_run` | `main`、`files?`、`args?`、`stdin?`、`timeoutMs?`、`maxHeapMb?`、`classpath?` | `{exitCode, stdout, stderr, truncated, timedOut, durationMs}` |
| `java_test` | `files`、`tests?`、`classpath?`、`timeoutMs?` | `{total, passed, failed, skipped, failures:[{test,message,stackTrace}]}` |

### 4.2 执行路径

```
execute(args, exec)
  → 解析 JDK（config → JAVA_HOME → PATH，缓存）
  → 草稿目录 <workspace>/.dsh-java/<callId>/（workspace-write 可写）
  → 单文件: java --class-path ... Main.java（JDK 11+）
    多文件: javac -encoding UTF-8 -J-Duser.language=en @argfile → java -cp out Main
  → ctx.sandboxPolicy.resolve({ session, mode })
  → ctx.sandbox.confine(argv, policy, exec.signal)
  → ctx.subprocess.spawn({ argv, workdir, stdin: 'pipe', ... })
  → 收集 stdout/stderr（各自上限，显式 truncated）
  → 解析 javac 诊断 / JUnit XML → 规范 JSON
  → render 生成模型文本；presentResult 用 terminal 卡片
```

实现选择：
- 推荐 `ctx.subprocess` + `ctx.sandbox.confine`：argv 级控制、无 shell 引号问题、沙箱事实可透出
- 备选 `ctx.shell`：省事、继承当前 shell 提供方的沙箱行为，但命令需拼字符串

### 4.3 配置项

```ts
export interface Config {
  javaHome?: string          // 不填自动探测
  javacPath?: string
  timeoutMs: number          // 默认 15000
  maxHeapMb: number          // 默认 256
  scratchRoot?: string       // 默认 <workspace>/.dsh-java
  junitJarPath?: string      // 不填则 ~/.m2 → 缓存目录
  networkAllowed: boolean    // 仅文档提示，DSH 沙箱不含网络隔离
}
```

### 4.4 隔离策略（诚实版，写进 README）

| 层 | 提供方 | 说明 |
|----|--------|------|
| 文件写入 | `ctx.sandbox` | read-only / workspace-write |
| 时间 | `timeoutMs` + `onExpiry:'kill'` | 防死循环 |
| 内存/线程 | `-Xmx`、`-XX:ActiveProcessorCount` | 防内存/线程炸弹 |
| 目录 | 草稿目录 | 不污染用户工程 |
| 网络 | **不隔离** | Phase 3 可选 Docker 后端 |
| fork 炸弹 | **不防** | 明示限制 |

### 4.5 分阶段

- **MVP（1 周）**：`java_env` + `java_compile` + `java_run`，结构化诊断、timeout、terminal 卡片
- **Phase 2（2-3 周）**：`java_test`（JUnit 5 standalone + XML 解析）、配置卡片、README/演示
- **Phase 3**：Maven/Gradle 项目委托（`mvn -q test` + surefire 解析）、热 JVM/JShell、Docker 网络隔离后端

---

## 5. 新仓库启动计划

### 5.1 仓库结构（建议）

```
dsh-java-runner/
├── package.json            # dsh.bundle、engines.dsh、files、prepare
├── cordis.patch.yml        # 插入插件行 + 默认配置
├── tsconfig.json
├── tsdown.config.ts
├── vitest.config.ts
├── src/
│   ├── index.ts            # apply：解析 config、注册工具
│   ├── config.ts           # Config + Schemastery
│   ├── jdk.ts              # JDK 探测与缓存
│   ├── runner.ts           # argv 构建、sandbox 包装、spawn、收集
│   ├── tools/
│   │   ├── env.ts
│   │   ├── compile.ts
│   │   ├── run.ts
│   │   └── test.ts
│   ├── parsers/
│   │   ├── javac.ts        # 中英双语报错解析
│   │   └── junit.ts        # JUnit XML 解析
│   └── client/             # Phase 2：配置卡片
├── test/
│   ├── fixtures/           # javac 输出样例、JUnit XML 样例
│   └── *.test.ts
├── README.md               # 能力 + 限制 + 安装
└── docs/
    └── design.md
```

### 5.2 package.json 关键字段

```json
{
  "name": "dsh-java-runner",
  "type": "module",
  "main": "lib/index.js",
  "files": ["lib", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "dsh": ">=0.2.0 <0.3.0" },
  "scripts": {
    "build": "tsdown && tsc --emitDeclarationOnly",
    "test": "vitest run",
    "prepare": "npm run build"
  }
}
```

### 5.3 第一周里程碑

1. 仓库脚手架 + hello 工具通过 `--patch` 加载成功
2. `java_env` + `java_run` 单文件跑通
3. `java_compile` 多文件 + 结构化诊断（含中文 Windows 乱码用例）
4. timeout / `-Xmx` / terminal 卡片
5. `java_test` JUnit 5（jar 缓存 + SHA-256）
6. 发布 npm + 加 topic `dsh-plugin` + 提交 awesome 列表/插件市场

### 5.4 测试策略

- 单元测试：javac 解析器（中/英/多错误/截断）、JUnit XML（失败/跳过/嵌套）
- 集成测试：用假 `javac` 脚本模拟各类输出，不依赖本机 JDK
- E2E：CI 矩阵（Win/macOS/Linux × JDK 17/21/25）

---

## 6. 待决策 / 开放问题

1. 插件最终命名：`dsh-java-runner` vs `dsh-sandbox-java`
2. 是否 MVP 就做配置卡片（client bundle），还是纯 host 工具
3. JUnit standalone jar：运行时下载缓存 vs 随包提供 vs 只读 `~/.m2`
4. JDK 版本支持范围（建议 17/21，25 视 CI 情况）
5. 是否先发探测版收集反馈再投 JUnit（建议：半天做 `java_run` 探测版，在 DSH Discussions 发帖）
6. Maven/Gradle 支持是否进 MVP（建议 Phase 3）

---

## 7. 风险清单

| 风险 | 应对 |
|------|------|
| DSH 开发者预览，接口破坏性变更 | 锁 `engines.dsh`；CI 对每个 rc 跑集成测试；关注 `packages/shell/shell/src/types.ts` |
| 用户机器无 JDK | `java_env` 返回可执行安装指引，而非 ENOENT |
| JUnit jar 网络依赖 | 优先 `~/.m2`，其次缓存 + SHA-256，允许配置本地路径 |
| 模型倾向用 bash | 工具 description 明确"Java 任务优先用它"；README 给对话示例 |
| 沙箱覆盖不完整（Windows ACL partial） | 输出 `enforcement` 事实，不宣称绝对隔离 |
| 同质化 | 差异化在结构化诊断 + JUnit 闭环 + Java 环境托底 |

---

## 8. 内容联动（用户第二条线）

- 选题："我给 DeepSeek Harness 加上了 Java 执行能力"
- 系列：架构拆解 → 中文 Windows 乱码踩坑 → JUnit 闭环演示 → Maven/Gradle 扩展
- 发布渠道：抖音/B站（演示）+ 掘金/知乎（长文）+ GitHub（项目本身）

---

## 9. 建议下一 Agent 使用的 Skills

按需调用 `Skill` 工具：

| 时机 | Skill | 用途 |
|------|-------|------|
| 写解析器/工具前 | `tdd` | 先写 javac 诊断、JUnit XML 的失败用例，再实现 |
| 查 Cordis / Schemastery / tsdown / vitest API | `context7` | 拉取库文档，避免凭记忆写 API |
| MVP 完成后 | `code-review` | 对新增代码做 Standards + Spec 双轴审查 |
| 提 PR 到自己的仓库 / 写发布说明 | `pr` | 生成 PR 描述 |
| 遇到难复现的构建/执行问题 | `diagnosing-bugs` | 系统化诊断循环 |

不推荐：`sites:*`（非站点项目）、`lemo-opuscar`（除非做演示视频）、`skill-creator`（本阶段不需要）。

---

## 10. 参考资料（按需重读，不要全量复制）

- DSH 插件开发总入口：https://deepseek-harness.github.io/deepseek-harness/develop/basic/
- 工具编写参考：https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool
- Shell 执行器：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/shell
- 进程沙箱：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/sandbox
- 子进程：https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/subprocess
- 事件系统：https://deepseek-harness.github.io/deepseek-harness/develop/framework/events
- 打包发布：https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish
- 参考插件（Python/Node 执行器）：https://github.com/HuanLinOTO/dsh-plugin-interpreters
- Spring Boot 启动器（进程管理参考）：https://github.com/simplifyOurLife/dsh-spring-boot-launcher
- JVM 文本诊断（结构化输出/coverage 设计参考）：https://github.com/ax2/dsh-jvm-doctor
- DSH 官方仓库：https://github.com/deepseek-ai/deepseek-harness

> 技巧：文档站任意页面 URL 末尾加 `.md` 可获取原始 Markdown（如 `/develop/basic/tool.md`），比抓 HTML 更可靠。

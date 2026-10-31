# dsh-java-runner

为 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 提供 Java 编译、运行与测试工具。

> **状态：alpha。** `java_env`、`java_compile`、`java_run` 已实现并在本机 JDK 上通过测试。插件尚未发布，探测版之前 schema 仍可能变化。

## 为什么不用 bash

bash 能调用 `javac`，但 Agent 会话会系统性地在四件事上出错：

1. **编码与 locale。** 中文 Windows 下 `javac` 以 GBK 输出中文报错，`System.out` 也跟随控制台编码，按 UTF-8 捕获都会乱码。插件对源码、诊断和程序输出统一固定 UTF-8，并强制英文 locale。
2. **原始 stderr 不可操作。** 插件把编译器消息解析为结构化诊断，并原样返回所有未能解析的行，避免"解析失败"被误判为"编译无错"。
3. **JUnit 编排。** 查找 standalone jar、拼 classpath、扫描测试、解析 XML、提取失败堆栈，每次现拼都容易出错。（Phase 2。）
4. **进程卫生。** 超时、堆上限、进程范围终止、草稿目录隔离、输出上限、Windows 命令行长度限制，只实现一次。

## 工具

| 工具 | 用途 | 状态 |
| --- | --- | --- |
| `java_env` | 报告当前选用的 JDK，以及从 config、`JAVA_HOME`、`PATH` 探测到的候选 | 已实现 |
| `java_compile` | 编译内联或工作区相对路径源码，返回结构化诊断 | 已实现 |
| `java_run` | 按需编译并运行 Java 入口，支持参数、stdin、超时、堆上限 | 已实现 |
| `java_test` | 运行 JUnit 5 测试并返回结构化结果 | Phase 2 |

Maven / Gradle 项目构建不在 MVP 范围内。

## 执行模型

- 每次运行先用 `javac` 编译到草稿目录，再 `java -cp` 运行。
- 编译器以 javac 的机器可读诊断格式输出，因此每条诊断都带精确位置和稳定代码。
- 草稿目录位于 `<workspace>/.dsh-java/`；成功调用会被清理，失败、超时、输出截断或设置 `keepWorkdir` 时保留，并返回明确的 `retainedReason`。
- 插件消费 DSH 的 sandbox seam，不提供沙箱后端。

## 隔离与限制

| 层 | 提供方 | 说明 |
| --- | --- | --- |
| 文件写入 | DSH sandbox | `read-only` 与 `workspace-write` 策略；返回 enforcement 事实 |
| 时间 | 插件 | `timeoutMs`；中止信号会终止 subprocess provider 管理的进程范围 |
| 内存 | 插件 | `-Xmx` |
| 目录 | 插件 | 每次调用独立草稿目录，不污染用户工程 |
| 输出 | 插件 | 128–512 KiB 内存上限 + 8 MiB spill 文件；截断状态显式返回 |
| 源码读取 | 插件 | 内联内容，或受限于会话工作区的路径 |
| 网络 | **不隔离** | Java 代码可以建立网络连接 |
| fork 炸弹 | **不防** | 不要在特权会话中运行不可信代码 |

插件会透出 DSH 返回的沙箱执行事实，不宣称绝对隔离。

## 环境要求

- DSH 0.2.1.x
- JDK 17 或更新；本机已验证 JDK 17
- 主要支持 Windows 与 Linux；macOS 为 best-effort

## 配置

Host 配置：

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| `javaHome` | 自动探测 | 指定 JDK |
| `javacPath` | 自动探测 | 覆盖编译器可执行文件 |
| `timeoutMs` | `15000` | 默认执行超时 |
| `maxHeapMb` | `256` | 默认 `-Xmx` |
| `scratchRoot` | `<workspace>/.dsh-java` | 草稿目录根路径 |

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` 通过真实的 DSH 工具运行时和本地 subprocess provider 运行集成测试；`PATH` 上没有 `javac` 时，依赖 JDK 的用例会自动跳过。

把开发构建加载进 Electron desktop profile 的路径仍未解决；包内已声明 `dsh.bundle.patch` 层。

## License

MIT

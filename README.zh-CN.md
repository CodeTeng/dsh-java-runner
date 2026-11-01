# dsh-java-runner

为 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 提供 Java 编译、运行、测试与求值工具。

> **状态：alpha。** `java_env`、`java_compile`、`java_run`、`java_test`、`java_project_test`、`java_eval` 已实现，并通过确定性的 fake 工具测试与本机 JDK 集成测试；Docker 执行是可选功能，由 fake 进程测试覆盖。插件尚未发布，探测版之前 schema 仍可能变化。

## 为什么不用 bash

bash 能调用 `javac`，但 Agent 会话会系统性地在五件事上出错：

1. **编码与 locale。** 中文 Windows 下 `javac` 以 GBK 输出中文报错，`System.out` 也跟随控制台编码，按 UTF-8 捕获都会乱码。插件对源码、诊断和程序输出统一固定 UTF-8，并强制英文 locale。
2. **原始 stderr 不可操作。** 插件把编译器消息解析为结构化诊断，并原样返回所有未能解析的行，避免“解析失败”被误判为“编译无错”。
3. **JUnit 编排。** 查找 standalone jar、拼 classpath、扫描测试、解析 XML、提取失败堆栈，每次现拼都容易出错（ADR-0008）。
4. **项目构建。** wrapper、`PATH` 回退、离线参数、多模块报告目录，以及“构建成功但其实没有跑测试”，都在一个地方处理（ADR-0009）。
5. **进程卫生。** 超时、堆上限、进程范围终止、草稿目录隔离、输出上限、Windows 命令行长度限制，以及 Docker 容器清理，只实现一次。

## 工具

| 工具 | 用途 | 状态 |
| --- | --- | --- |
| `java_env` | 报告当前选用的 JDK，以及从 config、`JAVA_HOME`、`PATH` 探测到的候选 | 已实现 |
| `java_compile` | 编译内联或工作区相对路径源码，返回结构化诊断 | 已实现 |
| `java_run` | 按需编译并运行 Java 入口，支持参数、stdin、超时、堆上限 | 已实现 |
| `java_test` | 编译源码并运行 JUnit 5 测试，返回统计与失败堆栈 | 已实现 |
| `java_project_test` | 通过项目自身的 Maven 或 Gradle 构建工具运行测试 | 已实现 |
| `java_eval` | 执行一段 JShell 脚本，支持 classpath、超时与堆上限 | 已实现 |

Maven 与 Gradle 只在 `java_project_test` 中使用；插件不管理依赖或缓存。`java_eval` 是单次执行：多次调用之间不保留定义，裸表达式不会打印结果（需要 `System.out.println`），且 JShell 在代码出错时仍返回 0，因此插件从输出中识别错误。

## 执行模型

- 每次运行源码都先用 `javac` 编译到草稿目录，再 `java -cp` 运行。
- 编译器以 javac 的机器可读诊断格式输出，因此每条诊断都带精确位置和稳定代码。
- `java_project_test` 在会话工作区内解析项目目录，优先使用项目自带 wrapper，在主机的 Maven 或 Gradle 上运行 `test`。构建结束后解析 surefire/Gradle XML；没有产生任何报告会被判为失败，而不是“测试通过”。
- `java_eval` 每次调用写入一个脚本并运行一次 `jshell --feedback concise`。JShell 在代码出错时仍返回 0，因此错误与异常从 stderr 中识别。
- 草稿目录位于 `<workspace>/.dsh-java/`；成功调用会被清理，失败、超时、输出截断或设置 `keepWorkdir` 时保留，并返回明确的 `retainedReason`。
- `java_test` 以固定版本的 JUnit Platform console launcher 编译生产代码与测试代码，再解析其 XML 报告。jar 依次取自 `junitJarPath`、`~/.m2`、经 SHA-256 校验的主机缓存（`~/.dsh-java-runner/junit/`），或从 Maven Central 下载并校验。离线环境应设置 `junitJarPath` 或依赖 m2。
- 设置 `dockerImage` 后，`java_run`、`java_test`、`java_eval` 的用户代码改为在 `docker run` 中执行；编译仍留在主机，`java_project_test` 永远不使用 Docker。容器只挂载工作区、草稿目录、JUnit jar 和外部 classpath 条目，不继承主机环境变量，默认 `--network none`。超时会强制删除容器。
- 插件消费 DSH 的 sandbox seam，不提供沙箱后端。

## 隔离与限制

| 层 | 提供方 | 说明 |
| --- | --- | --- |
| 文件写入 | DSH sandbox | `read-only` 与 `workspace-write` 策略；返回 enforcement 事实 |
| 时间 | 插件 | `timeoutMs`；中止信号会终止 subprocess provider 管理的进程范围；Docker 容器在超时后强制删除 |
| 内存 | 插件 | `-Xmx` |
| 目录 | 插件 | 每次调用独立草稿目录，不污染用户工程 |
| 输出 | 插件 | 128–512 KiB 内存上限 + 8 MiB spill 文件；截断状态显式返回 |
| 源码读取 | 插件 | 内联内容，或受限于会话工作区的路径 |
| 网络（主机） | **不隔离** | Java 代码可以建立网络连接 |
| 网络（Docker） | Docker，可选 | 默认 `dockerNetwork: none`；设为 `bridge` 才放行 |
| 容器文件系统 | Docker，可选 | 只挂载工作区、草稿目录、JUnit jar 与外部 classpath 条目；`read-only` 下工作区为 `ro` |
| fork 炸弹 | **不防** | 不要在特权会话中运行不可信代码 |

插件会透出 DSH 返回的沙箱执行事实，不宣称绝对隔离。Docker 是可选附加边界，不是沙箱后端：Docker CLI 仍受 DSH 策略约束，插件也无法约束镜像本身如何构建。

## 环境要求

- DSH 0.2.1.x
- JDK 17 或更新；本机已验证 JDK 17。`java_eval` 需要包含 `jshell` 的完整 JDK（或包含 jshell 的镜像）。
- 只有在使用 `java_project_test` 时才需要 Maven 或 Gradle；项目 wrapper 可以自带。
- 只有在设置 `dockerImage` 时才需要 Docker，且镜像需已拉取。
- 主要支持 Windows 与 Linux；macOS 为 best-effort。

## 配置

Host 配置：

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| `javaHome` | 自动探测 | 指定 JDK |
| `javacPath` | 自动探测 | 覆盖编译器可执行文件 |
| `timeoutMs` | `15000` | 默认执行超时 |
| `buildTimeoutMs` | `120000` | `java_project_test` 默认超时 |
| `maxHeapMb` | `256` | 默认 `-Xmx` |
| `scratchRoot` | `<workspace>/.dsh-java` | 草稿目录根路径 |
| `junitJarPath` | m2 → 已校验缓存 → 下载 | `java_test` 使用的 JUnit console launcher jar |
| `dockerImage` | 未设置 | 在此镜像中运行 `java_run`、`java_test`、`java_eval` 的用户代码，例如 `eclipse-temurin:17-jdk` |
| `dockerNetwork` | `none` | 容器网络模式：`none` 或 `bridge` |

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` 包含一套不依赖 JDK、Maven、Gradle、Docker 和网络的 fake 工具测试：用伪造的 subprocess 服务返回预置的 `javac`/`java`/`jshell`/`mvn`/`gradle`/`docker` 输出，因此编译、运行、测试、项目、求值与 Docker 路径在任何机器上都可确定地验证。当 `PATH` 上有 `javac` 时，还会运行真实 JDK 集成测试；`java_test` 用例要求 JDK 17+，以及 `~/.m2`、`~/.dsh-java-runner/junit/` 或 `JUNIT_JAR` 中的 JUnit jar；`java_eval` 用例要求 `jshell`。CI 在 Ubuntu 和 Windows 上运行 typecheck、测试和构建，无需安装 JDK。真实 Maven、Gradle 与 Docker 运行属于桌面验收项，不是 CI 步骤。

本地开发时，Electron desktop profile 通过 bundle patch 加载插件：在 `~/.dsh/profiles/desktop/package.json` 中添加指向本仓库的 `link:` 依赖，在 `dsh.profile.bundles` 中登记 `dsh-java-runner`，使用应用自带 pnpm 安装后重启应用。

## License

MIT

# Force English diagnostics and UTF-8 I/O for Java subprocesses

Every Java subprocess runs with an English locale and UTF-8 I/O. `javac` receives `-encoding UTF-8 -J-Duser.language=en -J-Duser.country=US` plus the `-J` forms of `file.encoding`, `stdout.encoding`, `stderr.encoding`, and `sun.*.encoding`; the `java` launcher receives the `-D` forms of the same properties. JDK 17 does not have `stdout.encoding`, so the legacy `sun.stdout.encoding`/`sun.stderr.encoding` properties are set as well.

On zh-CN Windows the default GBK diagnostics become unreadable once captured as UTF-8, and localized messages would also force a locale-dependent parser. `System.out` follows the native console encoding on JDK 17 unless the `sun.*` properties are set, so Chinese program output would otherwise garble after capture. The cost is losing localized compiler messages in tool output; the benefit is one machine-parseable diagnostic grammar and byte-identical program text on every host.

Verified on Windows with a zh-CN system locale: a diagnostic naming the identifier `未定义` and a program printing `你好，世界` both survive the subprocess boundary unchanged.

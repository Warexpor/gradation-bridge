import { afterEach, describe, expect, it } from "vitest";
import {
  appendTerminalOutput,
  assertTerminalCreateParams,
  blockedTerminalEnvName,
  harnessChildEnv,
  terminalChildEnv,
  MAX_TERMINALS_PER_SESSION,
  resolveOutputByteLimit,
  TerminalTable,
  terminalOutputText,
} from "../src/session/terminals.js";

describe("terminal output limit", () => {
  it("keeps the newest bytes and does not split a UTF-8 character", () => {
    const state = { chunks: [] as Buffer[], bytes: 0, truncated: false, limit: 4 };
    appendTerminalOutput(state, Buffer.from("ééXYZ", "utf8"));
    expect(state.truncated).toBe(true);
    expect(state.bytes).toBeLessThanOrEqual(4);
    expect(terminalOutputText(state)).toBe("XYZ");
  });

  it("retains nothing when the limit is zero", () => {
    const state = { chunks: [] as Buffer[], bytes: 0, truncated: false, limit: 0 };
    appendTerminalOutput(state, Buffer.from("abc"));
    expect(state.truncated).toBe(true);
    expect(terminalOutputText(state)).toBe("");
  });

  it("rejects a negative outputByteLimit", () => {
    expect(() => resolveOutputByteLimit(-1)).toThrow(/outputByteLimit/);
  });

  it("rejects loader and git-config env names", () => {
    expect(blockedTerminalEnvName("LD_PRELOAD")).toBe(true);
    expect(blockedTerminalEnvName("GIT_DIR")).toBe(true);
    expect(blockedTerminalEnvName("GIT_WORK_TREE")).toBe(true);
    expect(blockedTerminalEnvName("GIT_EDITOR")).toBe(true);
    expect(blockedTerminalEnvName("GIT_PAGER")).toBe(true);
    expect(blockedTerminalEnvName("EDITOR")).toBe(true);
    expect(blockedTerminalEnvName("PAGER")).toBe(true);
    expect(blockedTerminalEnvName("GIT_CONFIG_KEY_0")).toBe(true);
    expect(blockedTerminalEnvName("GIT_CONFIG_VALUE_1")).toBe(true);
    expect(blockedTerminalEnvName("GIT_CONFIG")).toBe(true);
    expect(blockedTerminalEnvName("GIT_ASKPASS")).toBe(true);
    expect(blockedTerminalEnvName("SSH_ASKPASS")).toBe(true);
    expect(blockedTerminalEnvName("SSH_ASKPASS_REQUIRE")).toBe(true);
    expect(blockedTerminalEnvName("GIT_PROXY_COMMAND")).toBe(true);
    expect(blockedTerminalEnvName("GIT_ALLOW_PROTOCOL")).toBe(true);
    expect(blockedTerminalEnvName("GIT_TRACE")).toBe(true);
    expect(blockedTerminalEnvName("GIT_TRACE2_EVENT")).toBe(true);
    expect(blockedTerminalEnvName("GIT_TRACE_CUSTOM")).toBe(true);
    expect(blockedTerminalEnvName("NODE_OPTIONS")).toBe(true);
    expect(blockedTerminalEnvName("JAVA_TOOL_OPTIONS")).toBe(true);
    expect(blockedTerminalEnvName("_JAVA_OPTIONS")).toBe(true);
    expect(blockedTerminalEnvName("JDK_JAVA_OPTIONS")).toBe(true);
    expect(blockedTerminalEnvName("DOTNET_STARTUP_HOOKS")).toBe(true);
    expect(blockedTerminalEnvName("SSLKEYLOGFILE")).toBe(true);
    expect(blockedTerminalEnvName("OPENSSL_CONF")).toBe(true);
    expect(blockedTerminalEnvName("BASH_FUNC_echo")).toBe(true);
    expect(blockedTerminalEnvName("PYTHONUSERBASE")).toBe(true);
    expect(blockedTerminalEnvName("ZDOTDIR")).toBe(true);
    expect(blockedTerminalEnvName("PERLLIB")).toBe(true);
    expect(blockedTerminalEnvName("npm_config_script_shell")).toBe(true);
    expect(blockedTerminalEnvName("NPM_CONFIG_SCRIPT_SHELL")).toBe(true);
    expect(blockedTerminalEnvName("Npm_Config_script_shell")).toBe(true);
    expect(blockedTerminalEnvName("npm_config_script-shell")).toBe(true);
    expect(blockedTerminalEnvName("GOFLAGS")).toBe(true);
    expect(blockedTerminalEnvName("RUSTC")).toBe(true);
    expect(blockedTerminalEnvName("RUSTC_WRAPPER")).toBe(true);
    expect(blockedTerminalEnvName("CARGO_BUILD_RUSTC")).toBe(true);
    expect(blockedTerminalEnvName("CARGO_BUILD_RUSTC_WRAPPER")).toBe(true);
    expect(blockedTerminalEnvName("CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER")).toBe(true);
    expect(blockedTerminalEnvName("RUSTC_WORKSPACE_WRAPPER")).toBe(true);
    expect(blockedTerminalEnvName("LD_DEBUG")).toBe(true);
    expect(blockedTerminalEnvName("LD_DEBUG_OUTPUT")).toBe(true);
    expect(blockedTerminalEnvName("PYTHONPYCACHEPREFIX")).toBe(true);
    expect(blockedTerminalEnvName("OPENSSL_MODULES")).toBe(true);
    expect(blockedTerminalEnvName("OPENSSL_ENGINES")).toBe(true);
    expect(blockedTerminalEnvName("NODE_V8_COVERAGE")).toBe(true);
    expect(blockedTerminalEnvName("NODE_REDIRECT_WARNINGS")).toBe(true);
    expect(blockedTerminalEnvName("NODE_COMPILE_CACHE")).toBe(true);
    expect(blockedTerminalEnvName("CARGO_HOME")).toBe(true);
    expect(blockedTerminalEnvName("CARGO_BUILD_RUSTFLAGS")).toBe(true);
    expect(blockedTerminalEnvName("CARGO_ENCODED_RUSTFLAGS")).toBe(true);
    expect(blockedTerminalEnvName("GOROOT")).toBe(true);
    expect(blockedTerminalEnvName("CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER")).toBe(true);
    expect(blockedTerminalEnvName("CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER")).toBe(true);
    expect(blockedTerminalEnvName("CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUSTFLAGS")).toBe(true);
    expect(blockedTerminalEnvName("DYLD_VERSIONED_LIBRARY_PATH")).toBe(true);
    expect(blockedTerminalEnvName("DYLD_VERSIONED_FRAMEWORK_PATH")).toBe(true);
    expect(blockedTerminalEnvName("CARGO_TARGET_DIR")).toBe(false);
    expect(blockedTerminalEnvName("PATH")).toBe(false);
    expect(blockedTerminalEnvName("TERM")).toBe(false);
    expect(blockedTerminalEnvName("npm_config")).toBe(false);
    expect(blockedTerminalEnvName("npm_lifecycle_event")).toBe(false);
  });

  it("drops blocked names from the inherited host environment", () => {
    const env = terminalChildEnv({
      PATH: "/usr/bin",
      TERM: "xterm",
      GIT_TRACE: "/tmp/trace",
      GIT_TRACE2_EVENT: "/tmp/trace2",
      LD_PRELOAD: "/tmp/evil.so",
      NODE_OPTIONS: "--require /tmp/x.js",
      JAVA_TOOL_OPTIONS: "-javaagent:/tmp/x.jar",
      DOTNET_STARTUP_HOOKS: "/tmp/hook.dll",
      SSLKEYLOGFILE: "/tmp/keys",
      HOME: "/home/user",
      PYTHONUSERBASE: "/tmp/pyuser",
      ZDOTDIR: "/tmp/zsh",
      PERLLIB: "/tmp/perl",
      npm_config_script_shell: "/tmp/evil-sh",
      NPM_CONFIG_SCRIPT_SHELL: "/tmp/evil-sh",
      npm_lifecycle_event: "test",
      GOFLAGS: "-toolexec=/tmp/evil",
      RUSTC: "/tmp/rustc",
      RUSTC_WRAPPER: "/tmp/wrap",
      CARGO_BUILD_RUSTC: "/tmp/rustc",
      CARGO_BUILD_RUSTC_WRAPPER: "/tmp/wrap",
      CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: "/tmp/wrap-ws",
      RUSTC_WORKSPACE_WRAPPER: "/tmp/wrap-ws",
      LD_DEBUG: "libs",
      LD_DEBUG_OUTPUT: "/tmp/ld",
      PYTHONPYCACHEPREFIX: "/tmp/pyc",
      OPENSSL_MODULES: "/tmp/modules",
      OPENSSL_ENGINES: "/tmp/engines",
      NODE_V8_COVERAGE: "/tmp/cov",
      NODE_REDIRECT_WARNINGS: "/tmp/warnings",
      NODE_COMPILE_CACHE: "/tmp/cache",
      CARGO_HOME: "/tmp/cargo-home",
      CARGO_BUILD_RUSTFLAGS: "-C linker=/tmp/ld",
      CARGO_ENCODED_RUSTFLAGS: "-C\u001flinker=/tmp/ld",
      GOROOT: "/tmp/goroot",
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: "/tmp/ld",
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER: "/tmp/run",
      DYLD_VERSIONED_LIBRARY_PATH: "/tmp/dyld",
      DYLD_VERSIONED_FRAMEWORK_PATH: "/tmp/fw",
      CARGO_TARGET_DIR: "/tmp/target",
      RUSTFLAGS: "-C debuginfo=0",
      NODE_DEBUG: "http",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.TERM).toBe("xterm");
    expect(env.HOME).toBe("/home/user");
    expect(env.GIT_TRACE).toBeUndefined();
    expect(env.GIT_TRACE2_EVENT).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.JAVA_TOOL_OPTIONS).toBeUndefined();
    expect(env.DOTNET_STARTUP_HOOKS).toBeUndefined();
    expect(env.SSLKEYLOGFILE).toBeUndefined();
    expect(env.PYTHONUSERBASE).toBeUndefined();
    expect(env.ZDOTDIR).toBeUndefined();
    expect(env.PERLLIB).toBeUndefined();
    expect(env.npm_config_script_shell).toBeUndefined();
    expect(env.NPM_CONFIG_SCRIPT_SHELL).toBeUndefined();
    expect(env.npm_lifecycle_event).toBe("test");
    expect(env.GOFLAGS).toBeUndefined();
    expect(env.RUSTC).toBeUndefined();
    expect(env.RUSTC_WRAPPER).toBeUndefined();
    expect(env.CARGO_BUILD_RUSTC).toBeUndefined();
    expect(env.CARGO_BUILD_RUSTC_WRAPPER).toBeUndefined();
    expect(env.CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER).toBeUndefined();
    expect(env.RUSTC_WORKSPACE_WRAPPER).toBeUndefined();
    expect(env.LD_DEBUG).toBeUndefined();
    expect(env.LD_DEBUG_OUTPUT).toBeUndefined();
    expect(env.PYTHONPYCACHEPREFIX).toBeUndefined();
    expect(env.OPENSSL_MODULES).toBeUndefined();
    expect(env.OPENSSL_ENGINES).toBeUndefined();
    expect(env.NODE_V8_COVERAGE).toBeUndefined();
    expect(env.NODE_REDIRECT_WARNINGS).toBeUndefined();
    expect(env.NODE_COMPILE_CACHE).toBeUndefined();
    expect(env.CARGO_HOME).toBeUndefined();
    expect(env.CARGO_BUILD_RUSTFLAGS).toBeUndefined();
    expect(env.CARGO_ENCODED_RUSTFLAGS).toBeUndefined();
    expect(env.GOROOT).toBeUndefined();
    expect(env.CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER).toBeUndefined();
    expect(env.CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER).toBeUndefined();
    expect(env.DYLD_VERSIONED_LIBRARY_PATH).toBeUndefined();
    expect(env.DYLD_VERSIONED_FRAMEWORK_PATH).toBeUndefined();
    expect(env.CARGO_TARGET_DIR).toBe("/tmp/target");
    expect(env.RUSTFLAGS).toBe("-C debuginfo=0");
    expect(env.NODE_DEBUG).toBe("http");
  });

  it("scrubs the same blocked names from harness spawn env", () => {
    const env = harnessChildEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-test",
      GIT_TRACE: "/tmp/trace",
      NODE_OPTIONS: "--require /tmp/x.js",
      LD_PRELOAD: "/tmp/evil.so",
      JAVA_TOOL_OPTIONS: "-javaagent:/tmp/x.jar",
      OPENSSL_CONF: "/tmp/evil.cnf",
      PYTHONUSERBASE: "/tmp/pyuser",
      ZDOTDIR: "/tmp/zsh",
      PERLLIB: "/tmp/perl",
      Npm_Config_script_shell: "/tmp/evil-sh",
      GOFLAGS: "-toolexec=/tmp/evil",
      RUSTC_WRAPPER: "/tmp/wrap",
      CARGO_BUILD_RUSTC: "/tmp/rustc",
      CARGO_BUILD_RUSTC_WRAPPER: "/tmp/wrap",
      LD_DEBUG_OUTPUT: "/tmp/ld",
      PYTHONPYCACHEPREFIX: "/tmp/pyc",
      OPENSSL_MODULES: "/tmp/modules",
      NODE_V8_COVERAGE: "/tmp/cov",
      NODE_REDIRECT_WARNINGS: "/tmp/warnings",
      NODE_COMPILE_CACHE: "/tmp/cache",
      CARGO_HOME: "/tmp/cargo-home",
      GOROOT: "/tmp/goroot",
      CARGO_ENCODED_RUSTFLAGS: "-C\u001flinker=/tmp/ld",
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: "/tmp/ld",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(env.GIT_TRACE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.JAVA_TOOL_OPTIONS).toBeUndefined();
    expect(env.OPENSSL_CONF).toBeUndefined();
    expect(env.PYTHONUSERBASE).toBeUndefined();
    expect(env.ZDOTDIR).toBeUndefined();
    expect(env.PERLLIB).toBeUndefined();
    expect(env.Npm_Config_script_shell).toBeUndefined();
    expect(env.GOFLAGS).toBeUndefined();
    expect(env.RUSTC_WRAPPER).toBeUndefined();
    expect(env.CARGO_BUILD_RUSTC).toBeUndefined();
    expect(env.CARGO_BUILD_RUSTC_WRAPPER).toBeUndefined();
    expect(env.LD_DEBUG_OUTPUT).toBeUndefined();
    expect(env.PYTHONPYCACHEPREFIX).toBeUndefined();
    expect(env.OPENSSL_MODULES).toBeUndefined();
    expect(env.NODE_V8_COVERAGE).toBeUndefined();
    expect(env.NODE_REDIRECT_WARNINGS).toBeUndefined();
    expect(env.NODE_COMPILE_CACHE).toBeUndefined();
    expect(env.CARGO_HOME).toBeUndefined();
    expect(env.GOROOT).toBeUndefined();
    expect(env.CARGO_ENCODED_RUSTFLAGS).toBeUndefined();
    expect(env.CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER).toBeUndefined();
  });

  it("rejects a create that cannot start", () => {
    expect(() => assertTerminalCreateParams({ command: "", args: [] })).toThrow(/command required/);
    expect(() => assertTerminalCreateParams({ command: "echo", args: "nope" })).toThrow(/array/);
    expect(() =>
      assertTerminalCreateParams({ command: "echo", args: ["ok"], outputByteLimit: -1 }),
    ).toThrow(/outputByteLimit/);
  });
});

describe("TerminalTable", () => {
  const tables: TerminalTable[] = [];

  afterEach(() => {
    for (const table of tables.splice(0)) table.closeSession();
  });

  function table(): TerminalTable {
    const created = new TerminalTable();
    tables.push(created);
    return created;
  }

  it("returns the tail after the process exits", async () => {
    const terminals = table();
    const { terminalId } = terminals.create({
      sessionId: "s",
      command: process.execPath,
      args: ["-e", "process.stdout.write('ééXYZ')"],
      cwd: process.cwd(),
      env: process.env,
      outputByteLimit: 4,
    });
    await terminals.wait("s", terminalId);
    const out = terminals.output("s", terminalId);
    expect(out.output).toBe("XYZ");
    expect(out.truncated).toBe(true);
    expect(out.exitStatus?.exitCode).toBe(0);
  });

  it("kill keeps the id and release frees it", async () => {
    const terminals = table();
    const { terminalId } = terminals.create({
      sessionId: "s",
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello-term'); setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: process.env,
    });
    const deadline = Date.now() + 3_000;
    let output = "";
    while (Date.now() < deadline) {
      output = terminals.output("s", terminalId).output;
      if (output.includes("hello-term")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(output).toContain("hello-term");
    terminals.kill("s", terminalId);
    await terminals.wait("s", terminalId);
    expect(terminals.output("s", terminalId).output).toContain("hello-term");
    expect(terminals.output("s", terminalId).exitStatus).toBeDefined();
    terminals.release("s", terminalId);
    expect(() => terminals.output("s", terminalId)).toThrow(/unknown terminal/);
  });

  it("SIGKILLs a command that ignores SIGTERM and keeps the id", async () => {
    const terminals = table();
    const { terminalId } = terminals.create({
      sessionId: "s",
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('up'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      cwd: process.cwd(),
      env: process.env,
    });
    const ready = Date.now() + 3_000;
    while (Date.now() < ready && !terminals.output("s", terminalId).output.includes("up")) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(terminals.output("s", terminalId).output).toContain("up");
    terminals.kill("s", terminalId);
    const status = await terminals.wait("s", terminalId);
    expect(status.signal).toBe("SIGKILL");
    expect(terminals.output("s", terminalId).exitStatus?.signal).toBe("SIGKILL");
  }, 10_000);

  it("interruptSession stops a live command and keeps the id", async () => {
    const terminals = table();
    const { terminalId } = terminals.create({
      sessionId: "s",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: process.env,
    });
    terminals.interruptSession("other");
    expect(terminals.output("s", terminalId).exitStatus).toBeUndefined();
    terminals.interruptSession("s");
    const status = await terminals.wait("s", terminalId);
    expect(status.signal === "SIGTERM" || status.signal === "SIGKILL").toBe(true);
    expect(terminals.output("s", terminalId).output).toBe("");
  });

  it("does not let another session read the terminal", async () => {
    const terminals = table();
    const { terminalId } = terminals.create({
      sessionId: "owner",
      command: process.execPath,
      args: ["-e", "process.stdout.write('secret')"],
      cwd: process.cwd(),
      env: process.env,
    });
    await terminals.wait("owner", terminalId);
    expect(() => terminals.output("other", terminalId)).toThrow(/unknown terminal/);
    expect(terminals.output("owner", terminalId).output).toBe("secret");
    expect(() => terminals.kill("owner", "missing")).toThrow(/unknown terminal/);
    expect(() => terminals.release("other", terminalId)).toThrow(/unknown terminal/);
  });

  it("drops exited terminals only when the session is at the cap", async () => {
    const terminals = table();
    const exited: string[] = [];
    for (let i = 0; i < MAX_TERMINALS_PER_SESSION - 1; i++) {
      exited.push(
        terminals.create({
          sessionId: "s",
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: process.cwd(),
          env: process.env,
        }).terminalId,
      );
    }
    const live = terminals.create({
      sessionId: "s",
      command: process.execPath,
      args: ["-e", "process.stdout.write('still-live'); setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: process.env,
    }).terminalId;
    await Promise.all(exited.map((id) => terminals.wait("s", id)));
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !terminals.output("s", live).output.includes("still-live")) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(terminals.output("s", live).output).toContain("still-live");
    expect(terminals.output("s", exited[0]!).output).toBe("");
    const extra = terminals.create({
      sessionId: "s",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      env: process.env,
    });
    expect(extra.terminalId).toBeTruthy();
    expect(() => terminals.output("s", exited[0]!)).toThrow(/unknown terminal/);
    expect(terminals.output("s", live).output).toContain("still-live");
    await terminals.wait("s", extra.terminalId);
  });
});

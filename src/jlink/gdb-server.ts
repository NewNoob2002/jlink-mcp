import { ProcessManager, ManagedProcess } from "../utils/process-manager";
import { log, logError } from "../utils/logger";
import * as path from "path";

export interface GDBServerConfig {
  installDir: string;
  device: string;
  interface: "SWD" | "JTAG";
  speed: number;
  serialNumber?: string;
  gdbPort: number;
  rttTelnetPort: number;
  swoTelnetPort: number;
}

const GDB_SERVER_PROCESS_NAME = "jlink-gdb-server";

/** Shared J-Link GDB Server lifecycle used by the extension and MCP backend. */
export class GDBServerManager {
  private processManager: ProcessManager;
  private configSource: () => GDBServerConfig;
  private outputBuffer: string[] = [];
  private maxOutputLines = 1000;

  constructor(processManager: ProcessManager, configSource: () => GDBServerConfig) {
    this.processManager = processManager;
    this.configSource = configSource;
  }

  private get config(): GDBServerConfig {
    return this.configSource();
  }

  /** Start JLinkGDBServer and wait until it accepts connections. */
  async start(): Promise<{ success: boolean; message: string }> {
    if (this.processManager.get(GDB_SERVER_PROCESS_NAME)) {
      return { success: true, message: "GDB Server is already running" };
    }

    const config = this.config;
    const serverExe = process.platform === "win32" ? "JLinkGDBServerCL.exe" : "JLinkGDBServerCLExe";
    const args = [
      "-device", config.device,
      "-if", config.interface,
      "-speed", String(config.speed),
      "-port", String(config.gdbPort),
      "-RTTTelnetPort", String(config.rttTelnetPort),
      "-SWOPort", String(config.swoTelnetPort),
      "-vd", "-noir", "-LocalhostOnly", "1", "-NoGui", "1",
    ];
    if (config.serialNumber) args.push("-select", `USB=${config.serialNumber}`);

    let lastDetail = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const managed = this.processManager.spawn(
          GDB_SERVER_PROCESS_NAME,
          config.installDir ? path.join(config.installDir, serverExe) : serverExe,
          args,
        );
        this.attachOutput(managed);

        const ready = await this.awaitReady(managed);
        if (ready.ok) {
          return {
            success: true,
            message: `GDB Server started on port ${config.gdbPort}, RTT telnet on port ${config.rttTelnetPort}`,
          };
        }

        lastDetail = ready.detail;
        this.processManager.kill(GDB_SERVER_PROCESS_NAME);
        this.outputBuffer = [];
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500));
      } catch (err) {
        logError("Failed to start GDB Server", err);
        return { success: false, message: `Failed to start GDB Server: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    const contended = /in use|already|another|cannot open|failed to open/i.test(lastDetail);
    const targetSide = /could not connect to target|no target|target voltage/i.test(lastDetail);
    return {
      success: false,
      message:
        `GDB Server failed to start after 3 attempts. It said: ${lastDetail}\n` +
        (targetSide
          ? "That is a target-side failure: check target power and the debug connection."
          : contended
          ? "Another J-Link GDB server or J-Link client may be holding the probe."
            : "Check the GDB server output for details."),
    };
  }

  private attachOutput(managed: ManagedProcess): void {
    managed.process.stdout?.on("data", (data: Buffer) => this.recordOutput(data.toString(), false));
    managed.process.stderr?.on("data", (data: Buffer) => this.recordOutput(data.toString(), true));
  }

  private recordOutput(text: string, error: boolean): void {
    for (const line of text.split("\n").filter(Boolean)) {
      (error ? logError : log)(`[GDB Server] ${line}`);
      this.outputBuffer.push(error ? `[ERR] ${line}` : line);
      if (this.outputBuffer.length > this.maxOutputLines) this.outputBuffer.shift();
    }
  }

  private awaitReady(
    managed: ManagedProcess,
    timeoutMs = 15000,
  ): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean, detail: string) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        resolve({ ok, detail });
      };

      const poll = setInterval(() => {
        const text = this.outputBuffer.join("\n");
        if (/waiting for gdb connection/i.test(text)) finish(true, "ready");
        const failure = text.match(/(connecting to j-link failed[^\n]*|could not connect to j-link[^\n]*)/i);
        if (failure) finish(false, failure[1].trim());
      }, 50);

      managed.process.once("exit", (code) => {
        const text = this.outputBuffer.join("\n");
        const reason = text.match(/(connecting to j-link failed[^\n]*)/i)?.[1];
        finish(false, reason
          ? `${reason.trim()} (exit code ${code}). Another process may hold the probe.`
          : `server exited with code ${code} before accepting connections`);
      });

      const timer = setTimeout(() => finish(false, `no readiness banner within ${timeoutMs} ms`), timeoutMs);
    });
  }

  stop(): { success: boolean; message: string } {
    const killed = this.processManager.kill(GDB_SERVER_PROCESS_NAME);
    this.outputBuffer = [];
    return { success: true, message: killed ? "GDB Server stopped" : "GDB Server was not running" };
  }

  isRunning(): boolean {
    return !!this.processManager.get(GDB_SERVER_PROCESS_NAME);
  }

  getRecentOutput(lines = 50): string[] {
    return this.outputBuffer.slice(-lines);
  }

  getStatus(): {
    running: boolean;
    gdbPort: number;
    rttTelnetPort: number;
    swoTelnetPort: number;
  } {
    const config = this.config;
    return {
      running: this.isRunning(),
      gdbPort: config.gdbPort,
      rttTelnetPort: config.rttTelnetPort,
      swoTelnetPort: config.swoTelnetPort,
    };
  }
}

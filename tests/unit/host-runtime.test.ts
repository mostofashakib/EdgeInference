import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectHost, executableCandidates, resolveExecutable } from "../../scripts/runtime/host-runtime.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("automatic host detection and executable paths", () => {
  it("detects the real OS, architecture, CPU and physical memory", () => {
    const host = detectHost();
    expect(host.platform).toBe(process.platform);
    expect(host.arch).toBe(process.arch);
    expect(host.cpuModel).toBe(os.cpus()[0]?.model ?? "unknown");
    expect(host.logicalCpus).toBe(os.cpus().length);
    expect(host.totalMemoryBytes).toBe(os.totalmem());
  });

  it("selects ARM Homebrew before Intel Homebrew when PATH has neither", () => {
    const candidates = executableCandidates("nginx", { platform: "darwin", arch: "arm64" }, {});
    expect(candidates).toContain("/opt/homebrew/bin/nginx");
    expect(candidates.indexOf("/opt/homebrew/bin/nginx")).toBeLessThan(candidates.indexOf("/usr/local/bin/nginx"));
  });

  it("selects Intel Homebrew first on Intel macOS", () => {
    const candidates = executableCandidates("nginx", { platform: "darwin", arch: "x64" }, {});
    expect(candidates.indexOf("/usr/local/bin/nginx")).toBeLessThan(candidates.indexOf("/opt/homebrew/bin/nginx"));
  });

  it("uses Linux system executable and service directories", () => {
    expect(executableCandidates("nginx", { platform: "linux", arch: "x64" }, {})).toContain("/usr/sbin/nginx");
  });

  it("uses Windows native executables, case-insensitive PATH, and per-user Ollama install", () => {
    const candidates = executableCandidates("ollama", { platform: "win32", arch: "x64" }, {
      Path: "D:\\Tools;E:\\Tools With Spaces", LOCALAPPDATA: "C:\\Users\\Tester\\AppData\\Local"
    });
    expect(candidates[0]).toBe("D:\\Tools\\ollama.exe");
    expect(candidates).toContain("E:\\Tools With Spaces\\ollama.exe");
    expect(candidates).toContain("C:\\Users\\Tester\\AppData\\Local\\Programs\\Ollama\\ollama.exe");
  });

  it("respects the first executable on PATH, including spaces", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "edge executable "));
    directories.push(directory);
    const binary = path.join(directory, process.platform === "win32" ? "nginx.exe" : "nginx");
    writeFileSync(binary, "test executable");
    chmodSync(binary, 0o755);
    expect(resolveExecutable("nginx", detectHost(), { PATH: directory })).toBe(binary);
  });

  it("fails clearly for an invalid explicit path instead of ignoring configuration", () => {
    expect(() => resolveExecutable("nginx", detectHost(), { NGINX_BIN: "/missing/edge-nginx" })).toThrow(/NGINX_BIN/);
  });

  it("uses a configured executable path for a custom installation", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "edge-custom-"));
    directories.push(directory);
    const binary = path.join(directory, "custom-nginx");
    writeFileSync(binary, "test executable");
    chmodSync(binary, 0o755);
    expect(resolveExecutable("nginx", detectHost(), { NGINX_BIN: binary })).toBe(binary);
  });
});

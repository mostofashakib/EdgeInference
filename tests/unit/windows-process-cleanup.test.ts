import { EventEmitter } from "node:events";
import { execFile, type ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { terminateManagedProcess } from "../../scripts/runtime/service-supervisor.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn()
}));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it("terminates a Windows service and its runner descendants together", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, exitCode: null, signalCode: null,
    kill: vi.fn(() => { child.emit("exit", 0); return true; })
  });
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    queueMicrotask(() => { child.emit("exit", 0); callback(null, "", ""); });
    return child as unknown as ChildProcess;
  });
  await terminateManagedProcess(child as unknown as ChildProcess);
  expect(execFile).toHaveBeenCalledWith("taskkill", ["/PID", "12345", "/T", "/F"], { timeout: 5000 }, expect.any(Function));
  expect(child.kill).not.toHaveBeenCalled();
});

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it.skipIf(process.platform === "win32")("both shell scripts handle a minimal PATH without starting services", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "edge-shell-"));
  directories.push(directory);
  for (const tool of ["dirname", "uname"]) {
    writeFileSync(path.join(directory, tool), `#!/bin/sh\nexec /usr/bin/${tool} "$@"\n`);
    chmodSync(path.join(directory, tool), 0o755);
  }
  for (const script of ["run.sh", "kill.sh"]) {
    const result = spawnSync("/bin/bash", [path.resolve(script), "--help"], {
      env: { PATH: directory, HOME: directory }, encoding: "utf8"
    });
    expect([0, 1]).toContain(result.status);
    if (result.status === 0) expect(result.stdout).toContain("Usage:");
    else expect(result.stderr).toContain("Node.js 24 or newer");
  }
});

it.skipIf(process.platform === "win32")("forwards arguments and reports an outdated Node runtime clearly", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "edge-shell-"));
  directories.push(directory);
  writeFileSync(path.join(directory, "node"), "#!/bin/sh\nif [ \"$1\" = \"-p\" ]; then echo 18; else echo 'legacy node invoked'; exit 42; fi\n");
  chmodSync(path.join(directory, "node"), 0o755);
  const result = spawnSync("/bin/bash", [path.resolve("run.sh"), "--help"], {
    env: { PATH: directory, HOME: directory }, encoding: "utf8"
  });
  expect(`${result.stdout}${result.stderr}`).not.toContain("legacy node invoked");
  if (result.status === 0) expect(result.stdout).toContain("Usage:");
  else {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Node.js 24 or newer");
  }
});

it.skipIf(process.platform === "win32")("both scripts forward arguments to the shared launcher from another directory", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "edge-shell-"));
  directories.push(directory);
  writeFileSync(path.join(directory, "node"), '#!/bin/sh\nif [ "$1" = "-p" ]; then echo 24; else printf "%s\\n" "$@"; fi\n');
  chmodSync(path.join(directory, "node"), 0o755);
  for (const [script, action] of [["run.sh", "start"], ["kill.sh", "stop"]]) {
    const output = execFileSync("/bin/bash", [path.resolve(script!), "--help"], {
      cwd: directory, env: { PATH: directory, HOME: directory }, encoding: "utf8"
    });
    expect(output.trim().split("\n")).toEqual(["--import", "tsx", "scripts/runtime/launcher.ts", action, "--help"]);
  }
});

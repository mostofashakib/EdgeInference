import os from "node:os";
import net from "node:net";
import Database from "better-sqlite3";
import sharp from "sharp";

interface PortCheckResult {
  port: number;
  inUse: boolean;
  details?: string;
}

function checkPort(port: number, host = "127.0.0.1"): Promise<PortCheckResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);

    socket.once("connect", () => {
      socket.destroy();
      resolve({ port, inUse: true, details: `Connection established on ${host}:${port}` });
    });

    socket.once("timeout", () => {
      socket.destroy();
      resolve({ port, inUse: false, details: `Timeout connecting to ${host}:${port}` });
    });

    socket.once("error", (err: NodeJS.ErrnoException) => {
      socket.destroy();
      if (err.code === "ECONNREFUSED") {
        resolve({ port, inUse: false, details: `Port ${port} is free (ECONNREFUSED)` });
      } else {
        resolve({ port, inUse: false, details: `Port ${port} error: ${err.message}` });
      }
    });

    socket.connect(port, host);
  });
}

export async function runEnvironmentAudit(): Promise<{
  arch: string;
  nodeVersion: string;
  totalMemoryGiB: number;
  nativeModulesLoaded: boolean;
  ports: PortCheckResult[];
  passed: boolean;
}> {
  const arch = process.arch;
  const nodeVersion = process.version;
  const totalMemoryBytes = os.totalmem();
  const totalMemoryGiB = Math.round((totalMemoryBytes / (1024 * 1024 * 1024)) * 100) / 100;

  // Test native SQLite in-memory
  let nativeModulesLoaded = false;
  try {
    const db = new Database(":memory:");
    db.prepare("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)").run();
    db.prepare("INSERT INTO test (val) VALUES (?)").run("ok");
    const row = db.prepare("SELECT val FROM test WHERE id = 1").get() as { val: string } | undefined;
    db.close();

    // Test sharp instantiation
    const sharpInstance = sharp({
      create: {
        width: 10,
        height: 10,
        channels: 3,
        background: { r: 255, g: 0, b: 0 }
      }
    });
    const buffer = await sharpInstance.png().toBuffer();

    if (row?.val === "ok" && buffer.length > 0) {
      nativeModulesLoaded = true;
    }
  } catch (err) {
    console.error("Native module verification failed:", err);
    nativeModulesLoaded = false;
  }

  // Check critical ports: 8080 (Nginx), 8765 (Gateway), 11434 (Ollama)
  const port8080 = await checkPort(8080);
  const port8765 = await checkPort(8765);
  const port11434 = await checkPort(11434);

  const passed =
    arch === "arm64" &&
    nodeVersion.startsWith("v24.") &&
    totalMemoryGiB >= 32 &&
    nativeModulesLoaded &&
    !port8765.inUse;

  return {
    arch,
    nodeVersion,
    totalMemoryGiB,
    nativeModulesLoaded,
    ports: [port8080, port8765, port11434],
    passed
  };
}

// Direct CLI execution
if (process.argv[1]?.endsWith("audit-environment.ts") || process.argv[1]?.endsWith("audit-environment.js")) {
  console.log("=== EdgeInference M0 Environment & Service Diagnostic ===");
  runEnvironmentAudit()
    .then((result) => {
      console.log(`Architecture: ${result.arch} (Expected: arm64)`);
      console.log(`Node.js Version: ${result.nodeVersion} (Expected: >= v24)`);
      console.log(`Unified Memory: ${result.totalMemoryGiB} GiB (Threshold: >= 32 GiB)`);
      console.log(`Native Modules (better-sqlite3, sharp): ${result.nativeModulesLoaded ? "OK" : "FAILED"}`);
      console.log("Service Port Inspection:");
      for (const p of result.ports) {
        console.log(`  - Port ${p.port}: ${p.inUse ? "IN USE" : "FREE"} (${p.details})`);
      }
      console.log("---------------------------------------------------------");
      console.log(`Diagnostic Status: ${result.passed ? "PASS" : "FAIL"}`);
      if (!result.passed) {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error("Audit error:", err);
      process.exitCode = 1;
    });
}

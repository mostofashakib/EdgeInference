import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config/AppConfig.js";
import { createDependencies } from "./composition/createDependencies.js";
import { createApp } from "./app.js";

// Centralize local configuration: automatically load .env if present
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const dependencies = createDependencies(config);
  const app = createApp(dependencies);

  try {
    const address = await app.listen({ port: config.port, host: config.host });
    console.log(`EdgeInference Gateway listening on ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only start when invoked directly
if (process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js")) {
  main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}

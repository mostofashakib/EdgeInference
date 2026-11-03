import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../gateway/src/config/AppConfig.js";
import { createServiceCommands, renderNginxConfig } from "../../scripts/runtime/launcher.js";

const tools = { nginx: "nginx", cloudflared: "cloudflared" };
const config = loadConfig({ LLM_API_SECRET: "secret", PORT: "9000" });

describe("portable launcher", () => {
  it("starts the gateway using the current Node executable and keeps Nginx in the foreground", () => {
    const commands = createServiceCommands(config, "/project with spaces", false, {}, tools);
    expect(commands[0]?.command).toBe(process.execPath);
    expect(commands[0]?.args).toEqual(["--import", "tsx", path.join("/project with spaces", "gateway/src/main.ts")]);
    expect(commands[1]?.command).toBe("nginx");
    expect(commands[1]?.args).toContain("daemon off;");
    expect(commands).toHaveLength(2);
  });

  it("renders configured gateway port without dropping proxy security rules", () => {
    const source = "server 127.0.0.1:8765;\nlimit_req zone=api_limit burst=3 nodelay;";
    expect(renderNginxConfig(source, config)).toBe("error_log infra/nginx/error.log warn;\nserver 127.0.0.1:9000;\nlimit_req zone=api_limit burst=3 nodelay;");
  });

  it("brackets IPv6 upstream addresses", () => {
    expect(renderNginxConfig("server 127.0.0.1:8765;", { ...config, host: "::1" })).toBe("error_log infra/nginx/error.log warn;\nserver [::1]:9000;");
  });

  it("points quick tunnels to the unchanged secured proxy", () => {
    const tunnel = createServiceCommands(config, "/project", true, {}, tools).at(-1);
    expect(tunnel?.command).toBe("cloudflared");
    expect(tunnel?.args).toEqual(["tunnel", "--url", "http://127.0.0.1:8080"]);
  });

  it("reads named tunnel credentials from configuration", () => {
    const tunnel = createServiceCommands(config, "/project", true, { CLOUDFLARE_TUNNEL_TOKEN: "configured-token" }, tools).at(-1);
    expect(tunnel?.args).toEqual(["tunnel", "run", "--token", "configured-token"]);
  });
});

it("places Nginx logs and temporary files in writable project paths", () => {
  const rendered = renderNginxConfig("events {}\nhttp {\n server 127.0.0.1:8765;\n}", config);
  expect(rendered).toContain("error_log infra/nginx/error.log warn;");
  for (const directive of ["client_body_temp_path", "proxy_temp_path", "fastcgi_temp_path", "uwsgi_temp_path", "scgi_temp_path"]) {
    expect(rendered).toContain(`${directive} data/nginx/`);
  }
});

it("uses the detected executable path instead of assuming PATH is configured", () => {
  const commands = createServiceCommands(config, "/project", false, {}, { nginx: "/installed/nginx" });
  expect(commands[1]?.command).toBe("/installed/nginx");
});


it("keeps tunnel tokens out of cloudflared's inherited environment", () => {
  const env = { PATH: "/bin", CF_TUNNEL_TOKEN: "configured-token", CLOUDFLARE_TUNNEL_TOKEN: "other-token", CF_ACCESS_CLIENT_SECRET: "access-secret", LLM_API_SECRET: "app-secret", LLM_API_SECRET_PREVIOUS: "old-secret", LLM_GUEST_API_KEYS: "guest-secret" };
  const tunnel = createServiceCommands(config, "/project", true, env, tools).at(-1);
  expect(tunnel?.env).toEqual({ PATH: "/bin" });
  expect(tunnel?.args).toEqual(["tunnel", "run", "--token", "other-token"]);
  expect(env.CF_TUNNEL_TOKEN).toBe("configured-token");
});

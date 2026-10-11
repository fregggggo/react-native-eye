#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { getRegistry } from "./core/registry.js";
import { sharedPool } from "./native/pool.js";
import { installShutdownHooks } from "./core/shutdown.js";

async function main() {
  const argIdx = process.argv.indexOf("--port");
  const cliPort = argIdx >= 0 ? Number(process.argv[argIdx + 1]) : undefined;
  const envPort = process.env.METRO_PORT ? Number(process.env.METRO_PORT) : undefined;
  const defaultPort = cliPort || envPort;
  if (defaultPort && !Number.isNaN(defaultPort)) getRegistry().setDefaultPort(defaultPort);

  const server = buildServer();
  const transport = new StdioServerTransport();
  const hooks = installShutdownHooks({ pool: sharedPool() });
  // Protocol.onclose fires when the transport closes (transport.close(), or
  // the SDK tearing the connection down).
  server.server.onclose = () => void hooks.shutdown("transport closed", 0);
  await server.connect(transport);
  console.error("[react-native-eye] server started on stdio");
}

main().catch((err) => {
  console.error("[react-native-eye] fatal:", err);
  process.exit(1);
});

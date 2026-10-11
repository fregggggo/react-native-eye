import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerConnectionTools } from "./tools/connection.js";
import { registerLogTools } from "./tools/logs.js";
import { registerErrorTools } from "./tools/errors.js";
import { registerNetworkTools } from "./tools/network.js";
import { registerRuntimeTools } from "./tools/runtime.js";
import { registerStateTools } from "./tools/state.js";
import { registerScreenshotTools } from "./tools/screenshot.js";
import { registerOcrTools } from "./tools/ocr.js";
import { registerLayoutTools } from "./tools/layout.js";
import { registerInteractionTools } from "./tools/interact.js";
import { registerDeviceTools } from "./tools/devices.js";
import { registerObserveTools } from "./composite/observe.js";
import { registerCheckStateTools } from "./composite/checkState.js";
import { registerRunFlowTools } from "./composite/runFlow.js";
import { registerRecordingTools } from "./tools/recording.js";
import { registerNavigationTools } from "./tools/navigation.js";
import { registerPerfTools } from "./tools/perf.js";
import { registerRenderTools } from "./tools/renders.js";
import { registerJsProfileTools } from "./tools/jsProfile.js";

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "react-native-eye", version: "0.0.1" },
    {
      instructions:
        "React Native runtime debugging via Metro/CDP. Prefer the composite tools (observe, run_flow, check_state) — they collapse multi-step interactions into one call. Primitives (tap, get_logs, ...) are for targeted debugging.",
    },
  );

  const filtered = new Set(
    (process.env.RNE_FILTERED_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (filtered.size > 0) {
    const original = server.registerTool.bind(server);
    (server as any).registerTool = (name: string, ...rest: any[]) =>
      filtered.has(name) ? undefined : (original as any)(name, ...rest);
  }

  server.registerTool(
    "ping",
    { title: "Ping", description: "Health check. Returns 'pong'.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );

  registerConnectionTools(server);
  registerLogTools(server);
  registerErrorTools(server);
  registerNetworkTools(server);
  registerRuntimeTools(server);
  registerStateTools(server);
  registerScreenshotTools(server);
  registerOcrTools(server);
  registerLayoutTools(server);
  registerInteractionTools(server);
  registerDeviceTools(server);
  registerObserveTools(server);
  registerCheckStateTools(server);
  registerRunFlowTools(server);
  registerRecordingTools(server);
  registerNavigationTools(server);
  registerPerfTools(server);
  registerRenderTools(server);
  registerJsProfileTools(server);

  return server;
}

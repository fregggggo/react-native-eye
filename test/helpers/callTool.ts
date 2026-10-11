import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function makeServer(): McpServer {
  return new McpServer({ name: "test", version: "0" });
}

export async function callTool(server: McpServer, name: string, args: any): Promise<any> {
  // @ts-expect-error internal registry, stable in SDK 1.x
  const tool = server._registeredTools[name];
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool.handler(args, {});
}

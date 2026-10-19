/**
 * 最小 MCP 服务器（测试夹具）：低层 Server + 裸 JSON Schema（不引 zod，避免 fixture 解析依赖）。
 * 一个 add(a,b) 工具 + 一个 isError 的 fail 工具。经 stdio 与宿主通信（不起网络）。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "mini-fixture", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "add",
      description: "Add two numbers",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
    { name: "fail", description: "Always fails", inputSchema: { type: "object", properties: {} } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "add") {
    const a = Number(req.params.arguments?.a ?? 0);
    const b = Number(req.params.arguments?.b ?? 0);
    return { content: [{ type: "text", text: String(a + b) }] };
  }
  return { content: [{ type: "text", text: "boom" }], isError: true };
});

await server.connect(new StdioServerTransport());

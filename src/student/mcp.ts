import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StudentBroker } from "./broker.js";
import { BrokerError, PRODUCTS, type Subject } from "./types.js";
export function createStudentMcp(broker: StudentBroker, subject: Subject): McpServer {
  const server = new McpServer({ name: "meta-student-broker", version: "1.0.0" });
  const result = async (run: () => unknown | Promise<unknown>) => {
    try { const data = await run(); return { content: [{ type: "text" as const, text: JSON.stringify(data) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof BrokerError ? error.code : "operation_failed" }) }] }; }
  };
  server.registerTool("meta_connections_catalog", { description: "Available Meta products for this authenticated subject. Configuration readiness does not prove live access.", inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } }, () => result(() => broker.catalog(subject)));
  server.registerTool("meta_connections_list", { description: "List this subject's own account connections, without credentials.", inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } }, () => result(() => broker.list(subject)));
  server.registerTool("meta_connections_begin", { description: "Begin one state-bound OAuth flow for this authenticated subject.", inputSchema: z.object({ product: z.enum(PRODUCTS) }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }, (args) => result(() => broker.begin(subject, args.product)));
  server.registerTool("meta_connections_disconnect", { description: "Disable this subject's connection and local credentials when its grant has no remaining active assets.", inputSchema: z.object({ connectionId: z.string().uuid() }).strict(), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } }, (args) => result(() => broker.disconnect(subject, args.connectionId)));
  server.registerTool("meta_connections_read", { description: "Read only a selected own asset using its actual granted capabilities. Comments require an owned mediaId. Inbox returns bounded metadata or retained webhook events.", inputSchema: z.object({ connectionId: z.string().uuid(), operation: z.enum(["account", "posts", "metrics", "comments", "inbox"]), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().regex(/^[A-Za-z0-9_=-]{1,2048}$/).optional(), mediaId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional() }).strict(), annotations: { readOnlyHint: true } }, (args) => result(() => broker.read(subject, args)));
  return server;
}

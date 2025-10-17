import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequest,
  CallToolRequestSchema,
  ListResourcesRequest,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequest,
  ReadResourceRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

type DiagramState = {
  scene: unknown | null;
  hint: string | null;
};

type UiBundle = {
  templateUri: string;
  html: string;
  meta: Record<string, unknown>;
  revision: string;
};

const UI_TEMPLATE_BASE = "ui://excalidraw/diagram.html";
const SERVER_NAME = "excalidraw-diagrammer";
const SERVER_VERSION = "0.1.0";

function resolveDistPath(relative: string) {
  const url = new URL(relative, import.meta.url);
  return fileURLToPath(url);
}

function loadUiBundle(): UiBundle {
  const indexPath = resolveDistPath("./dist/ui/index.html");

  let indexHtml: string;
  try {
    indexHtml = readFileSync(indexPath, "utf8");
  } catch (error) {
    throw new Error(
      "Missing built UI assets. Run `yarn build` in examples/openai-app before starting the MCP server.",
      { cause: error as Error },
    );
  }

  const scriptRegex =
    /<script\s+type="module"[^>]*\s+src="([^"]+)"[^>]*><\/script>/gi;
  const cssRegex = /<link\s+rel="stylesheet"[^>]*\s+href="([^"]+)"[^>]*>/gi;

  const scriptPaths: string[] = [];
  const cssPaths: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(indexHtml))) {
    scriptPaths.push(match[1]);
  }
  while ((match = cssRegex.exec(indexHtml))) {
    cssPaths.push(match[1]);
  }

  if (scriptPaths.length === 0) {
    throw new Error(
      "Unable to locate built script in dist/ui/index.html. Check the Vite build output.",
    );
  }

  const normalize = (asset: string) => {
    const stripped = asset.split(/[?#]/)[0] ?? asset;
    return stripped.startsWith("/")
      ? stripped.slice(1)
      : stripped.replace(/^\.\//, "");
  };

  const assetsDir = resolveDistPath("./dist/ui/");

  const scriptContents = scriptPaths.map((asset) => {
    const assetPath = path.join(assetsDir, normalize(asset));
    const js = readFileSync(assetPath, "utf8");
    return js.replace(/<\/script>/gi, "<\\/script>");
  });

  const cssContents = cssPaths.map((asset) => {
    const assetPath = path.join(assetsDir, normalize(asset));
    return readFileSync(assetPath, "utf8");
  });

  const revisionSource = [...scriptPaths, ...cssPaths].find((asset) => {
    const matchRevision = asset.match(/-([a-z0-9]{6,})\.[^.]+$/i);
    return matchRevision ? matchRevision[1] : null;
  });

  const revisionMatch =
    revisionSource?.match(/-([a-z0-9]{6,})\.[^.]+$/i)?.[1] ?? "dev";

  const templateUri =
    revisionMatch && !UI_TEMPLATE_BASE.includes("?")
      ? `${UI_TEMPLATE_BASE}?rev=${revisionMatch}`
      : `${UI_TEMPLATE_BASE}&rev=${revisionMatch}`;

  const html = [
    '<div id="root"></div>',
    cssContents.length
      ? `<style>${cssContents.join("\n")}</style>`
      : "<style></style>",
    "<script type=\"module\">",
    scriptContents.join("\n"),
    "</script>",
  ]
    .filter(Boolean)
    .join("\n");

  const meta = {
    "openai/outputTemplate": templateUri,
    "openai/toolInvocation/invoking": "Loading Excalidraw diagrammer…",
    "openai/toolInvocation/invoked": "Rendered the Excalidraw canvas.",
    "openai/widgetAccessible": true,
    "openai/resultCanProduceWidget": true,
  };

  return {
    templateUri,
    html,
    meta,
    revision: revisionMatch,
  };
}

const bundle = loadUiBundle();

const diagramInputSchema = z
  .object({
    action: z.enum(["apply", "update"]).optional(),
    scene: z.unknown().optional(),
    hint: z.string().optional(),
  })
  .passthrough();

let diagramState: DiagramState = {
  scene: null,
  hint: null,
};

function buildStructuredContent() {
  return {
    type: "excalidraw.diagram",
    templateUri: bundle.templateUri,
    revision: bundle.revision,
    scene: diagramState.scene,
    hint: diagramState.hint,
  };
}

function createDiagramServer(): Server {
  const mcpServer = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  mcpServer.setRequestHandler(
    ListResourcesRequestSchema,
    async (_request: ListResourcesRequest) => ({
      resources: [
        {
          uri: bundle.templateUri,
          name: "Excalidraw Diagram UI",
          description:
            "Inlined Excalidraw tool UI rendered inside the ChatGPT app panel.",
          mimeType: "text/html+skybridge",
          _meta: {
            "openai/widgetAccessible": true,
          },
        },
      ],
    }),
  );

  mcpServer.setRequestHandler(
    ReadResourceRequestSchema,
    async (_request: ReadResourceRequest) => ({
      contents: [
        {
          uri: bundle.templateUri,
          mimeType: "text/html+skybridge",
          text: bundle.html,
          _meta: bundle.meta,
        },
      ],
    }),
  );

  const toolDefinition: Tool = {
    name: "excalidraw_diagrammer",
    description:
      "Render and edit Excalidraw diagrams alongside the chat conversation.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["apply", "update"],
          description:
            "Whether to apply a new scene from the model or capture an update emitted by the UI.",
        },
        scene: {
          type: "object",
          description:
            "Serialized Excalidraw scene data to merge into the canvas.",
        },
        hint: {
          type: "string",
          description:
            "Optional helper text to display in the Excalidraw header.",
        },
      },
      required: [],
      additionalProperties: true,
    },
    _meta: bundle.meta,
  };

  mcpServer.setRequestHandler(
    ListToolsRequestSchema,
    async () => ({
      tools: [toolDefinition],
    }),
  );

  mcpServer.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      if (request.params.name !== toolDefinition.name) {
        throw new Error(`Unknown tool: ${request.params.name}`);
      }

      const args = diagramInputSchema.parse(request.params.arguments ?? {});
      const action = args.action ?? "apply";

      if (typeof args.scene !== "undefined") {
        diagramState = {
          ...diagramState,
          scene: args.scene,
        };
      }

      if (typeof args.hint === "string") {
        diagramState = {
          ...diagramState,
          hint: args.hint,
        };
      }

      const text =
        action === "update"
          ? "Captured the latest diagram changes."
          : "Applied the scene update to Excalidraw.";

      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
        structuredContent: buildStructuredContent(),
        _meta: bundle.meta,
      };
    },
  );

  return mcpServer;
}

type SessionRecord = {
  server: Server;
  transport: SSEServerTransport;
};

const sessions = new Map<string, SessionRecord>();

const SSE_PATH = "/mcp";
const POST_PATH = "/mcp/messages";

async function handleSseRequest(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const server = createDiagramServer();
  const transport = new SSEServerTransport(POST_PATH, res);
  const sessionId = transport.sessionId;

  sessions.set(sessionId, { server, transport });

  transport.onclose = async () => {
    sessions.delete(sessionId);
    await server.close().catch(() => {});
  };

  transport.onerror = (error) => {
    console.error("[excalidraw] SSE transport error", error);
  };

  try {
    await server.connect(transport);
  } catch (error) {
    sessions.delete(sessionId);
    console.error("[excalidraw] Failed to start SSE session", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to establish SSE connection");
    }
  }
}

async function handlePostMessage(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");

  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    res.writeHead(400).end("Missing sessionId query parameter");
    return;
  }

  const session = sessions.get(sessionId);

  if (!session) {
    res.writeHead(404).end("Unknown session");
    return;
  }

  try {
    await session.transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("[excalidraw] Failed to process message", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to process message");
    }
  }
}

const port = Number.parseInt(process.env.PORT ?? "8000", 10) || 8000;

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (
    req.method === "OPTIONS" &&
    (url.pathname === SSE_PATH || url.pathname === POST_PATH)
  ) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === SSE_PATH) {
    await handleSseRequest(res);
    return;
  }

  if (req.method === "POST" && url.pathname === POST_PATH) {
    await handlePostMessage(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  res.writeHead(404).end("Not found");
});

httpServer.listen(port, () => {
  console.log(
    `[excalidraw] MCP server listening on http://localhost:${port}${SSE_PATH}`,
  );
});

process.on("SIGTERM", () => {
  httpServer.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  httpServer.close(() => process.exit(0));
});

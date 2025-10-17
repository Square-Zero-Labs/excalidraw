import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

type ExcalidrawElement = Record<string, unknown> & {
  id: string;
  type: string;
};

type SceneData = {
  type?: string;
  version?: number;
  source?: string;
  elements?: ExcalidrawElement[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
  [key: string]: unknown;
};

type DiagramState = {
  scene: SceneData | null;
  hint: string | null;
};

type ElementDescriptor = {
  id?: string | null;
  text?: string | null;
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
const moduleDirname = path.dirname(fileURLToPath(import.meta.url));

function resolveDistPath(relative: string) {
  return path.resolve(moduleDirname, relative);
}

function loadUiBundle(): UiBundle {
  const indexPath = resolveDistPath("./dist/ui/index.html");

  let indexHtml: string;
  try {
    indexHtml = readFileSync(indexPath, "utf8");
  } catch (error) {
    const reason =
      error instanceof Error ? ` (${error.message})` : "";
    throw new Error(
      `Missing built UI assets. Run \`yarn build\` in examples/openai-app before starting the MCP server.${reason}`,
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
    scene: z.object({}).passthrough().optional(),
    hint: z.string().optional(),
    commands: z
      .array(
        z.discriminatedUnion("type", [
          z.object({
            type: z.literal("upsertElement"),
            element: z.object({}).passthrough(),
          }),
          z.object({
            type: z.literal("upsertElements"),
            elements: z.array(z.object({}).passthrough()).nonempty(),
          }),
          z.object({
            type: z.literal("removeElement"),
            selector: z
              .object({
                id: z.string().optional(),
                text: z.string().optional(),
              })
              .refine((value) => value.id || value.text, {
                message:
                  "Provide an id or text descriptor for the element to remove.",
              }),
            removeAll: z.boolean().optional(),
          }),
          z.object({
            type: z.literal("updateHint"),
            hint: z.string(),
          }),
          z.object({
            type: z.literal("resetScene"),
          }),
        ]),
      )
      .optional(),
  })
  .passthrough();

let diagramState: DiagramState = {
  scene: null,
  hint: null,
};

function buildStructuredContent() {
  const scene = ensureScene();
  return {
    type: "excalidraw.diagram",
    templateUri: bundle.templateUri,
    revision: bundle.revision,
    scene,
    hint: diagramState.hint,
  };
}

function ensureScene(): SceneData {
  if (!diagramState.scene || typeof diagramState.scene !== "object") {
    diagramState.scene = {
      type: "excalidraw",
      version: 2,
      source: "server",
      elements: [],
      appState: {},
      files: {},
    };
  }
  diagramState.scene.elements = diagramState.scene.elements ?? [];
  diagramState.scene.appState = diagramState.scene.appState ?? {};
  diagramState.scene.files = diagramState.scene.files ?? {};
  return diagramState.scene;
}

function randomInt32(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

function normalizeElement(raw: Record<string, unknown>): ExcalidrawElement {
  const now = Date.now();
  const id =
    typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id : randomUUID();
  const type =
    typeof raw.type === "string" && raw.type.trim().length > 0 ? raw.type : "rectangle";

  const normalized: Record<string, unknown> = {
    ...raw,
    id,
    type,
    x: typeof raw.x === "number" ? raw.x : 0,
    y: typeof raw.y === "number" ? raw.y : 0,
    angle: typeof raw.angle === "number" ? raw.angle : 0,
    strokeColor:
      typeof raw.strokeColor === "string" ? raw.strokeColor : "#1e1e1e",
    backgroundColor:
      typeof raw.backgroundColor === "string" ? raw.backgroundColor : "transparent",
    fillStyle: typeof raw.fillStyle === "string" ? raw.fillStyle : "hachure",
    strokeWidth: typeof raw.strokeWidth === "number" ? raw.strokeWidth : 1,
    strokeStyle:
      typeof raw.strokeStyle === "string" ? raw.strokeStyle : "solid",
    roughness: typeof raw.roughness === "number" ? raw.roughness : 1,
    opacity: typeof raw.opacity === "number" ? raw.opacity : 100,
    groupIds: Array.isArray(raw.groupIds) ? raw.groupIds : [],
    frameId: raw.frameId ?? null,
    seed: typeof raw.seed === "number" ? raw.seed : randomInt32(),
    version: typeof raw.version === "number" ? raw.version : 1,
    versionNonce:
      typeof raw.versionNonce === "number" ? raw.versionNonce : randomInt32(),
    isDeleted: typeof raw.isDeleted === "boolean" ? raw.isDeleted : false,
    boundElements: raw.boundElements ?? null,
    updated: typeof raw.updated === "number" ? raw.updated : now,
    link: raw.link ?? null,
    locked: typeof raw.locked === "boolean" ? raw.locked : false,
  };

  if (!("width" in normalized)) {
    normalized.width = typeof raw.width === "number" ? raw.width : 0;
  }
  if (!("height" in normalized)) {
    normalized.height = typeof raw.height === "number" ? raw.height : 0;
  }

  if (type === "text") {
    const fontSize =
      typeof raw.fontSize === "number" && Number.isFinite(raw.fontSize)
        ? raw.fontSize
        : 28;
    const lineHeight =
      typeof raw.lineHeight === "number" && Number.isFinite(raw.lineHeight)
        ? raw.lineHeight
        : 1.25;
    normalized.text = typeof raw.text === "string" ? raw.text : "";
    normalized.fontSize = fontSize;
    normalized.fontFamily =
      typeof raw.fontFamily === "number" ? raw.fontFamily : 1;
    normalized.textAlign =
      typeof raw.textAlign === "string" ? raw.textAlign : "center";
    normalized.verticalAlign =
      typeof raw.verticalAlign === "string" ? raw.verticalAlign : "middle";
    normalized.lineHeight = lineHeight;
    normalized.baseline =
      typeof raw.baseline === "number" && Number.isFinite(raw.baseline)
        ? raw.baseline
        : Math.round(fontSize * lineHeight);
  }

  return normalized as ExcalidrawElement;
}

function normalizeElements(rawElements: ReadonlyArray<Record<string, unknown>>): {
  elements: ExcalidrawElement[];
  ids: string[];
} {
  const elements = rawElements.map((raw) => normalizeElement(raw));
  const ids = elements.map((element) => element.id);
  return { elements, ids };
}

function removeByDescriptor(
  elements: ExcalidrawElement[],
  descriptor: ElementDescriptor,
  options?: { removeAll?: boolean },
): { next: ExcalidrawElement[]; removedIds: string[] } {
  const removeAll = options?.removeAll ?? false;
  const targetText =
    typeof descriptor.text === "string" ? descriptor.text.trim().toLowerCase() : null;

  let removedOne = false;
  const removedIds: string[] = [];

  const next = elements.filter((element) => {
    const matchesId = descriptor.id && element.id === descriptor.id;
    const matchesText =
      targetText &&
      typeof element.text === "string" &&
      element.text.trim().toLowerCase().includes(targetText);

    const matches = Boolean(matchesId || matchesText);
    if (!matches) {
      return true;
    }

    if (!removeAll && removedOne) {
      return true;
    }

    removedIds.push(element.id);
    removedOne = true;
    return false;
  });

  return { next, removedIds };
}

function mergeElements(
  existing: ExcalidrawElement[],
  incoming: ExcalidrawElement[],
): ExcalidrawElement[] {
  const incomingById = new Map(incoming.map((element) => [element.id, element]));
  const seen = new Set<string>();
  const merged = existing.map((element) => {
    const replacement = incomingById.get(element.id);
    if (replacement) {
      seen.add(element.id);
      return replacement;
    }
    return element;
  });

  incoming.forEach((element) => {
    if (!seen.has(element.id)) {
      merged.push(element);
    }
  });

  return merged;
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
      [
        "Render and edit an Excalidraw canvas alongside the chat. Provide a full serialized scene or issue targeted commands to tweak the diagram incrementally.",
        "",
        "Supported commands:",
        " - upsertElement: { type: \"upsertElement\", element: <Excalidraw element object> }",
        " - upsertElements: { type: \"upsertElements\", elements: [<element>, ...] }",
        " - removeElement: { type: \"removeElement\", selector: { id?: string, text?: string }, removeAll?: boolean }",
        " - updateHint: { type: \"updateHint\", hint: string }",
        " - resetScene: { type: \"resetScene\" }",
        "",
        "Element objects follow Excalidraw's serializeAsJSON format (id, type, x, y, width/height or points, strokeColor, strokeWidth, etc.). When unsure, reuse the shape emitted by diagram:update or the examples below.",
        "To label a node, add a separate text element (`type: \"text\"`) positioned over the associated shape and set `text`, `fontSize`, `textAlign`, and `verticalAlign`.",
        "",
        "Examples:",
        "1. Stick figure with arms and legs:",
        "{",
        "  \"commands\": [",
        "    {",
        "      \"type\": \"upsertElements\",",
        "      \"elements\": [",
        "        { \"id\": \"stick-head\", \"type\": \"ellipse\", \"x\": 200, \"y\": 120, \"width\": 80, \"height\": 80, \"strokeColor\": \"#1e1e1e\", \"strokeWidth\": 3, \"roughness\": 1, \"seed\": 11111, \"version\": 1, \"versionNonce\": 22222, \"isDeleted\": false },",
        "        { \"id\": \"stick-body\", \"type\": \"line\", \"x\": 240, \"y\": 200, \"width\": 0, \"height\": 140, \"points\": [[0,0],[0,140]], \"strokeColor\": \"#1e1e1e\", \"strokeWidth\": 3, \"roughness\": 1, \"seed\": 33333, \"version\": 1, \"versionNonce\": 44444, \"isDeleted\": false },",
        "        { \"id\": \"stick-arm-left\", \"type\": \"line\", \"x\": 240, \"y\": 230, \"width\": 100, \"height\": 60, \"points\": [[0,0],[-100,60]], \"strokeColor\": \"#1e1e1e\", \"strokeWidth\": 3, \"roughness\": 1, \"seed\": 55555, \"version\": 1, \"versionNonce\": 66666, \"isDeleted\": false },",
        "        { \"id\": \"stick-arm-right\", \"type\": \"line\", \"x\": 240, \"y\": 230, \"width\": 100, \"height\": 60, \"points\": [[0,0],[100,60]], \"strokeColor\": \"#1e1e1e\", \"strokeWidth\": 3, \"roughness\": 1, \"seed\": 77777, \"version\": 1, \"versionNonce\": 88888, \"isDeleted\": false },",
        "        { \"id\": \"stick-leg-left\", \"type\": \"line\", \"x\": 240, \"y\": 340, \"width\": 80, \"height\": 120, \"points\": [[0,0],[-80,120]], \"strokeColor\": \"#1e1e1e\", \"strokeWidth\": 3, \"roughness\": 1, \"seed\": 99999, \"version\": 1, \"versionNonce\": 10101, \"isDeleted\": false },",
        "        { \"id\": \"stick-leg-right\", \"type\": \"line\", \"x\": 240, \"y\": 340, \"width\": 80, \"height\": 120, \"points\": [[0,0],[80,120]], \"strokeColor\": \"#1e1e1e\", \"strokeWidth\": 3, \"roughness\": 1, \"seed\": 20202, \"version\": 1, \"versionNonce\": 30303, \"isDeleted\": false }",
        "      ]",
        "    },",
        "    { \"type\": \"updateHint\", \"hint\": \"Sketched a stick figure.\" }",
        "  ]",
        "}",
        "",
        "2. Three-step flow with arrows:",
        "{",
        "  \"commands\": [",
        "    {",
        "      \"type\": \"upsertElements\",",
        "      \"elements\": [",
        "        { \"id\": \"step-1\", \"type\": \"rectangle\", \"x\": 160, \"y\": 140, \"width\": 200, \"height\": 100, \"strokeColor\": \"#1e1e1e\", \"backgroundColor\": \"#f8fafc\", \"strokeWidth\": 2, \"roughness\": 1, \"seed\": 40101, \"version\": 1, \"versionNonce\": 40102, \"isDeleted\": false },",
        "        { \"id\": \"step-1-label\", \"type\": \"text\", \"x\": 190, \"y\": 175, \"width\": 140, \"height\": 40, \"text\": \"Step 1\", \"fontSize\": 28, \"fontFamily\": 1, \"textAlign\": \"center\", \"verticalAlign\": \"middle\", \"seed\": 40103, \"version\": 1, \"versionNonce\": 40104, \"isDeleted\": false },",
        "        { \"id\": \"step-2\", \"type\": \"rectangle\", \"x\": 420, \"y\": 140, \"width\": 200, \"height\": 100, \"strokeColor\": \"#1e1e1e\", \"backgroundColor\": \"#f1f5f9\", \"strokeWidth\": 2, \"roughness\": 1, \"seed\": 40201, \"version\": 1, \"versionNonce\": 40202, \"isDeleted\": false },",
        "        { \"id\": \"step-2-label\", \"type\": \"text\", \"x\": 450, \"y\": 175, \"width\": 140, \"height\": 40, \"text\": \"Step 2\", \"fontSize\": 28, \"fontFamily\": 1, \"textAlign\": \"center\", \"verticalAlign\": \"middle\", \"seed\": 40203, \"version\": 1, \"versionNonce\": 40204, \"isDeleted\": false },",
        "        { \"id\": \"step-3\", \"type\": \"rectangle\", \"x\": 680, \"y\": 140, \"width\": 200, \"height\": 100, \"strokeColor\": \"#1e1e1e\", \"backgroundColor\": \"#eef2ff\", \"strokeWidth\": 2, \"roughness\": 1, \"seed\": 40301, \"version\": 1, \"versionNonce\": 40302, \"isDeleted\": false },",
        "        { \"id\": \"step-3-label\", \"type\": \"text\", \"x\": 710, \"y\": 175, \"width\": 140, \"height\": 40, \"text\": \"Step 3\", \"fontSize\": 28, \"fontFamily\": 1, \"textAlign\": \"center\", \"verticalAlign\": \"middle\", \"seed\": 40303, \"version\": 1, \"versionNonce\": 40304, \"isDeleted\": false },",
        "        { \"id\": \"arrow-1\", \"type\": \"arrow\", \"x\": 360, \"y\": 190, \"width\": 60, \"height\": 0, \"points\": [[0,0],[60,0]], \"strokeColor\": \"#1e293b\", \"strokeWidth\": 3, \"roughness\": 1, \"seed\": 40401, \"version\": 1, \"versionNonce\": 40402, \"startBinding\": {\"elementId\": \"step-1\", \"focus\": 0, \"gap\": 8}, \"endBinding\": {\"elementId\": \"step-2\", \"focus\": 0, \"gap\": 8}, \"endArrowhead\": \"arrow\", \"isDeleted\": false },",
        "        { \"id\": \"arrow-2\", \"type\": \"arrow\", \"x\": 620, \"y\": 190, \"width\": 60, \"height\": 0, \"points\": [[0,0],[60,0]], \"strokeColor\": \"#1e293b\", \"strokeWidth\": 3, \"roughness\": 1, \"seed\": 40501, \"version\": 1, \"versionNonce\": 40502, \"startBinding\": {\"elementId\": \"step-2\", \"focus\": 0, \"gap\": 8}, \"endBinding\": {\"elementId\": \"step-3\", \"focus\": 0, \"gap\": 8}, \"endArrowhead\": \"arrow\", \"isDeleted\": false }",
        "      ]",
        "    }",
        "  ]",
        "}",
        "",
        "3. Remove an element by label:",
        "{ \"commands\": [ { \"type\": \"removeElement\", \"selector\": { \"text\": \"Step 2\" } } ] }",
        "",
        "4. Reset canvas:",
        "{ \"commands\": [ { \"type\": \"resetScene\" } ] }",
      ].join("\n"),
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
        commands: {
          type: "array",
          description:
            "Optional list of high-level commands to mutate the scene. Commands run after the scene payload (if provided).",
          items: {
            oneOf: [
              {
                type: "object",
                required: ["type", "element"],
                additionalProperties: false,
                properties: {
                  type: {
                    const: "upsertElement",
                  },
                  element: {
                    type: "object",
                    description:
                      "Full Excalidraw element payload (same structure as items in serializeAsJSON(...).elements). When the id matches an existing element it will be replaced, otherwise it is inserted.",
                    additionalProperties: true,
                  },
                },
              },
              {
                type: "object",
                required: ["type", "elements"],
                additionalProperties: false,
                properties: {
                  type: { const: "upsertElements" },
                  elements: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "object",
                      additionalProperties: true,
                    },
                    description:
                      "Batch upsert. Elements follow the same definition as Excalidraw scene elements.",
                  },
                },
              },
              {
                type: "object",
                required: ["type", "selector"],
                additionalProperties: false,
                properties: {
                  type: { const: "removeElement" },
                  selector: {
                    type: "object",
                    description:
                      "Descriptor for the element(s) to remove. Provide an element id or a text fragment that matches the element's label.",
                    properties: {
                      id: { type: "string" },
                      text: { type: "string" },
                    },
                    additionalProperties: false,
                    anyOf: [
                      { required: ["id"] },
                      { required: ["text"] },
                    ],
                  },
                  removeAll: {
                    type: "boolean",
                    description:
                      "Remove every matching element instead of only the first match.",
                  },
                },
              },
              {
                type: "object",
                required: ["type", "hint"],
                additionalProperties: false,
                properties: {
                  type: { const: "updateHint" },
                  hint: {
                    type: "string",
                    description: "Replacement status message for the canvas header.",
                  },
                },
              },
            ],
          },
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
      const appliedCommands: string[] = [];

      if (typeof args.scene !== "undefined") {
        diagramState = {
          ...diagramState,
          scene: args.scene as SceneData,
        };
      }

      const scene = ensureScene();
      let elements = scene.elements ?? [];

      if (Array.isArray(args.commands) && args.commands.length > 0) {
        for (const command of args.commands) {
          if (command.type === "upsertElement") {
            const { elements: normalized, ids } = normalizeElements([command.element]);
            elements = mergeElements(elements, normalized);
            appliedCommands.push(`Upserted element ${ids[0]}.`);
            continue;
          }

          if (command.type === "upsertElements") {
            const { elements: normalized, ids } = normalizeElements(command.elements);
            elements = mergeElements(elements, normalized);
            appliedCommands.push(`Upserted ${ids.length} element(s): ${ids.join(", ")}.`);
            continue;
          }

          if (command.type === "removeElement") {
            const { next, removedIds } = removeByDescriptor(
              elements,
              command.selector,
              { removeAll: command.removeAll },
            );
            elements = next;
            if (removedIds.length > 0) {
              appliedCommands.push(
                `Removed ${removedIds.length} element(s): ${removedIds.join(", ")}.`,
              );
            } else {
              appliedCommands.push(
                `No elements matched selector (id=${command.selector.id ?? "∅"}, text=${command.selector.text ?? "∅"}).`,
              );
            }
            continue;
          }

          if (command.type === "updateHint") {
            diagramState.hint = command.hint;
            appliedCommands.push("Updated header hint.");
            continue;
          }

          if (command.type === "resetScene") {
            elements = [];
            diagramState.scene = {
              ...ensureScene(),
              elements: [],
              appState: {},
              files: {},
            };
            diagramState.hint = null;
            appliedCommands.push("Cleared the canvas.");
            continue;
          }
        }

      }

      scene.elements = elements;
      diagramState.scene = scene;

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

      const details =
        appliedCommands.length > 0
          ? `\n\nCommands:\n- ${appliedCommands.join("\n- ")}`
          : "";

      return {
        content: [
          {
            type: "text",
            text: `${text}${details}`,
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

  const requestUrl = req.url ?? "/";
  const url = new NodeURL(requestUrl, `http://${req.headers.host ?? "localhost"}`);

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

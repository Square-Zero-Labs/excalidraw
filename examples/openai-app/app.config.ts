import { app, tool } from "@openai/app-sdk";
import { z } from "zod";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const diagramTool = tool({
  name: "excalidraw_diagrammer",
  description:
    "Embed Excalidraw so ChatGPT can inspect, edit, and generate diagrams with the user.",
  parameters: z.object({
    scene: z
      .object({})
      .passthrough()
      .optional()
      .describe("Serialized Excalidraw scene that should be merged into the canvas."),
    hint: z.string().optional().describe("Helper text to show in the tool header."),
  }),
  events: {
    "diagram:update": z.object({
      scene: z.any(),
    }),
  },
  async *run({ parameters, emitEvent, events }) {
    if (parameters.scene) {
      emitEvent("model:apply-scene", {
        type: "apply-scene",
        scene: parameters.scene,
      });
    }

    if (parameters.hint) {
      emitEvent("model:hint", {
        type: "hint",
        hint: parameters.hint,
      });
    }

    for await (const event of events("diagram:update")) {
      emitEvent("tool:diagram", event);
      yield {
        type: "event",
        event: {
          name: "diagram:update",
          data: event.scene,
        },
      };
    }

    yield {
      type: "text",
      text: "Applied the scene update to Excalidraw.",
    };
  },
  ui: {
    async html() {
      return createReadStream(path.join(dirname, "dist/ui/index.html"));
    },
    assets: [
      {
        path: path.join(dirname, "dist/ui/assets"),
        prefix: "assets",
      },
    ],
  },
});

export default app({
  name: "Excalidraw Diagrammer",
  description:
    "A ChatGPT app tool that embeds Excalidraw so you can co-create diagrams with the model.",
  tools: [diagramTool],
});

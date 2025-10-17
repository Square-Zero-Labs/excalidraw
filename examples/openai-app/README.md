# Excalidraw OpenAI App example

This example shows how to embed Excalidraw inside a [ChatGPT app](https://developers.openai.com/docs/apps/) using the **public** Apps tooling that ships with the Model Context Protocol (MCP). The UI bundle renders `<Excalidraw>` and syncs changes to the MCP server so ChatGPT can observe and modify the canvas.

## Prerequisites

- Node.js 20+
- Yarn (to build the local `@excalidraw/excalidraw` workspace package)
- The [OpenAI CLI](https://github.com/openai/openai-node/tree/master/packages/cli) logged in with an account that has access to Apps

## Getting started

1. **Install dependencies**

   ```bash
   cd examples/openai-app
   yarn install
   ```

   > The CLI has to download a few packages from the public npm registry (`@modelcontextprotocol/sdk`, `tsx`, etc.) so make sure you have network access when you run this step.

2. **Build the local Excalidraw workspace package**

   ```bash
   yarn build:packages
   ```

3. **Bundle the tool UI**

   ```bash
   yarn build
   ```

   Vite writes the UI bundle to `dist/ui/`. The MCP server in `server.ts` reads that output and inlines it into an HTML template that ChatGPT can embed.

4. **Start the MCP server**

   ```bash
   yarn mcp
   ```

   The server listens on `http://localhost:8000/mcp` and exposes a single tool named `excalidraw_diagrammer`.

5. **Expose the server to ChatGPT**

   ```bash
   ngrok http 8000
   ```

   Copy the HTTPS forwarding URL that ngrok prints (for example `https://<random>.ngrok-free.app`). In ChatGPT developer mode create a custom connector that points to `https://<random>.ngrok-free.app/mcp`.

6. **Invoke the tool from ChatGPT**

   Call the `excalidraw_diagrammer` tool with an optional `scene` payload. The UI renders inside the sideloaded tool, streams your edits back through the MCP server, and the model can respond with new `scene` objects or header `hint`s.

## How it works

- `server.ts` is a minimal MCP server backed by `@modelcontextprotocol/sdk`. It exposes a single tool (`excalidraw_diagrammer`) plus an HTML resource (`ui://excalidraw/diagram.html`) that ChatGPT renders when the tool replies with structured content. The server stores the latest scene so subsequent tool invocations see the most recent canvas.
- `src/openai-bridge.ts` reproduces the `useOpenAiGlobal()` helper from the OpenAI Apps examples so the React bundle can access `window.openai` updates.
- `src/tool-ui.tsx` is the React entry point rendered in the ChatGPT tool panel. It mounts `<Excalidraw>`, listens for `window.openai.toolOutput` updates, and merges any returned `scene` into the live canvas. User edits are throttled, serialized with `serializeAsJSON()`, cached via `window.openai.setWidgetState()`, and mirrored back to the MCP server with `callTool("excalidraw_diagrammer", { action: "update", ... })`.
- `src/main.tsx` boots the UI bundle in standalone dev mode (outside ChatGPT) so you can verify the canvas renders correctly.

## Prompting tips

Ask the model to always reply with structured JSON when invoking the tool, e.g.

```json
{
  "tool": "excalidraw_diagrammer",
  "parameters": {
    "scene": {
      "elements": [
        {
          "id": "generated-node-1",
          "type": "rectangle",
          "x": 200,
          "y": 160,
          "width": 240,
          "height": 120,
          "angle": 0,
          "strokeColor": "#1e1e1e",
          "backgroundColor": "#f9f9f9",
          "seed": 12345
        }
      ]
    },
    "hint": "Added the initial rectangle"
  }
}
```

The UI will merge the returned elements into the current scene and surface the `hint` message next to the title bar.

## Next steps

- Extend the MCP server to emit additional structured data (SVG, PNG) alongside the scene so the assistant can reference visual snapshots in text responses.
- Add more granular parameters (for example `operations: [{type: "addElement", ...}]`) so the model can make incremental edits instead of replacing the whole scene.
- Persist the serialized `.excalidraw` payloads captured in `window.openai.setWidgetState()` to share or replay diagram history.

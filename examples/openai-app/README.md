# Excalidraw OpenAI App example

This example shows how to embed Excalidraw inside a [ChatGPT App](https://developers.openai.com/docs/apps/) using the OpenAI Apps SDK. It mirrors the architecture described in the Excalidraw documentation: a thin UI bundle renders `<Excalidraw>` and streams every change back to the tool runtime. ChatGPT can then reply with structured updates that are applied straight to the canvas through the imperative API.

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

2. **Build the local Excalidraw package**

   ```bash
   yarn build:packages
   ```

3. **Bundle the tool UI**

   ```bash
   yarn build
   ```

   The Vite build step outputs the static assets into `dist/ui`, which `app.config.ts` serves to ChatGPT.

4. **Run the app locally**

   ```bash
   yarn dev
   ```

   The command proxies through `openai apps dev --config ./app.config.ts`. When the CLI starts it prints a development URL; paste that URL into the "Tools" tab of ChatGPT to sideload the tool.

## How it works

- `app.config.ts` registers a single tool (`excalidraw_diagrammer`) with the Apps SDK. The tool exposes an optional `scene` parameter that the model can return to overwrite or extend the diagram and a `hint` string for lightweight status messages. It also listens for `diagram:update` events emitted by the UI so the model can observe edits in realtime.
- `src/tool-ui.tsx` is the React entry point rendered in the ChatGPT tool panel. It mounts `<Excalidraw>` and bridges its change events through `createToolRuntimeClient()`. When ChatGPT responds with an `apply-scene` message, the component merges that payload into the current scene via `excalidrawAPI.updateScene`.
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

- Stream rendered thumbnails or SVG snapshots back to ChatGPT by attaching another event to `runtime.emitEvent`.
- Expand the parameter schema to support granular commands (e.g. `addConnector`, `deleteElement`).
- Persist the serialized `.excalidraw` payloads you receive from `diagram:update` events to build audit trails or project history.

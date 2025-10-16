import {
  Excalidraw,
  ExcalidrawImperativeAPI,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { BinaryFiles, ExcalidrawElement } from "@excalidraw/excalidraw/types";
import merge from "lodash.merge";
import { createToolRuntimeClient } from "@openai/app-sdk";
import { useEffect, useMemo, useRef, useState } from "react";

import "./tool-ui.css";

const DEFAULT_CANVAS_WIDTH = 1200;
const DEFAULT_CANVAS_HEIGHT = 720;

export type DiagramMessage =
  | {
      type: "apply-scene";
      scene: {
        elements?: readonly ExcalidrawElement[];
        appState?: any;
        files?: BinaryFiles;
      };
    }
  | {
      type: "set-active-tool";
      tool: string;
    }
  | {
      type: "hint";
      hint: string;
    };

type ToolRuntimeClient = Awaited<ReturnType<typeof createToolRuntimeClient>>;

function useToolRuntime(): ToolRuntimeClient | null {
  const [client, setClient] = useState<ToolRuntimeClient | null>(null);

  useEffect(() => {
    let cancelled = false;
    createToolRuntimeClient().then((runtime) => {
      if (!cancelled) {
        setClient(runtime);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return client;
}

export default function DiagramTool() {
  const runtime = useToolRuntime();
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<string>("Ready");

  useEffect(() => {
    if (!runtime) {
      return;
    }

    const unsubscribeModel = runtime.onModelMessage((message) => {
      if (!message) {
        return;
      }

      const payload = message as DiagramMessage;
      if (payload.type === "apply-scene") {
        const api = apiRef.current;
        if (api) {
          const current = api.getSceneElementsIncludingDeleted();
          const merged = merge({}, { elements: current }, payload.scene);
          api.updateScene(merged);
        }
      }

      if (payload.type === "set-active-tool") {
        apiRef.current?.setActiveTool({ type: payload.tool as any });
      }

      if (payload.type === "hint") {
        setStatus(payload.hint);
        runtime.emitEvent("hint", payload.hint);
      }
    });

    const unsubscribeTool = runtime.onToolMessage((message) => {
      if (message?.type === "hint") {
        setStatus(message.hint);
      }
    });

    return () => {
      unsubscribeModel?.();
      unsubscribeTool?.();
    };
  }, [runtime]);

  const handleChange = useMemo(
    () =>
      (elements: readonly ExcalidrawElement[], appState: any, files: BinaryFiles) => {
        if (!runtime) {
          return;
        }
        const payload = serializeAsJSON(elements, appState, files, "local");
        runtime.emitEvent("diagram:update", { scene: payload });
      },
    [runtime],
  );

  const setExcalidrawAPI = (api: ExcalidrawImperativeAPI | null) => {
    apiRef.current = api;
  };

  return (
    <div className="excalidraw-openai-app">
      <header className="excalidraw-openai-app__header">
        <span className="excalidraw-openai-app__title">Excalidraw Diagrammer</span>
        <span className="excalidraw-openai-app__status">{status}</span>
      </header>
      <div
        className="excalidraw-openai-app__canvas"
        style={{ width: "100%", height: "100%", minHeight: DEFAULT_CANVAS_HEIGHT }}
      >
        <Excalidraw
          excalidrawAPI={setExcalidrawAPI}
          onChange={handleChange}
          initialData={{
            appState: { theme: "light" },
            scrollToContent: true,
          }}
        />
      </div>
    </div>
  );
}

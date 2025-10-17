import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import type {
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import "./tool-ui.css";
import { getOpenAi, useOpenAiGlobal } from "./openai-bridge";

const DEFAULT_CANVAS_HEIGHT = 720;

export default function DiagramTool() {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const toolOutput = useOpenAiGlobal("toolOutput") as
    | {
        scene?: {
          elements?: readonly ExcalidrawElement[];
          appState?: any;
          files?: BinaryFiles;
        };
        hint?: string;
      }
    | null;
  const widgetState = useOpenAiGlobal("widgetState") as
    | {
        scene?: {
          elements?: readonly ExcalidrawElement[];
          appState?: any;
          files?: BinaryFiles;
        };
        hint?: string;
      }
    | null;

  const [status, setStatus] = useState<string>("Ready");
  const statusRef = useRef(status);
  const appliedSceneSignature = useRef<string | null>(null);
  const pendingSceneRef = useRef<
    ReturnType<typeof serializeAsJSON> | null
  >(null);
  const updateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (!getOpenAi()) {
      setStatus("Standalone preview");
    }
  }, []);

  const applyScene = useCallback(
    (scene: {
      elements?: readonly ExcalidrawElement[];
      appState?: any;
      files?: BinaryFiles;
    }) => {
      const api = apiRef.current;
      if (!api) {
        return;
      }

      try {
        const signature = JSON.stringify(scene);
        if (appliedSceneSignature.current === signature) {
          return;
        }
        appliedSceneSignature.current = signature;
      } catch {
        // fall through if scene is not serializable
      }

      api.updateScene(scene);
    },
    [],
  );

  useEffect(() => {
    const scene =
      widgetState?.scene ??
      toolOutput?.scene;
    if (scene) {
      applyScene(scene);
    }

    const hint = widgetState?.hint ?? toolOutput?.hint;
    if (hint) {
      setStatus(hint);
    }
  }, [applyScene, toolOutput, widgetState]);

  const pushSceneUpdate = useCallback(async () => {
    const payload = pendingSceneRef.current;
    pendingSceneRef.current = null;
    updateTimerRef.current = null;

    if (!payload) {
      return;
    }

    const openai = getOpenAi();
    if (!openai) {
      return;
    }

    try {
      await openai.setWidgetState?.({
        scene: payload,
        hint: statusRef.current,
        updatedAt: Date.now(),
      });
    } catch (error) {
      console.warn("[excalidraw] Failed to persist widget state", error);
    }

    try {
      await openai.callTool?.("excalidraw_diagrammer", {
        action: "update",
        scene: payload,
        hint: statusRef.current,
      });
    } catch (error) {
      console.warn("[excalidraw] Failed to emit diagram:update", error);
    }
  }, []);

  const scheduleSceneUpdate = useCallback(
    (scene: ReturnType<typeof serializeAsJSON>) => {
      pendingSceneRef.current = scene;
      if (updateTimerRef.current) {
        return;
      }
      updateTimerRef.current = setTimeout(pushSceneUpdate, 600);
    },
    [pushSceneUpdate],
  );

  useEffect(() => {
    return () => {
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current);
        updateTimerRef.current = null;
      }
    };
  }, []);

  const handleChange = useMemo(
    () =>
      (elements: readonly ExcalidrawElement[], appState: any, files: BinaryFiles) => {
        const payload = serializeAsJSON(elements, appState, files, "local");
        scheduleSceneUpdate(payload);
      },
    [scheduleSceneUpdate],
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

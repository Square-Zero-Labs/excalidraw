import type React from "react";
import type App from "./components/App";
import type { AppState } from "./types";
import type Scene from "./scene/Scene";
import type { History } from "./history";
import type {
  ExcalidrawElement,
  Store,
} from "@excalidraw/element";

declare global {
  interface Window {
    h: {
      scene: Scene;
      elements: readonly ExcalidrawElement[];
      state: AppState;
      setState: React.Component<any, AppState>["setState"];
      app: InstanceType<typeof App>;
      history: History;
      store: Store;
    };
  }
}

export {};

declare module "@excalidraw/excalidraw" {
  import type { FC } from "react";

  export const Excalidraw: FC<any>;
  export function serializeAsJSON(
    elements: readonly any[],
    appState: any,
    files: any,
    metadata: string
  ): any;
}

declare module "@excalidraw/excalidraw/types" {
  export interface ExcalidrawImperativeAPI {
    updateScene(scene: any): void;
    getSceneElementsIncludingDeleted(): any[];
    setActiveTool(tool: { type: string }): void;
  }

  export type BinaryFiles = Record<string, unknown>;
}

declare module "@excalidraw/element/types" {
  export type ExcalidrawElement = any;
}

import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import DiagramTool from "./tool-ui";

import "@excalidraw/excalidraw/index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root element");
}

const root = createRoot(container);
root.render(
  <StrictMode>
    <DiagramTool />
  </StrictMode>,
);

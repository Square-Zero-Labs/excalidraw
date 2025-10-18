import { useSyncExternalStore } from "react";

export type DisplayMode = "pip" | "inline" | "fullscreen";

export type OpenAiGlobals = {
  toolInput?: unknown;
  toolOutput?: unknown;
  widgetState?: unknown;
  setWidgetState: (state: unknown) => Promise<void>;
  requestDisplayMode?: (args: { mode: DisplayMode }) => Promise<{ mode: DisplayMode }>;
  maxHeight?: number;
  theme?: "light" | "dark";
};

export type OpenAiApi = {
  callTool?: (name: string, args: Record<string, unknown>) => Promise<{ result: string }>;
  sendFollowUpMessage?: (args: { prompt: string }) => Promise<void>;
  openExternal?: (args: { href: string }) => void;
} & OpenAiGlobals;

export const SET_GLOBALS_EVENT_TYPE = "openai:set_globals";

export class SetGlobalsEvent extends CustomEvent<{
  globals: Partial<OpenAiGlobals>;
}> {
  readonly type = SET_GLOBALS_EVENT_TYPE;
}

declare global {
  interface Window {
    openai?: OpenAiApi;
  }

  interface WindowEventMap {
    [SET_GLOBALS_EVENT_TYPE]: SetGlobalsEvent;
  }
}

export function useOpenAiGlobal<K extends keyof OpenAiGlobals>(
  key: K,
): OpenAiGlobals[K] | null {
  return useSyncExternalStore(
    (onStoreChange) => {
      if (typeof window === "undefined") {
        return () => {};
      }

      const handle = (event: SetGlobalsEvent) => {
        if (event.detail.globals[key] !== undefined) {
          onStoreChange();
        }
      };

      window.addEventListener(SET_GLOBALS_EVENT_TYPE, handle, {
        passive: true,
      });

      return () => {
        window.removeEventListener(SET_GLOBALS_EVENT_TYPE, handle);
      };
    },
    () => window.openai?.[key] ?? null,
    () => window.openai?.[key] ?? null,
  );
}

export function getOpenAi(): OpenAiApi | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.openai ?? null;
}

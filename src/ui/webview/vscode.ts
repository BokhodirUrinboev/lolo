import type { FromWebview } from "../protocol";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };

const api = acquireVsCodeApi();

export function post(m: FromWebview) {
  api.postMessage(m);
}

/** Per-webview UI state that survives the panel being hidden (draft text). */
export const uiState = {
  get<T>(key: string, fallback: T): T {
    const s = (api.getState() ?? {}) as Record<string, unknown>;
    return (s[key] as T) ?? fallback;
  },
  set(key: string, value: unknown) {
    api.setState({ ...((api.getState() ?? {}) as object), [key]: value });
  },
};

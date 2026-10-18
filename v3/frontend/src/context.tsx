import { createContext, useContext } from "react";
import type { Bootstrap, SearchPreset } from "./types";
export type AppState = {
  data: Bootstrap;
  refresh: () => Promise<void>;
  run: (task: () => Promise<unknown>, success?: string) => Promise<boolean>;
  go: (page: string) => void;
  openAlert: (id: string) => void;
  alertTarget: string;
  search: (preset: SearchPreset) => void;
  play: (id: string, at?: number) => void;
  notify: (message: string) => void;
};
export const AppContext = createContext<AppState | null>(null);
export function useApp() {
  const app = useContext(AppContext);
  if (!app) throw new Error("Missing app context");
  return app;
}

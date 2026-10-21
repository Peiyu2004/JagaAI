import { api } from "./api";

// Quick Tunnels do not support SSE. This transport is selected only for the Colab build.
export function pollUpdates(refresh: () => void, connection: (online: boolean) => void = () => {}) {
  let stopped = false;
  let busy = false;
  let revision: number | undefined;
  const poll = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const result = await api<{ revision: number }>("/updates");
      if (stopped) return;
      connection(true);
      if (result.revision !== revision) {
        revision = result.revision;
        refresh();
      }
    } catch {
      if (!stopped) connection(false);
    } finally {
      busy = false;
    }
  };
  const timer = window.setInterval(() => void poll(), 5000);
  void poll();
  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}

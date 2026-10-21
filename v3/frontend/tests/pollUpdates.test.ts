import assert from "node:assert/strict";
import test from "node:test";
import { pollUpdates } from "../src/pollUpdates";

test("polling refreshes changed data, recovers from an outage and ignores completed requests after cleanup", async () => {
  const savedWindow = globalThis.window;
  const savedFetch = globalThis.fetch;
  let interval: (() => void) | undefined;
  let cancelled = false;
  Object.assign(globalThis, { window: {
    setInterval: (callback: () => void) => { interval = callback; return 1; },
    clearInterval: () => { cancelled = true; },
  } });
  let revision = 1;
  let offline = false;
  let pending: ((response: Response) => void) | undefined;
  let delay = false;
  globalThis.fetch = async () => {
    if (offline) throw new Error("offline");
    if (delay) return new Promise<Response>((resolve) => { pending = resolve; });
    return Response.json({ revision });
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  let refreshes = 0;
  const states: boolean[] = [];
  let stop = () => {};
  try {
    stop = pollUpdates(() => { refreshes += 1; }, (state) => states.push(state));
    await flush();
    assert.equal(refreshes, 1);
    interval!(); await flush();
    assert.equal(refreshes, 1);
    revision = 2; interval!(); await flush();
    assert.equal(refreshes, 2);
    offline = true; interval!(); await flush();
    assert.equal(states.at(-1), false);
    offline = false; interval!(); await flush();
    assert.equal(states.at(-1), true);
    delay = true; interval!(); await flush();
    stop();
    const connections = states.length;
    pending!(Response.json({ revision: 3 })); await flush();
    assert.equal(refreshes, 2);
    assert.equal(states.length, connections);
    assert.equal(cancelled, true);
  } finally {
    stop();
    Object.assign(globalThis, { window: savedWindow, fetch: savedFetch });
  }
});

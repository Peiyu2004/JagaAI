import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { cleanupExpired, processNextJob } from './engine.ts';
import { processNextIndex } from './indexer.ts';
import { processNextReportSearch } from './report-retrieval.ts';
import { processNextPrivacy, cleanupPrivacy } from './privacy.ts';

export async function startWorker() {
  const owner = `worker-${process.pid}-${randomUUID()}`;
  let stopped = false, nextCleanup = 0;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  console.log(`JagaAI local worker started (${process.env.AI_MODE || process.env.JAGAAI_AI_MODE || 'fixture'} mode).`);
  while (!stopped) {
    try {
      if (Date.now() >= nextCleanup) { await cleanupPrivacy(); await cleanupExpired(); nextCleanup = Date.now() + 60_000; }
      if (!await processNextPrivacy(owner) && !await processNextReportSearch(owner) && !await processNextIndex(owner) && !await processNextJob(owner)) await sleep(1000);
    } catch (error) {
      console.error('Local worker error:', error instanceof Error ? error.message : 'Unknown error');
      await sleep(2000);
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await startWorker();

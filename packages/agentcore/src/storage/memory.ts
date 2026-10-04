import { Readable } from 'node:stream';
import type { ObjectHead, ObjectMetadata, ObjectStore, ObjectSummary, StoredObject } from './types';

interface Entry extends ObjectHead {
  data: Buffer;
}

/** Process-local store for tests and single-node development; not durable. */
export function createMemoryStore(now: () => Date = () => new Date()): ObjectStore & {
  keys(): string[];
} {
  const entries = new Map<string, Entry>();

  return {
    async put(key: string, body: Buffer, metadata: ObjectMetadata): Promise<void> {
      entries.set(key, {
        data: Buffer.from(body),
        size: body.length,
        lastModified: now(),
        metadata: { ...metadata },
      });
    },
    async get(key: string): Promise<StoredObject | null> {
      const entry = entries.get(key);
      if (entry == null) {
        return null;
      }
      const { data, ...head } = entry;
      return { ...head, metadata: { ...head.metadata }, body: Readable.from([data]) };
    },
    async head(key: string): Promise<ObjectHead | null> {
      const entry = entries.get(key);
      return entry == null
        ? null
        : { size: entry.size, lastModified: entry.lastModified, metadata: { ...entry.metadata } };
    },
    async list(prefix: string): Promise<ObjectSummary[]> {
      return [...entries.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, entry]) => ({ key, size: entry.size, lastModified: entry.lastModified }));
    },
    async delete(key: string): Promise<boolean> {
      return entries.delete(key);
    },
    keys(): string[] {
      return [...entries.keys()];
    },
  };
}

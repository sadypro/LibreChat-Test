import type { Readable } from 'node:stream';

export type ObjectMetadata = Record<string, string>;

export interface ObjectHead {
  size: number;
  lastModified: Date;
  metadata: ObjectMetadata;
}

export interface StoredObject extends ObjectHead {
  body: Readable;
}

export interface ObjectSummary {
  key: string;
  size: number;
  lastModified: Date;
}

/** Minimal blob store the file service needs; S3 in production, memory in tests. */
export interface ObjectStore {
  put(key: string, body: Buffer, metadata: ObjectMetadata): Promise<void>;
  /** Resolves `null` when the object does not exist. */
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<ObjectHead | null>;
  list(prefix: string): Promise<ObjectSummary[]>;
  /** Resolves `false` when there was nothing to delete. */
  delete(key: string): Promise<boolean>;
}

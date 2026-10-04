import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { ObjectHead, ObjectStore } from './types';
import type { Principal } from '../auth';

export type FileKind = 'user' | 'agent' | 'skill';

/** Owner scope LibreChat attaches to every stored file (`kind`/`id`/`version`). */
export interface FileScope {
  kind: FileKind;
  id: string;
  version?: number;
}

export interface FileRecord extends FileScope {
  fileId: string;
  sessionId: string;
  filename: string;
  readOnly: boolean;
  size: number;
  lastModified: Date;
}

export interface NewFile {
  filename: string;
  body: Buffer;
  scope: FileScope;
  readOnly?: boolean;
}

export interface FileService {
  /** Session for a scope: stable per principal and scope, so re-uploads land together. */
  sessionFor(principal: Principal, scope: FileScope): string;
  newSessionId(): string;
  put(principal: Principal, sessionId: string, file: NewFile): Promise<FileRecord>;
  info(principal: Principal, sessionId: string, fileId: string): Promise<FileRecord | null>;
  read(
    principal: Principal,
    sessionId: string,
    fileId: string,
  ): Promise<{ record: FileRecord; body: Buffer } | null>;
  open(
    principal: Principal,
    sessionId: string,
    fileId: string,
  ): Promise<{ record: FileRecord; body: Readable } | null>;
  list(principal: Principal, sessionId: string): Promise<FileRecord[]>;
  remove(principal: Principal, sessionId: string, fileId: string): Promise<boolean>;
}

export interface FileServiceOptions {
  store: ObjectStore;
  prefix: string;
  ttlHours: number;
  now?: () => number;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function randomId(prefix: string): string {
  return `${prefix}${randomBytes(16).toString('hex')}`;
}

function toRecord(sessionId: string, fileId: string, head: ObjectHead): FileRecord | null {
  const { metadata } = head;
  const kind = metadata.kind;
  if (kind !== 'user' && kind !== 'agent' && kind !== 'skill') {
    return null;
  }
  const version = metadata.version != null ? Number(metadata.version) : undefined;
  return {
    fileId,
    sessionId,
    kind,
    id: decodeURIComponent(metadata.entity ?? ''),
    ...(version != null && Number.isFinite(version) ? { version } : {}),
    filename: decodeURIComponent(metadata.filename ?? fileId),
    readOnly: metadata.readonly === 'true',
    size: head.size,
    lastModified: head.lastModified,
  };
}

/**
 * Principal-scoped file storage. Keys are derived only from the authenticated principal's digest
 * and validated ids, so one user can never name, list or read another user's objects; a foreign
 * session id simply resolves to an empty prefix under the caller's own namespace.
 */
export function createFileService({
  store,
  prefix,
  ttlHours,
  now = Date.now,
}: FileServiceOptions): FileService {
  const ttlMs = ttlHours * 3_600_000;
  const sessionPrefix = (principal: Principal, sessionId: string): string => {
    if (!isValidId(sessionId)) {
      throw new Error('Invalid session id');
    }
    return `${prefix}${principal.key}/${sessionId}/`;
  };
  const objectKey = (principal: Principal, sessionId: string, fileId: string): string => {
    if (!isValidId(fileId)) {
      throw new Error('Invalid file id');
    }
    return `${sessionPrefix(principal, sessionId)}${fileId}`;
  };
  const expired = (lastModified: Date): boolean => now() - lastModified.getTime() > ttlMs;

  const info = async (
    principal: Principal,
    sessionId: string,
    fileId: string,
  ): Promise<FileRecord | null> => {
    if (!isValidId(sessionId) || !isValidId(fileId)) {
      return null;
    }
    const head = await store.head(objectKey(principal, sessionId, fileId));
    if (head == null || expired(head.lastModified)) {
      return null;
    }
    return toRecord(sessionId, fileId, head);
  };

  const open = async (
    principal: Principal,
    sessionId: string,
    fileId: string,
  ): Promise<{ record: FileRecord; body: Readable } | null> => {
    if (!isValidId(sessionId) || !isValidId(fileId)) {
      return null;
    }
    const object = await store.get(objectKey(principal, sessionId, fileId));
    if (object == null) {
      return null;
    }
    const record = expired(object.lastModified) ? null : toRecord(sessionId, fileId, object);
    if (record == null) {
      object.body.destroy();
      return null;
    }
    return { record, body: object.body };
  };

  return {
    sessionFor(principal, scope) {
      const digest = createHash('sha256')
        .update(JSON.stringify([principal.key, scope.kind, scope.id, scope.version ?? null]))
        .digest('hex');
      return `s_${digest.slice(0, 32)}`;
    },
    newSessionId: () => randomId('s_'),
    async put(principal, sessionId, file) {
      const fileId = randomId('f_');
      const metadata: Record<string, string> = {
        kind: file.scope.kind,
        entity: encodeURIComponent(file.scope.id),
        filename: encodeURIComponent(file.filename),
        readonly: String(file.readOnly === true),
        ...(file.scope.version != null ? { version: String(file.scope.version) } : {}),
      };
      await store.put(objectKey(principal, sessionId, fileId), file.body, metadata);
      return {
        fileId,
        sessionId,
        ...file.scope,
        filename: file.filename,
        readOnly: file.readOnly === true,
        size: file.body.length,
        lastModified: new Date(now()),
      };
    },
    info,
    open,
    async read(principal, sessionId, fileId) {
      const opened = await open(principal, sessionId, fileId);
      if (opened == null) {
        return null;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of opened.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      return { record: opened.record, body: Buffer.concat(chunks) };
    },
    async list(principal, sessionId) {
      if (!isValidId(sessionId)) {
        return [];
      }
      const summaries = await store.list(sessionPrefix(principal, sessionId));
      const records = await Promise.all(
        summaries
          .filter((summary) => !expired(summary.lastModified))
          .map((summary) =>
            info(principal, sessionId, summary.key.slice(summary.key.lastIndexOf('/') + 1)),
          ),
      );
      return records.filter((record): record is FileRecord => record != null);
    },
    async remove(principal, sessionId, fileId) {
      if (!isValidId(sessionId) || !isValidId(fileId)) {
        return false;
      }
      return store.delete(objectKey(principal, sessionId, fileId));
    },
  };
}

/** True when the record belongs to the scope the caller named; mismatches are treated as absent. */
export function matchesScope(record: FileRecord, scope: Partial<FileScope>): boolean {
  if (scope.kind != null && scope.kind !== record.kind) {
    return false;
  }
  if (scope.id != null && scope.id !== record.id) {
    return false;
  }
  return scope.version == null || scope.version === record.version;
}

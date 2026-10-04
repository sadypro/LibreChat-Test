import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { ObjectHead, ObjectMetadata, ObjectStore, ObjectSummary, StoredObject } from './types';

export interface S3StoreOptions {
  client: Pick<S3Client, 'send'>;
  bucket: string;
  kmsKeyId?: string;
}

function isMissing(error: unknown): boolean {
  const named = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    named?.name === 'NoSuchKey' ||
    named?.name === 'NotFound' ||
    named?.$metadata?.httpStatusCode === 404
  );
}

/** Objects are always written with server-side encryption: SSE-KMS when a key is set, else SSE-S3. */
export function createS3Store({ client, bucket, kmsKeyId }: S3StoreOptions): ObjectStore {
  const encryption =
    kmsKeyId != null
      ? { ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: kmsKeyId }
      : { ServerSideEncryption: 'AES256' as const };

  const head = async (key: string): Promise<ObjectHead | null> => {
    try {
      const output = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        size: output.ContentLength ?? 0,
        lastModified: output.LastModified ?? new Date(0),
        metadata: output.Metadata ?? {},
      };
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  };

  const get = async (key: string): Promise<StoredObject | null> => {
    try {
      const output = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (output.Body == null) {
        return null;
      }
      return {
        body: output.Body as Readable,
        size: output.ContentLength ?? 0,
        lastModified: output.LastModified ?? new Date(0),
        metadata: output.Metadata ?? {},
      };
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  };

  const put = async (key: string, body: Buffer, metadata: ObjectMetadata): Promise<void> => {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        Metadata: metadata,
        ...encryption,
      }),
    );
  };

  const list = async (prefix: string): Promise<ObjectSummary[]> => {
    const summaries: ObjectSummary[] = [];
    let token: string | undefined;
    do {
      const output = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const item of output.Contents ?? []) {
        if (item.Key != null) {
          summaries.push({
            key: item.Key,
            size: item.Size ?? 0,
            lastModified: item.LastModified ?? new Date(0),
          });
        }
      }
      token = output.IsTruncated === true ? output.NextContinuationToken : undefined;
    } while (token != null);
    return summaries;
  };

  const remove = async (key: string): Promise<boolean> => {
    if ((await head(key)) == null) {
      return false;
    }
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  };

  return { put, get, head, list, delete: remove };
}

import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { createS3Store } from './s3';

const notFound = Object.assign(new Error('missing'), {
  name: 'NotFound',
  $metadata: { httpStatusCode: 404 },
});

describe('createS3Store', () => {
  it('writes with SSE-KMS when a key is configured, SSE-S3 otherwise', async () => {
    const send = jest.fn().mockResolvedValue({});
    await createS3Store({
      client: { send } as unknown as S3Client,
      bucket: 'b',
      kmsKeyId: 'kms-1',
    }).put('k', Buffer.from('x'), { kind: 'user' });
    await createS3Store({ client: { send } as unknown as S3Client, bucket: 'b' }).put(
      'k',
      Buffer.from('x'),
      {},
    );
    const [[kms], [s3]] = send.mock.calls as [[PutObjectCommand], [PutObjectCommand]];
    expect(kms.input).toMatchObject({
      Bucket: 'b',
      Key: 'k',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'kms-1',
      Metadata: { kind: 'user' },
    });
    expect(s3.input).toMatchObject({ ServerSideEncryption: 'AES256' });
  });

  it('maps missing objects to null and pages through listings', async () => {
    const send = jest.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand || command instanceof GetObjectCommand) {
        throw notFound;
      }
      if (command instanceof ListObjectsV2Command) {
        return command.input.ContinuationToken == null
          ? { Contents: [{ Key: 'p/a', Size: 1 }], IsTruncated: true, NextContinuationToken: 'n' }
          : { Contents: [{ Key: 'p/b', Size: 2 }], IsTruncated: false };
      }
      return {};
    });
    const store = createS3Store({ client: { send } as unknown as S3Client, bucket: 'b' });
    await expect(store.head('k')).resolves.toBeNull();
    await expect(store.get('k')).resolves.toBeNull();
    await expect(store.delete('k')).resolves.toBe(false);
    expect((await store.list('p/')).map((item) => item.key)).toEqual(['p/a', 'p/b']);
    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(false);
  });

  it('returns object bodies as streams with metadata', async () => {
    const send = jest.fn(async () => ({
      Body: Readable.from([Buffer.from('data')]),
      ContentLength: 4,
      LastModified: new Date(0),
      Metadata: { filename: 'a.txt' },
    }));
    const object = await createS3Store({
      client: { send } as unknown as S3Client,
      bucket: 'b',
    }).get('k');
    expect(object).toMatchObject({ size: 4, metadata: { filename: 'a.txt' } });
  });

  it('propagates real S3 failures', async () => {
    const send = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(
      createS3Store({ client: { send } as unknown as S3Client, bucket: 'b' }).head('k'),
    ).rejects.toThrow('denied');
  });
});

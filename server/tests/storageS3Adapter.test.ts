import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

// Execute the actual adapter and SDK command construction. The only provider
// boundary is S3Client.send; no network operation or real credential is used.
process.env.STORAGE_BACKEND = 's3';
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_S3_BUCKET = 'storage-audit-synthetic';
process.env.AWS_ACCESS_KEY_ID = 'storage-audit-synthetic';
process.env.AWS_SECRET_ACCESS_KEY = 'storage-audit-synthetic';
process.env.S3_ENDPOINT = 'http://127.0.0.1:1';
process.env.CDN_URL = '';
const objects = new Map<string, Buffer>();
const inputs: Record<string, unknown>[] = [];
const send = jest.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: { input: Record<string, unknown> }) => {
  inputs.push(command.input);
  const key = String(command.input.Key || '');
  if (command instanceof PutObjectCommand) { objects.set(key, Buffer.from(command.input.Body as Buffer)); return {}; }
  if (command instanceof DeleteObjectCommand) { objects.delete(key); return {}; }
  if (command instanceof ListObjectsV2Command) return { Contents: [...objects.keys()].filter(value => value.startsWith(String(command.input.Prefix)))
    .slice(0, Number(command.input.MaxKeys)).map(Key => ({ Key })) };
  const buffer = objects.get(key);
  if (!buffer) throw Object.assign(new Error('Synthetic missing object'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
  if (command instanceof HeadObjectCommand) return {};
  if (command instanceof GetObjectCommand) {
    const range = command.input.Range as string | undefined;
    const [start, end] = range ? range.slice(6).split('-').map(Number) : [0, buffer.length - 1];
    return { Body: Readable.from([buffer.subarray(start, end + 1)]) };
  }
  throw new Error('Unexpected provider command');
}) as never);
const { objectStorage } = await import('../services/ObjectStorageService.js');
beforeEach(() => { objects.clear(); inputs.length = 0; send.mockClear(); });
afterAll(() => { send.mockRestore(); });

describe('actual S3 adapter with synthetic SDK provider fixtures', () => {
  it('round trips objects and constructs bucket, metadata and bounded range commands', async () => {
    const key = '9/document/synthetic report.txt';
    const url = await objectStorage.upload(key, Buffer.from('synthetic bytes'), 'text/plain', { userId: '9' });
    expect(url).toBe('http://127.0.0.1:1/storage-audit-synthetic/9/document/synthetic%20report.txt');
    expect(inputs[0]).toMatchObject({ Bucket: 'storage-audit-synthetic', Key: key, ContentType: 'text/plain', Metadata: { userId: '9' } });
    expect((await objectStorage.download(key)).toString()).toBe('synthetic bytes');
    const stream = await objectStorage.openReadStream!(key, { start: 0, end: 8 });
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('synthetic');
    expect(inputs.at(-1)).toMatchObject({ Range: 'bytes=0-8' });
  });

  it('bounds listing and preserves idempotent delete', async () => {
    objects.set('9/document/a', Buffer.from('a'));
    objects.set('9/document/b', Buffer.from('b'));
    objects.set('19/document/c', Buffer.from('c'));
    expect(await objectStorage.list('9/document', 1)).toEqual(['9/document/a']);
    expect(await objectStorage.exists('9/document/a')).toBe(true);
    await objectStorage.delete('9/document/a');
    await objectStorage.delete('9/document/a');
    expect(await objectStorage.exists('9/document/a')).toBe(false);
  });

  it('rejects invalid namespaces before any provider request', async () => {
    await expect(objectStorage.upload('../foreign', Buffer.from('x'), 'text/plain')).rejects.toThrow('Invalid storage key');
    await expect(objectStorage.openReadStream!('/absolute')).rejects.toThrow('Invalid storage key');
    await expect(objectStorage.delete('9/document/../../foreign')).rejects.toThrow('Invalid storage key');
    expect(send).not.toHaveBeenCalled();
  });
});

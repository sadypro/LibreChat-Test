import { createMemoryStore } from './memory';
import { createFileService } from './files';
import { createPrincipal } from '../auth';

describe('createFileService', () => {
  const alice = createPrincipal('t1', 'alice');
  const bob = createPrincipal('t1', 'bob');

  function setup() {
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const store = createMemoryStore(() => new Date(clock));
    const files = createFileService({ store, prefix: 'p/', ttlHours: 24, now: () => clock });
    return { store, files, advance: (ms: number) => (clock += ms) };
  }

  it('round-trips files with their scope and metadata', async () => {
    const { files } = setup();
    const sessionId = files.sessionFor(alice, { kind: 'skill', id: 'sk', version: 2 });
    const record = await files.put(alice, sessionId, {
      filename: 'dir/ünïcode.txt',
      body: Buffer.from('hi'),
      scope: { kind: 'skill', id: 'sk', version: 2 },
      readOnly: true,
    });
    const read = await files.read(alice, sessionId, record.fileId);
    expect(read?.body.toString()).toBe('hi');
    expect(read?.record).toMatchObject({
      filename: 'dir/ünïcode.txt',
      kind: 'skill',
      id: 'sk',
      version: 2,
      readOnly: true,
      size: 2,
    });
    expect(await files.list(alice, sessionId)).toHaveLength(1);
  });

  it('derives sessions per principal so equal scopes never collide across users', () => {
    const { files } = setup();
    const scope = { kind: 'agent' as const, id: 'shared-agent' };
    expect(files.sessionFor(alice, scope)).toBe(files.sessionFor(alice, scope));
    expect(files.sessionFor(alice, scope)).not.toBe(files.sessionFor(bob, scope));
  });

  it('resolves nothing for another principal even with exact ids', async () => {
    const { files } = setup();
    const sessionId = files.newSessionId();
    const record = await files.put(alice, sessionId, {
      filename: 'a.txt',
      body: Buffer.from('a'),
      scope: { kind: 'user', id: 'alice' },
    });
    expect(await files.info(bob, sessionId, record.fileId)).toBeNull();
    expect(await files.read(bob, sessionId, record.fileId)).toBeNull();
    expect(await files.list(bob, sessionId)).toEqual([]);
    expect(await files.remove(bob, sessionId, record.fileId)).toBe(false);
    expect(await files.info(alice, sessionId, record.fileId)).not.toBeNull();
  });

  it('treats files older than the TTL as absent', async () => {
    const { files, advance } = setup();
    const sessionId = files.newSessionId();
    const record = await files.put(alice, sessionId, {
      filename: 'a.txt',
      body: Buffer.from('a'),
      scope: { kind: 'user', id: 'alice' },
    });
    advance(23 * 3_600_000);
    expect(await files.info(alice, sessionId, record.fileId)).not.toBeNull();
    advance(2 * 3_600_000);
    expect(await files.info(alice, sessionId, record.fileId)).toBeNull();
    expect(await files.read(alice, sessionId, record.fileId)).toBeNull();
    expect(await files.list(alice, sessionId)).toEqual([]);
  });

  it('refuses ids that could address outside the session prefix', async () => {
    const { files } = setup();
    expect(await files.info(alice, '../x', 'f')).toBeNull();
    expect(await files.read(alice, 's_1', '../../f')).toBeNull();
    await expect(
      files.put(alice, 'a/b', {
        filename: 'x',
        body: Buffer.from(''),
        scope: { kind: 'user', id: 'alice' },
      }),
    ).rejects.toThrow('Invalid session id');
  });
});

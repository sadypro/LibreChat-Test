import request from 'supertest';
import type { Harness } from './helpers/setup';
import { createHarness } from './helpers/setup';

async function upload(
  harness: Harness,
  userId: string,
  filename: string,
  content: string,
  scope: { kind?: string; id?: string } = {},
) {
  return request(harness.app)
    .post('/v1/upload')
    .set('Authorization', harness.bearer(userId))
    .field('kind', scope.kind ?? 'user')
    .field('id', scope.id ?? userId)
    .attach('file', Buffer.from(content), filename);
}

describe('Code API over AgentCore', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('serves an unauthenticated health check', async () => {
    const response = await request(harness.app).get('/health');
    expect(response.status).toBe(200);
    expect(response.text).toBe('ok');
  });

  it('rejects requests without a valid LibreChat JWT', async () => {
    const missing = await request(harness.app)
      .post('/v1/exec')
      .send({ lang: 'py', code: 'print(1)' });
    expect(missing.status).toBe(401);
    expect(missing.body.error).toBe('unauthorized');

    const forged = await request(harness.app)
      .post('/v1/exec')
      .set('Authorization', `${harness.bearer()}x`)
      .send({ lang: 'py', code: 'print(1)' });
    expect(forged.status).toBe(401);
    expect(harness.interpreter.started).toHaveLength(0);
  });

  it('executes python and returns stdout, stderr and generated files', async () => {
    const response = await request(harness.app)
      .post('/v1/exec')
      .set('Authorization', harness.bearer())
      .send({
        lang: 'py',
        code: [
          'import os, sys',
          'print("hello", os.getcwd() == os.environ["LIBRECHAT_CODE_DATA_DIR"])',
          'print("warn", file=sys.stderr)',
          'os.makedirs("charts", exist_ok=True)',
          'open("charts/out.csv", "w").write("a,b\\n1,2\\n")',
        ].join('\n'),
        user_id: 'ignored-context-field',
      })
      .expect(200);

    expect(response.body.stdout).toBe('hello True\n');
    expect(response.body.stderr).toBe('warn\n');
    expect(response.body.files).toEqual([
      {
        id: expect.stringMatching(/^f_/),
        name: 'charts/out.csv',
        storage_session_id: response.body.session_id,
      },
    ]);

    const [file] = response.body.files;
    const download = await request(harness.app)
      .get(`/v1/download/${file.storage_session_id}/${file.id}?kind=user&id=user-a`)
      .set('Authorization', harness.bearer())
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((download.body as Buffer).toString()).toBe('a,b\n1,2\n');
    expect(download.headers['content-disposition']).toContain('out.csv');
  });

  it('runs bash and javascript, passing args', async () => {
    const bash = await request(harness.app)
      .post('/v1/exec')
      .set('Authorization', harness.bearer())
      .send({ lang: 'bash', code: 'echo "args:$1|$2"', args: ["it's", '$(id)'] })
      .expect(200);
    expect(bash.body.stdout).toBe("args:it's|$(id)\n");

    const js = await request(harness.app)
      .post('/v1/exec')
      .set('Authorization', harness.bearer())
      .send({ lang: 'js', code: 'console.log(process.argv.slice(2).join(","))', args: ['x', 'y'] })
      .expect(200);
    expect(js.body.stdout).toBe('x,y\n');
  });

  it('reports unsupported languages as a permanent capability error', async () => {
    const response = await request(harness.app)
      .post('/v1/exec')
      .set('Authorization', harness.bearer())
      .send({ lang: 'cobol', code: 'DISPLAY 1' })
      .expect(400);
    expect(response.body.error).toBe('unsupported_capability');
  });

  it('injects uploaded files, reports modified and deleted inputs, and skips unchanged ones', async () => {
    const keep = await upload(harness, 'user-a', 'keep.txt', 'same');
    const edit = await upload(harness, 'user-a', 'edit.txt', 'v1');
    const drop = await upload(harness, 'user-a', 'drop.txt', 'bye');
    const refs = [keep, edit, drop].map((res) => ({
      id: res.body.files[0].fileId,
      storage_session_id: res.body.storage_session_id,
      name: res.body.files[0].filename,
    }));

    const response = await request(harness.app)
      .post('/v1/exec')
      .set('Authorization', harness.bearer())
      .send({
        lang: 'py',
        code: [
          'import os',
          'print(open("keep.txt").read(), open("edit.txt").read())',
          'open("edit.txt", "a").write("+v2")',
          'os.remove("drop.txt")',
        ].join('\n'),
        files: refs,
      })
      .expect(200);

    expect(response.body.stdout).toBe('same v1\n');
    expect(response.body.files.map((file: { name: string }) => file.name)).toEqual(['edit.txt']);
    expect(response.body.deleted_files).toEqual(['drop.txt']);
  });

  it('starts every run with an empty data directory', async () => {
    await request(harness.app)
      .post('/v1/exec')
      .set('Authorization', harness.bearer())
      .send({ lang: 'bash', code: 'echo secret > leftover.txt' })
      .expect(200);
    const second = await request(harness.app)
      .post('/v1/exec')
      .set('Authorization', harness.bearer())
      .send({ lang: 'bash', code: 'ls -A' })
      .expect(200);
    expect(second.body.stdout).toBe('');
    expect(harness.interpreter.started).toHaveLength(1);
  });

  it('reports a timeout when code exceeds its budget', async () => {
    const response = await request(harness.app)
      .post('/v1/exec')
      .set('Authorization', harness.bearer())
      .send({ lang: 'bash', code: 'echo start; sleep 10', timeout: 1000 })
      .expect(200);
    expect(response.body.stdout).toBe('start\n');
    expect(response.body.stderr).toContain('Execution timed out');
  });

  it('caps generated files and stdout, marking truncation', async () => {
    await harness.close();
    harness = createHarness({ execution: { maxOutputFiles: 2, maxStdoutBytes: 1024 } });
    const response = await request(harness.app)
      .post('/v1/exec')
      .set('Authorization', harness.bearer())
      .send({
        lang: 'py',
        code: 'print("x" * 5000)\nfor i in range(4): open(f"f{i}.txt", "w").write(str(i))',
      })
      .expect(200);
    expect(response.body.stdout).toHaveLength(1024);
    expect(response.body.status).toBe('OL');
    expect(response.body.files).toHaveLength(2);
    expect(response.body.artifact_truncation).toMatchObject({
      code: 'artifact_truncated',
      reasons: { max_files: 2 },
      skipped_count: 2,
    });
  });

  describe('per-user isolation', () => {
    it('never resolves another user’s files for download, listing, metadata, delete or exec', async () => {
      const owned = await upload(harness, 'user-a', 'private.txt', 'top secret');
      const sessionId = owned.body.storage_session_id as string;
      const fileId = owned.body.files[0].fileId as string;
      const intruder = harness.bearer('user-b');

      await request(harness.app)
        .get(`/v1/download/${sessionId}/${fileId}`)
        .set('Authorization', intruder)
        .expect(404);
      await request(harness.app)
        .get(`/v1/files/${sessionId}`)
        .set('Authorization', intruder)
        .expect(404);
      await request(harness.app)
        .get(`/v1/sessions/${sessionId}/objects/${fileId}`)
        .set('Authorization', intruder)
        .expect(404);
      await request(harness.app)
        .delete(`/v1/files/${sessionId}/${fileId}`)
        .set('Authorization', intruder)
        .expect(404);
      const exec = await request(harness.app)
        .post('/v1/exec')
        .set('Authorization', intruder)
        .send({
          lang: 'bash',
          code: 'cat private.txt',
          files: [{ id: fileId, storage_session_id: sessionId, name: 'private.txt' }],
        })
        .expect(404);
      expect(exec.body.error).toBe('input_file_not_found');

      await request(harness.app)
        .get(`/v1/files/${sessionId}?detail=summary`)
        .set('Authorization', harness.bearer('user-a'))
        .expect(200);
    });

    it('separates the same user id across tenants', async () => {
      const owned = await upload(harness, 'user-a', 'tenant.txt', 'acme only');
      const other = await request(harness.app)
        .get(`/v1/files/${owned.body.storage_session_id}`)
        .set('Authorization', harness.bearer('user-a', { tenant_id: 'other-tenant' }));
      expect(other.status).toBe(404);
    });

    it('refuses to store or fetch user-kind files for a different user id', async () => {
      const response = await upload(harness, 'user-a', 'x.txt', 'x', {
        kind: 'user',
        id: 'user-b',
      });
      expect(response.status).toBe(403);
    });

    it('never hands one user’s sandbox session to another', async () => {
      await request(harness.app)
        .post('/v1/exec')
        .set('Authorization', harness.bearer('user-a'))
        .send({ lang: 'bash', code: 'true' })
        .expect(200);
      await request(harness.app)
        .post('/v1/exec')
        .set('Authorization', harness.bearer('user-b'))
        .send({ lang: 'bash', code: 'true' })
        .expect(200);
      const sessionsByCall = new Set(harness.interpreter.calls.map((call) => call.sessionId));
      expect(harness.interpreter.started).toHaveLength(2);
      expect(sessionsByCall.size).toBe(2);
    });

    it('keeps storage keys free of raw user and tenant identifiers', async () => {
      await upload(harness, 'alice@example.com', 'k.txt', 'k', {
        kind: 'user',
        id: 'alice@example.com',
      });
      const keys = harness.store.keys();
      expect(keys).toHaveLength(1);
      expect(keys[0]).not.toContain('alice');
      expect(keys[0]).toMatch(/^librechat-code\/[0-9a-f]{40}\/s_[0-9a-f]{32}\/f_[0-9a-f]{32}$/);
    });
  });

  describe('file endpoints', () => {
    it('uploads in batches into one stable session per scope', async () => {
      const response = await request(harness.app)
        .post('/v1/upload/batch')
        .set('Authorization', harness.bearer())
        .field('kind', 'skill')
        .field('id', 'skill-1')
        .field('version', '3')
        .field('read_only', 'true')
        .attach('file', Buffer.from('one'), { filepath: 'scripts/one.py' } as never)
        .attach('file', Buffer.from('two'), 'two.md')
        .expect(200);
      expect(response.body).toMatchObject({ message: 'success', succeeded: 2, failed: 0 });
      expect(response.body.files.map((file: { filename: string }) => file.filename).sort()).toEqual(
        ['scripts/one.py', 'two.md'],
      );

      const again = await request(harness.app)
        .post('/v1/upload')
        .set('Authorization', harness.bearer())
        .field('kind', 'skill')
        .field('id', 'skill-1')
        .field('version', '3')
        .attach('file', Buffer.from('three'), 'three.md')
        .expect(200);
      expect(again.body.storage_session_id).toBe(response.body.storage_session_id);

      const listing = await request(harness.app)
        .get(
          `/v1/files/${response.body.storage_session_id}?detail=full&kind=skill&id=skill-1&version=3`,
        )
        .set('Authorization', harness.bearer())
        .expect(200);
      expect(listing.body).toHaveLength(3);
      expect(listing.body[0]).toMatchObject({
        fileId: expect.any(String),
        id: expect.any(String),
        storage_session_id: response.body.storage_session_id,
        metadata: { 'original-filename': expect.any(String) },
      });
    });

    it('marks read-only inputs as unwritable inside the sandbox', async () => {
      const batch = await request(harness.app)
        .post('/v1/upload/batch')
        .set('Authorization', harness.bearer())
        .field('kind', 'agent')
        .field('id', 'agent-1')
        .field('read_only', 'true')
        .attach('file', Buffer.from('locked'), 'locked.txt')
        .expect(200);
      const response = await request(harness.app)
        .post('/v1/exec')
        .set('Authorization', harness.bearer())
        .send({
          lang: 'bash',
          code: '[ -w locked.txt ] && echo writable || echo readonly',
          files: [
            {
              id: batch.body.files[0].fileId,
              storage_session_id: batch.body.storage_session_id,
              name: 'locked.txt',
            },
          ],
        })
        .expect(200);
      expect(response.body.stdout).toBe(process.getuid?.() === 0 ? 'writable\n' : 'readonly\n');
    });

    it('validates upload scope fields', async () => {
      const response = await request(harness.app)
        .post('/v1/upload')
        .set('Authorization', harness.bearer())
        .field('kind', 'skill')
        .field('id', 'skill-1')
        .attach('file', Buffer.from('x'), 'x.md')
        .expect(400);
      expect(response.body.error).toBe('invalid_request');
    });

    it('rejects file names that escape the data directory', async () => {
      const response = await request(harness.app)
        .post('/v1/upload')
        .set('Authorization', harness.bearer())
        .field('kind', 'user')
        .field('id', 'user-a')
        .attach('file', Buffer.from('x'), { filepath: '../../etc/passwd' } as never)
        .expect(400);
      expect(response.body.error).toBe('invalid_request');
    });

    it('rejects uploads over the size limit', async () => {
      await harness.close();
      harness = createHarness({ uploads: { maxFileBytes: 4 } });
      const response = await upload(harness, 'user-a', 'big.txt', 'too large');
      expect(response.status).toBe(413);
    });

    it('returns object metadata and deletes files', async () => {
      const owned = await upload(harness, 'user-a', 'meta.txt', 'm');
      const path = `${owned.body.storage_session_id}/${owned.body.files[0].fileId}`;
      const info = await request(harness.app)
        .get(
          `/v1/sessions/${owned.body.storage_session_id}/objects/${owned.body.files[0].fileId}?kind=user&id=user-a`,
        )
        .set('Authorization', harness.bearer())
        .expect(200);
      expect(info.body).toEqual({ lastModified: expect.any(String), originalFilename: 'meta.txt' });

      await request(harness.app)
        .delete(`/v1/files/${path}`)
        .set('Authorization', harness.bearer())
        .expect(200);
      await request(harness.app)
        .delete(`/v1/files/${path}`)
        .set('Authorization', harness.bearer())
        .expect(404);
    });
  });
});

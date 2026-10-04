import request from 'supertest';
import type { Harness } from '../__tests__/helpers/setup';
import { createHarness } from '../__tests__/helpers/setup';
import { SandboxError } from '../sandbox/types';

describe('exec failure handling', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  const exec = (code = 'echo ok') =>
    request(harness.app)
      .post('/v1/exec')
      .set('Authorization', harness.bearer())
      .send({ lang: 'bash', code });

  it('retries on a fresh session when a pooled session vanished before the run started', async () => {
    await exec().expect(200);
    harness.interpreter.failNext(
      'writeFiles',
      new SandboxError('session_lost', 'ResourceNotFoundException'),
    );
    const response = await exec().expect(200);
    expect(response.body.stdout).toBe('ok\n');
    expect(harness.interpreter.started).toHaveLength(2);
  });

  it('maps AgentCore throttling to a retryable 429 and discards the session', async () => {
    harness.interpreter.failNext(
      'executeCommand',
      new SandboxError('throttled', 'ThrottlingException'),
    );
    const response = await exec().expect(429);
    expect(response.headers['retry-after']).toBe('2');
    expect(response.body).toMatchObject({ error: 'rate_limited', retry_after_seconds: 2 });
    expect(harness.interpreter.stopped).toHaveLength(1);
  });

  it('hides upstream failure detail from the client', async () => {
    harness.interpreter.failNext(
      'executeCommand',
      new SandboxError('failed', 'AccessDeniedException: arn:aws:iam::123'),
    );
    const response = await exec().expect(502);
    expect(JSON.stringify(response.body)).not.toContain('arn:aws');
    expect(response.body.error).toBe('sandbox_unavailable');
  });

  it('reports a data directory the sandbox cannot create as a setup failure', async () => {
    await harness.close();
    harness = createHarness({ execution: { dataDir: '/proc/lc-not-writable' } });
    const response = await exec().expect(500);
    expect(response.body.error).toBe('sandbox_setup_failed');
  });

  it('validates the request body', async () => {
    await request(harness.app)
      .post('/v1/exec')
      .set('Authorization', harness.bearer())
      .send({ lang: 'py' })
      .expect(400);
    expect(harness.interpreter.started).toHaveLength(0);
    await request(harness.app)
      .post('/v1/exec')
      .set('Authorization', harness.bearer())
      .send({ lang: 'py', code: 'x', args: [1] })
      .expect(400);
    await request(harness.app)
      .post('/v1/exec')
      .set('Authorization', harness.bearer())
      .send({ lang: 'py', code: 'x', files: [{ id: '../x', storage_session_id: 's', name: 'a' }] })
      .expect(400);
  });
});

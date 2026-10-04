import type { LocalInterpreter } from '../__tests__/helpers/interpreter';
import { createLocalInterpreter } from '../__tests__/helpers/interpreter';
import { createSessionPool } from './pool';
import { silentLogger } from '../logger';
import { parseConfig } from '../config';

function agentcoreConfig(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    server: {},
    auth: { publicKey: 'unused' },
    agentcore: { region: 'us-east-1', acquireTimeoutMs: 200, ...overrides },
    storage: { bucket: 'bucket' },
    execution: {},
    programmatic: {},
    uploads: {},
  }).agentcore;
}

describe('createSessionPool', () => {
  let interpreter: LocalInterpreter;

  beforeEach(() => {
    interpreter = createLocalInterpreter();
  });

  afterEach(() => {
    interpreter.cleanup();
  });

  it('reuses a released session for the same owner only', async () => {
    const pool = createSessionPool({
      interpreter,
      config: agentcoreConfig(),
      logger: silentLogger,
    });
    const first = await pool.acquire('alice', 1000);
    await first.release('reuse');
    const again = await pool.acquire('alice', 1000);
    expect(again.sessionId).toBe(first.sessionId);
    const other = await pool.acquire('bob', 1000);
    expect(other.sessionId).not.toBe(first.sessionId);
    await Promise.all([again.release('reuse'), other.release('reuse')]);
    await pool.shutdown();
    expect(interpreter.stopped.sort()).toEqual([first.sessionId, other.sessionId].sort());
  });

  it('stops discarded sessions and never reuses them', async () => {
    const pool = createSessionPool({
      interpreter,
      config: agentcoreConfig(),
      logger: silentLogger,
    });
    const lease = await pool.acquire('alice', 1000);
    await lease.release('discard');
    expect(interpreter.stopped).toEqual([lease.sessionId]);
    const next = await pool.acquire('alice', 1000);
    expect(next.sessionId).not.toBe(lease.sessionId);
    await pool.shutdown();
  });

  it('starts a fresh session per run when reuse is disabled', async () => {
    const pool = createSessionPool({
      interpreter,
      config: agentcoreConfig({ reuseSessions: 'false' }),
      logger: silentLogger,
    });
    const lease = await pool.acquire('alice', 1000);
    await lease.release('reuse');
    expect(interpreter.stopped).toEqual([lease.sessionId]);
    expect(pool.stats()).toEqual({ active: 0, idle: 0 });
  });

  it('queues past the per-user limit and rate-limits when the wait expires', async () => {
    const pool = createSessionPool({
      interpreter,
      config: agentcoreConfig({ maxSessionsPerUser: 1 }),
      logger: silentLogger,
    });
    const held = await pool.acquire('alice', 1000);
    const waiting = pool.acquire('alice', 1000);
    await held.release('reuse');
    const handedOver = await waiting;
    expect(handedOver.sessionId).toBe(held.sessionId);

    await expect(pool.acquire('alice', 1000)).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
    await expect(pool.acquire('bob', 1000)).resolves.toBeDefined();
    await pool.shutdown();
  });

  it('evicts another user’s idle session when the global limit is reached', async () => {
    const pool = createSessionPool({
      interpreter,
      config: agentcoreConfig({ maxSessions: 1 }),
      logger: silentLogger,
    });
    const alice = await pool.acquire('alice', 1000);
    await alice.release('reuse');
    const bob = await pool.acquire('bob', 1000);
    expect(bob.sessionId).not.toBe(alice.sessionId);
    expect(interpreter.stopped).toEqual([alice.sessionId]);
    await pool.shutdown();
  });

  it('expires idle sessions after the idle timeout', async () => {
    jest.useFakeTimers();
    try {
      const pool = createSessionPool({
        interpreter,
        config: agentcoreConfig({ sessionIdleSeconds: 5 }),
        logger: silentLogger,
      });
      const lease = await pool.acquire('alice', 1000);
      await lease.release('reuse');
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      expect(interpreter.stopped).toEqual([lease.sessionId]);
      expect(pool.stats()).toEqual({ active: 0, idle: 0 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips idle sessions too close to their AgentCore timeout', async () => {
    let clock = 0;
    const pool = createSessionPool({
      interpreter,
      config: agentcoreConfig({ sessionTimeoutSeconds: 120 }),
      logger: silentLogger,
      now: () => clock,
    });
    const lease = await pool.acquire('alice', 1000);
    await lease.release('reuse');
    clock = 90_000;
    const next = await pool.acquire('alice', 60_000);
    expect(next.sessionId).not.toBe(lease.sessionId);
    expect(interpreter.stopped).toContain(lease.sessionId);
    await pool.shutdown();
  });

  it('releases capacity when a session fails to start', async () => {
    const pool = createSessionPool({
      interpreter: { ...interpreter, startSession: () => Promise.reject(new Error('quota')) },
      config: agentcoreConfig({ maxSessionsPerUser: 1 }),
      logger: silentLogger,
    });
    await expect(pool.acquire('alice', 1000)).rejects.toThrow('quota');
    await expect(pool.acquire('alice', 1000)).rejects.toThrow('quota');
    expect(pool.stats()).toEqual({ active: 0, idle: 0 });
  });
});

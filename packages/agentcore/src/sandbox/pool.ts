import { randomBytes } from 'node:crypto';
import type { CodeInterpreter } from './types';
import type { Config } from '../config';
import type { Logger } from '../logger';
import { rateLimited } from '../errors';

export interface Lease {
  sessionId: string;
  /** `reuse` returns a healthy session to its owner's idle set; `discard` stops it. */
  release(outcome: 'reuse' | 'discard'): Promise<void>;
}

export interface SessionPool {
  /** Leases a session owned exclusively by `owner` with at least `minRemainingMs` of lifetime. */
  acquire(owner: string, minRemainingMs: number): Promise<Lease>;
  /** Starts a session outside the pool's reuse set, still counted against the owner's limit. */
  dedicated(owner: string, timeoutSeconds: number): Promise<Lease>;
  shutdown(): Promise<void>;
  stats(): { active: number; idle: number };
}

interface Slot {
  owner: string;
  sessionId: string;
  expiresAt: number;
  timer?: NodeJS.Timeout;
}

interface Waiter {
  owner: string;
  minRemainingMs: number;
  resolve(lease: Lease): void;
  reject(error: unknown): void;
  timer?: NodeJS.Timeout;
}

export interface SessionPoolOptions {
  interpreter: CodeInterpreter;
  config: Config['agentcore'];
  logger: Logger;
  now?: () => number;
}

const EXPIRY_MARGIN_MS = 15_000;

/**
 * Bounds AgentCore sessions per user and overall. A session is only ever leased to the principal
 * that started it, so sandboxes, their files and their processes are never shared across users.
 */
export function createSessionPool({
  interpreter,
  config,
  logger,
  now = Date.now,
}: SessionPoolOptions): SessionPool {
  const idle = new Map<string, Slot[]>();
  const owned = new Map<string, number>();
  const waiters: Waiter[] = [];
  let total = 0;
  let closed = false;

  const ownedBy = (owner: string): number => owned.get(owner) ?? 0;
  const adjust = (owner: string, delta: number): void => {
    const next = ownedBy(owner) + delta;
    if (next <= 0) {
      owned.delete(owner);
    } else {
      owned.set(owner, next);
    }
    total += delta;
  };

  const stop = async (slot: Slot): Promise<void> => {
    try {
      await interpreter.stopSession(slot.sessionId);
    } catch (error) {
      logger.warn('agentcore.session.stop_failed', { error: (error as Error).message });
    }
  };

  const takeIdle = (owner: string, minRemainingMs: number): Slot | undefined => {
    const slots = idle.get(owner);
    while (slots != null && slots.length > 0) {
      const slot = slots.pop() as Slot;
      clearTimeout(slot.timer);
      if (slot.expiresAt - now() > minRemainingMs + EXPIRY_MARGIN_MS) {
        return slot;
      }
      adjust(owner, -1);
      void stop(slot);
    }
    idle.delete(owner);
    return undefined;
  };

  const evictForeignIdle = (owner: string): boolean => {
    for (const [other, slots] of idle) {
      if (other === owner || slots.length === 0) {
        continue;
      }
      const slot = slots.shift() as Slot;
      clearTimeout(slot.timer);
      if (slots.length === 0) {
        idle.delete(other);
      }
      adjust(other, -1);
      void stop(slot);
      return true;
    }
    return false;
  };

  const hasCapacity = (owner: string): boolean => {
    if (ownedBy(owner) >= config.maxSessionsPerUser) {
      return false;
    }
    return total < config.maxSessions || evictForeignIdle(owner);
  };

  const start = async (owner: string, timeoutSeconds: number): Promise<Slot> => {
    adjust(owner, 1);
    try {
      const sessionId = await interpreter.startSession({
        name: `librechat-${randomBytes(8).toString('hex')}`,
        timeoutSeconds,
      });
      return { owner, sessionId, expiresAt: now() + timeoutSeconds * 1000 };
    } catch (error) {
      adjust(owner, -1);
      pump();
      throw error;
    }
  };

  const park = (slot: Slot): void => {
    slot.timer = setTimeout(() => {
      const slots = idle.get(slot.owner) ?? [];
      const index = slots.indexOf(slot);
      if (index === -1) {
        return;
      }
      slots.splice(index, 1);
      if (slots.length === 0) {
        idle.delete(slot.owner);
      }
      adjust(slot.owner, -1);
      void stop(slot);
      pump();
    }, config.sessionIdleSeconds * 1000);
    slot.timer.unref?.();
    const slots = idle.get(slot.owner) ?? [];
    slots.push(slot);
    idle.set(slot.owner, slots);
  };

  const lease = (slot: Slot, reusable: boolean): Lease => {
    let released = false;
    return {
      sessionId: slot.sessionId,
      async release(outcome) {
        if (released) {
          return;
        }
        released = true;
        const keep =
          reusable &&
          outcome === 'reuse' &&
          config.reuseSessions &&
          !closed &&
          slot.expiresAt - now() > EXPIRY_MARGIN_MS;
        if (keep) {
          park(slot);
        } else {
          adjust(slot.owner, -1);
          await stop(slot);
        }
        pump();
      },
    };
  };

  const tryAcquire = (owner: string, minRemainingMs: number): Promise<Lease> | undefined => {
    const reused = takeIdle(owner, minRemainingMs);
    if (reused != null) {
      return Promise.resolve(lease(reused, true));
    }
    if (!hasCapacity(owner)) {
      return undefined;
    }
    return start(owner, config.sessionTimeoutSeconds).then((slot) => lease(slot, true));
  };

  function pump(): void {
    for (let index = 0; index < waiters.length; ) {
      const waiter = waiters[index];
      const attempt = tryAcquire(waiter.owner, waiter.minRemainingMs);
      if (attempt == null) {
        index += 1;
        continue;
      }
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      attempt.then(waiter.resolve, waiter.reject);
    }
  }

  const wait = (owner: string, minRemainingMs: number): Promise<Lease> =>
    new Promise<Lease>((resolve, reject) => {
      const waiter: Waiter = { owner, minRemainingMs, resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) {
          waiters.splice(index, 1);
        }
        reject(rateLimited(Math.max(1, Math.ceil(config.acquireTimeoutMs / 1000))));
      }, config.acquireTimeoutMs);
      waiters.push(waiter);
    });

  return {
    async acquire(owner, minRemainingMs) {
      if (closed) {
        throw new Error('Session pool is closed');
      }
      return tryAcquire(owner, minRemainingMs) ?? wait(owner, minRemainingMs);
    },
    async dedicated(owner, timeoutSeconds) {
      if (closed) {
        throw new Error('Session pool is closed');
      }
      if (!hasCapacity(owner)) {
        throw rateLimited(Math.max(1, Math.ceil(config.acquireTimeoutMs / 1000)));
      }
      return lease(await start(owner, timeoutSeconds), false);
    },
    async shutdown() {
      closed = true;
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Session pool is closed'));
      }
      const slots = [...idle.values()].flat();
      idle.clear();
      for (const slot of slots) {
        clearTimeout(slot.timer);
        adjust(slot.owner, -1);
      }
      await Promise.all(slots.map(stop));
    },
    stats() {
      const idleCount = [...idle.values()].reduce((sum, slots) => sum + slots.length, 0);
      return { active: total - idleCount, idle: idleCount };
    },
  };
}

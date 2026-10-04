import { createHmac, timingSafeEqual } from 'node:crypto';
import { ServiceError } from '../errors';

export type Lang = 'py' | 'bash';

/** Everything needed to resume a programmatic run on any replica that shares the secret. */
export interface RunState {
  /** Owning principal key; a token is useless to anyone else. */
  owner: string;
  sessionId: string;
  runId: string;
  lang: Lang;
  taskId?: string;
  inputs: string[];
  /** Call ids handed to the client and awaiting results. */
  pending: string[];
  /** Absolute run deadline (epoch ms), bounded by the configured maximum duration. */
  expiresAt: number;
  iterationTimeoutMs: number;
}

export interface TokenCodec {
  sign(state: RunState): string;
  verify(token: unknown, owner: string, now?: number): RunState;
}

const invalidToken = (): ServiceError =>
  new ServiceError(400, 'continuation_invalid', 'Continuation token is invalid or expired');

export function createTokenCodec(secret: string): TokenCodec {
  const mac = (payload: string): Buffer => createHmac('sha256', secret).update(payload).digest();
  return {
    sign(state) {
      const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
      return `${payload}.${mac(payload).toString('base64url')}`;
    },
    verify(token, owner, now = Date.now()) {
      if (typeof token !== 'string') {
        throw invalidToken();
      }
      const [payload, signature, extra] = token.split('.');
      if (payload == null || signature == null || extra != null) {
        throw invalidToken();
      }
      const expected = mac(payload);
      const actual = Buffer.from(signature, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw invalidToken();
      }
      const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as RunState;
      if (state.owner !== owner || state.expiresAt <= now) {
        throw invalidToken();
      }
      return state;
    },
  };
}

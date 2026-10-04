import { createHash, createPublicKey, verify } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';
import type { Config } from './config';
import { ServiceError } from './errors';

/** The authenticated caller. Every storage key and sandbox session is scoped to it. */
export interface Principal {
  tenantId: string;
  userId: string;
  /** Opaque, path-safe digest of tenant and user; never reversible to either. */
  key: string;
}

type Algorithm = Config['auth']['algorithms'][number];

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  iat?: number;
  nbf?: number;
  exp?: number;
  tenant_id?: string;
}

interface Verifier {
  key: KeyObject;
  algorithm: Algorithm;
}

const unauthorized = (message: string): ServiceError =>
  new ServiceError(401, 'unauthorized', message);

function algorithmFor(key: KeyObject): Algorithm | undefined {
  const type = key.asymmetricKeyType;
  if (type === 'ed25519' || type === 'ed448') {
    return 'EdDSA';
  }
  return type === 'rsa' ? 'RS256' : undefined;
}

function loadKey(raw: string): KeyObject {
  const trimmed = raw.trim();
  try {
    return trimmed.startsWith('{')
      ? createPublicKey({ key: JSON.parse(trimmed) as JsonWebKey, format: 'jwk' })
      : createPublicKey(trimmed);
  } catch {
    throw new Error('Code API JWT public key could not be loaded');
  }
}

function toVerifier(key: KeyObject): Verifier {
  const algorithm = algorithmFor(key);
  if (algorithm == null) {
    throw new Error(`Unsupported JWT key type: ${key.asymmetricKeyType ?? 'unknown'}`);
  }
  return { key, algorithm };
}

function loadVerifiers(auth: Config['auth']): {
  byKid: Map<string, Verifier>;
  fallback?: Verifier;
} {
  const byKid = new Map<string, Verifier>();
  if (auth.jwks != null) {
    const document = JSON.parse(auth.jwks) as { keys?: Array<JsonWebKey & { kid?: string }> };
    for (const jwk of document.keys ?? []) {
      if (typeof jwk.kid !== 'string' || jwk.kid === '') {
        throw new Error('Every JWKS key needs a kid');
      }
      byKid.set(jwk.kid, toVerifier(loadKey(JSON.stringify(jwk))));
    }
  }
  if (auth.publicKey == null) {
    return { byKid };
  }
  const verifier = toVerifier(loadKey(auth.publicKey));
  if (auth.kid != null) {
    byKid.set(auth.kid, verifier);
    return { byKid };
  }
  return { byKid, fallback: verifier };
}

function decodeSegment<T>(segment: string): T {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
  } catch {
    throw unauthorized('Malformed token');
  }
}

export function principalKey(tenantId: string, userId: string): string {
  return createHash('sha256').update(`${tenantId}\u0000${userId}`).digest('hex').slice(0, 40);
}

export function createPrincipal(tenantId: string, userId: string): Principal {
  return { tenantId, userId, key: principalKey(tenantId, userId) };
}

export type Authenticator = (authorization: string | undefined) => Principal;

/**
 * Verifies the per-user JWT LibreChat mints for the Code API (`CODEAPI_AUTH_PROVIDER=librechat-jwt`)
 * and resolves it to a principal. Signature, issuer, audience and lifetime are all enforced.
 */
export function createAuthenticator(
  auth: Config['auth'],
  now: () => number = Date.now,
): Authenticator {
  const { byKid, fallback } = loadVerifiers(auth);
  const allowed = new Set<string>(auth.algorithms);

  return (authorization) => {
    const match = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(
      authorization?.trim() ?? '',
    );
    if (match == null) {
      throw unauthorized('Missing bearer token');
    }
    const [, headerSegment, claimsSegment, signatureSegment] = match;
    const header = decodeSegment<JwtHeader>(headerSegment);
    if (header.alg == null || !allowed.has(header.alg)) {
      throw unauthorized('Token algorithm is not accepted');
    }
    const verifier = (header.kid != null ? byKid.get(header.kid) : undefined) ?? fallback;
    if (verifier == null || verifier.algorithm !== header.alg) {
      throw unauthorized('Token signing key is not trusted');
    }
    const signed = Buffer.from(`${headerSegment}.${claimsSegment}`);
    const signature = Buffer.from(signatureSegment, 'base64url');
    const valid = verify(
      verifier.algorithm === 'RS256' ? 'RSA-SHA256' : null,
      signed,
      verifier.key,
      signature,
    );
    if (!valid) {
      throw unauthorized('Token signature is invalid');
    }

    const claims = decodeSegment<JwtClaims>(claimsSegment);
    const seconds = Math.floor(now() / 1000);
    const skew = auth.clockSkewSeconds;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== auth.issuer || !audiences.includes(auth.audience)) {
      throw unauthorized('Token issuer or audience is not accepted');
    }
    if (typeof claims.exp !== 'number' || claims.exp + skew <= seconds) {
      throw unauthorized('Token has expired');
    }
    if (typeof claims.nbf === 'number' && claims.nbf - skew > seconds) {
      throw unauthorized('Token is not yet valid');
    }
    if (typeof claims.iat !== 'number' || claims.exp - claims.iat > auth.maxTokenAgeSeconds) {
      throw unauthorized('Token lifetime is not accepted');
    }
    if (typeof claims.sub !== 'string' || claims.sub === '') {
      throw unauthorized('Token has no subject');
    }
    const tenantId =
      typeof claims.tenant_id === 'string' && claims.tenant_id !== ''
        ? claims.tenant_id
        : auth.defaultTenantId;
    if (tenantId == null) {
      throw unauthorized('Token has no tenant');
    }
    return createPrincipal(tenantId, claims.sub);
  };
}

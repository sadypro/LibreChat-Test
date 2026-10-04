import { createPublicKey } from 'node:crypto';
import { createKeyPair, mintToken } from './__tests__/helpers/setup';
import { createAuthenticator, principalKey } from './auth';
import { parseConfig } from './config';

function authConfig(overrides: Record<string, unknown>) {
  return parseConfig({
    server: {},
    auth: overrides,
    agentcore: { region: 'us-east-1' },
    storage: { bucket: 'bucket' },
    execution: {},
    programmatic: {},
    uploads: {},
  }).auth;
}

describe('createAuthenticator', () => {
  const ed = createKeyPair('ed25519');
  const rsa = createKeyPair('rsa');

  it('accepts LibreChat EdDSA and RS256 tokens and derives a tenant-scoped principal', () => {
    const edAuth = createAuthenticator(authConfig({ publicKey: ed.publicPem }));
    const principal = edAuth(`Bearer ${mintToken(ed.privateKey, { sub: 'u1', tenant_id: 't1' })}`);
    expect(principal).toEqual({ tenantId: 't1', userId: 'u1', key: principalKey('t1', 'u1') });

    const rsaAuth = createAuthenticator(authConfig({ publicKey: rsa.publicPem }));
    expect(rsaAuth(`Bearer ${mintToken(rsa.privateKey, { sub: 'u2' })}`).userId).toBe('u2');
  });

  it('accepts a public JWK and selects keys from a JWKS by kid', () => {
    const jwk = JSON.stringify(createPublicKey(ed.publicPem).export({ format: 'jwk' }));
    expect(
      createAuthenticator(authConfig({ publicKey: jwk }))(`Bearer ${mintToken(ed.privateKey)}`)
        .userId,
    ).toBe('user-a');

    const other = createKeyPair('ed25519');
    const publicJwk = (pair: typeof ed, kid: string) => ({
      ...createPublicKey(pair.publicPem).export({ format: 'jwk' }),
      kid,
    });
    const jwks = JSON.stringify({ keys: [publicJwk(ed, 'old'), publicJwk(other, 'new')] });
    const authenticate = createAuthenticator(authConfig({ jwks }));
    expect(authenticate(`Bearer ${mintToken(other.privateKey, {}, { kid: 'new' })}`).userId).toBe(
      'user-a',
    );
    expect(() => authenticate(`Bearer ${mintToken(other.privateKey, {}, { kid: 'old' })}`)).toThrow(
      'Token signature is invalid',
    );
    expect(() =>
      authenticate(`Bearer ${mintToken(other.privateKey, {}, { kid: 'missing' })}`),
    ).toThrow('not trusted');
  });

  it.each([
    [
      'a different signing key',
      () => mintToken(createKeyPair().privateKey),
      'signature is invalid',
    ],
    ['a wrong issuer', () => mintToken(ed.privateKey, { iss: 'evil' }), 'issuer or audience'],
    ['a wrong audience', () => mintToken(ed.privateKey, { aud: 'other' }), 'issuer or audience'],
    [
      'an expired token',
      () => mintToken(ed.privateKey, { exp: Math.floor(Date.now() / 1000) - 120 }),
      'expired',
    ],
    [
      'a future nbf',
      () =>
        mintToken(ed.privateKey, {
          nbf: Math.floor(Date.now() / 1000) + 600,
          exp: Math.floor(Date.now() / 1000) + 700,
        }),
      'not yet valid',
    ],
    [
      'an overlong lifetime',
      () => mintToken(ed.privateKey, { exp: Math.floor(Date.now() / 1000) + 86_400 }),
      'lifetime',
    ],
    ['no subject', () => mintToken(ed.privateKey, { sub: '' }), 'subject'],
    ['no tenant', () => mintToken(ed.privateKey, { tenant_id: undefined }), 'tenant'],
    ['alg none', () => mintToken(ed.privateKey, {}, { alg: 'none' }), 'algorithm'],
    ['an algorithm swap', () => mintToken(ed.privateKey, {}, { alg: 'RS256' }), 'not trusted'],
  ])('rejects %s', (_label, token, message) => {
    const authenticate = createAuthenticator(authConfig({ publicKey: ed.publicPem }));
    expect(() => authenticate(`Bearer ${token()}`)).toThrow(message);
  });

  it('applies a configured default tenant to tokens without one', () => {
    const authenticate = createAuthenticator(
      authConfig({ publicKey: ed.publicPem, defaultTenantId: 'legacy' }),
    );
    expect(
      authenticate(`Bearer ${mintToken(ed.privateKey, { tenant_id: undefined })}`).tenantId,
    ).toBe('legacy');
  });

  it('rejects malformed authorization headers', () => {
    const authenticate = createAuthenticator(authConfig({ publicKey: ed.publicPem }));
    expect(() => authenticate(undefined)).toThrow('Missing bearer token');
    expect(() => authenticate('Basic abc')).toThrow('Missing bearer token');
    expect(() => authenticate('Bearer a.b.c')).toThrow('Malformed token');
  });
});

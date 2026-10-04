import { loadConfig, DEFAULT_LANGUAGES } from './config';

const required = {
  AGENTCORE_JWT_PUBLIC_KEY: 'pem',
  AWS_REGION: 'us-west-2',
  AGENTCORE_S3_BUCKET: 'code-files',
};

describe('loadConfig', () => {
  it('applies defaults that match LibreChat’s Code API expectations', () => {
    const config = loadConfig(required);
    expect(config.server.port).toBe(8790);
    expect(config.auth).toMatchObject({ issuer: 'librechat', audience: 'codeapi' });
    expect(config.agentcore).toMatchObject({
      region: 'us-west-2',
      codeInterpreterId: 'aws.codeinterpreter.v1',
      reuseSessions: true,
    });
    expect(config.storage).toMatchObject({
      bucket: 'code-files',
      prefix: 'librechat-code/',
      region: 'us-west-2',
    });
    expect(config.execution.dataDir).toBe('/mnt/data');
    expect(config.execution.languages).toEqual(DEFAULT_LANGUAGES);
  });

  it('reads overrides, escaped PEM newlines and base64 keys', () => {
    const config = loadConfig({
      ...required,
      AGENTCORE_JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\\nabc\\n-----END PUBLIC KEY-----',
      AGENTCORE_REUSE_SESSIONS: 'false',
      AGENTCORE_S3_PREFIX: 'tenant-code',
      AGENTCORE_JWT_ALGORITHMS: 'EdDSA',
      AGENTCORE_LANGUAGES: JSON.stringify({
        r: { extension: 'r', command: 'Rscript {file} {args}' },
      }),
    });
    expect(config.auth.publicKey).toBe('-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----');
    expect(config.agentcore.reuseSessions).toBe(false);
    expect(config.storage.prefix).toBe('tenant-code/');
    expect(config.auth.algorithms).toEqual(['EdDSA']);
    expect(Object.keys(config.execution.languages)).toEqual(['r']);

    const fromBase64 = loadConfig({
      AWS_REGION: 'us-west-2',
      AGENTCORE_S3_BUCKET: 'bucket',
      AGENTCORE_JWT_PUBLIC_KEY_BASE64: Buffer.from('pem-text').toString('base64'),
    });
    expect(fromBase64.auth.publicKey).toBe('pem-text');
  });

  it('lists every missing or invalid field', () => {
    expect(() => loadConfig({ AGENTCORE_DATA_DIR: 'relative' })).toThrow(
      /auth.*AGENTCORE_JWT_PUBLIC_KEY.*agentcore\.region.*storage\.bucket.*execution\.dataDir/,
    );
    expect(() =>
      loadConfig({
        ...required,
        AGENTCORE_LANGUAGES: JSON.stringify({ py: { extension: 'py', command: 'python3' } }),
      }),
    ).toThrow(/languages/);
  });
});

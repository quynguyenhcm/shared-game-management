import { describe, expect, it, vi } from 'vitest';
import { WebConfigError, loadWebConfig, loadWebConfigOrExit } from './config.ts';

const SECRET_32 = 's3cret-'.repeat(6);

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { NODE_ENV: 'development', ...overrides };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[name];
  }
  return base;
}

function productionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return env({
    NODE_ENV: 'production',
    WEB_BASE_URL: 'https://games.example.nz',
    API_INTERNAL_URL: 'http://api:4000',
    API_INTERNAL_SHARED_SECRET: SECRET_32,
    WEB_TRUSTED_PROXY_HOPS: '1',
    ...overrides,
  });
}

function issuesFor(
  source: NodeJS.ProcessEnv,
  options: { bakedHost?: string } = {},
): readonly string[] {
  try {
    loadWebConfig(source, options);
  } catch (error) {
    expect(error).toBeInstanceOf(WebConfigError);
    return (error as WebConfigError).issues;
  }
  throw new Error('expected loadWebConfig to throw');
}

describe('loadWebConfig (AC-VERIFY-7)', () => {
  it('applies development defaults with no secret and zero trusted proxy hops', () => {
    expect(loadWebConfig(env())).toEqual({
      nodeEnv: 'development',
      apiInternalUrl: 'http://localhost:4000',
      webBaseUrl: 'http://localhost:3000',
      internalAuthSecret: null,
      trustedProxyHops: 0,
    });
  });

  it('validates API_INTERNAL_URL and WEB_BASE_URL as http(s) URLs, naming the variable and never its value', () => {
    for (const [name, bad] of [
      ['API_INTERNAL_URL', 'ftp://api.internal'],
      ['API_INTERNAL_URL', 'api-garbage secret-host'],
      ['WEB_BASE_URL', 'ftp://games.example.nz'],
      ['WEB_BASE_URL', 'https://games.example.nz/app'],
      ['WEB_BASE_URL', 'not a url secret-host'],
    ] as const) {
      const issues = issuesFor(env({ [name]: bad }));
      expect(issues, `${name}=${bad}`).toEqual([
        expect.stringContaining(`Invalid configuration: ${name} — `),
      ]);
      expect(issues.join('\n')).not.toMatch(/secret-host|api-garbage|api\.internal/);
    }
  });

  it('requires https for WEB_BASE_URL in production, except a localhost host', () => {
    expect(issuesFor(productionEnv({ WEB_BASE_URL: 'http://games.example.nz' }))).toEqual([
      expect.stringContaining('WEB_BASE_URL — must use https in production'),
    ]);
    expect(issuesFor(productionEnv({ WEB_BASE_URL: undefined }))).toEqual([
      expect.stringContaining('WEB_BASE_URL — is required'),
    ]);
    for (const local of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      const config = loadWebConfig(
        productionEnv({ WEB_BASE_URL: local, WEB_TRUSTED_PROXY_HOPS: '0' }),
      );
      expect(config.webBaseUrl).toBe(local);
    }
  });

  it('refuses production without API_INTERNAL_SHARED_SECRET (32+ characters) or WEB_TRUSTED_PROXY_HOPS', () => {
    expect(issuesFor(productionEnv({ API_INTERNAL_SHARED_SECRET: undefined }))).toEqual([
      expect.stringContaining('API_INTERNAL_SHARED_SECRET — is required in production'),
    ]);
    const short = issuesFor(productionEnv({ API_INTERNAL_SHARED_SECRET: 'tiny-secret' }));
    expect(short).toEqual([
      expect.stringContaining('API_INTERNAL_SHARED_SECRET — must be at least 32'),
    ]);
    expect(short.join('\n')).not.toContain('tiny-secret');
    expect(issuesFor(productionEnv({ WEB_TRUSTED_PROXY_HOPS: undefined }))).toEqual([
      expect.stringContaining('WEB_TRUSTED_PROXY_HOPS — is required in production'),
    ]);
  });

  it('rejects the known dev placeholder API_INTERNAL_SHARED_SECRET in production, without echoing it', () => {
    const placeholder = 'dev-only-internal-secret-change-me-0123456789';
    const issues = issuesFor(productionEnv({ API_INTERNAL_SHARED_SECRET: placeholder }));
    expect(issues).toEqual([expect.stringContaining('API_INTERNAL_SHARED_SECRET')]);
    expect(issues.join('\n')).not.toContain(placeholder);
    expect(loadWebConfig(env({ API_INTERNAL_SHARED_SECRET: placeholder })).internalAuthSecret).toBe(
      placeholder,
    );
  });

  it('allows WEB_TRUSTED_PROXY_HOPS=0 in production only for a localhost WEB_BASE_URL; range is 0 to 5', () => {
    expect(issuesFor(productionEnv({ WEB_TRUSTED_PROXY_HOPS: '0' }))).toEqual([
      expect.stringContaining('WEB_TRUSTED_PROXY_HOPS — must be at least 1 unless WEB_BASE_URL'),
    ]);
    for (const bad of ['6', '-1', '1.5', 'two']) {
      expect(issuesFor(env({ WEB_TRUSTED_PROXY_HOPS: bad })), bad).toEqual([
        expect.stringContaining('Invalid configuration: WEB_TRUSTED_PROXY_HOPS — '),
      ]);
    }
    expect(loadWebConfig(productionEnv()).trustedProxyHops).toBe(1);
    expect(loadWebConfig(env({ WEB_TRUSTED_PROXY_HOPS: '2' })).trustedProxyHops).toBe(2);
  });

  it('refuses to boot in production when the host baked into the build differs from the runtime WEB_BASE_URL host', () => {
    // Server Actions compare Origin with the build-time `allowedOrigins`: a mismatch would reject every form.
    const issues = issuesFor(productionEnv(), { bakedHost: 'staging.example.nz' });
    expect(issues).toEqual([
      expect.stringContaining('Invalid configuration: WEB_BASE_URL — host differs from the host'),
    ]);
    expect(issues.join('\n')).not.toContain('staging.example.nz');
    expect(issues.join('\n')).not.toContain('games.example.nz');
    // Same host, no baked host (a local `next build`) and non-production all boot; the port is part of the host.
    expect(() => loadWebConfig(productionEnv(), { bakedHost: 'games.example.nz' })).not.toThrow();
    expect(() => loadWebConfig(productionEnv(), {})).not.toThrow();
    expect(() => loadWebConfig(env(), { bakedHost: 'staging.example.nz' })).not.toThrow();
    expect(() =>
      loadWebConfig(productionEnv({ WEB_BASE_URL: 'https://games.example.nz:8443' }), {
        bakedHost: 'games.example.nz',
      }),
    ).toThrow(WebConfigError);
  });

  it('the production image build fails without the WEB_BASE_URL build arg (no localhost fallback)', async () => {
    const { readFile } = await import('node:fs/promises');
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toMatch(/^ARG WEB_BASE_URL$/m);
    expect(dockerfile).not.toMatch(/ARG WEB_BASE_URL=/);
    expect(dockerfile).toContain('build arg WEB_BASE_URL is required');
    expect(dockerfile).toMatch(/exit 1/);
  });

  it('loadWebConfigOrExit prints value-free issues to stderr and exits 1', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit called');
    });
    try {
      expect(() =>
        loadWebConfigOrExit(productionEnv({ API_INTERNAL_SHARED_SECRET: 'tiny-secret' })),
      ).toThrow('exit called');
      expect(exit).toHaveBeenCalledWith(1);
      const printed = String(write.mock.calls[0]?.[0]);
      expect(printed).toContain('Invalid configuration: API_INTERNAL_SHARED_SECRET — ');
      expect(printed).not.toContain('tiny-secret');
    } finally {
      write.mockRestore();
      exit.mockRestore();
    }
  });
});

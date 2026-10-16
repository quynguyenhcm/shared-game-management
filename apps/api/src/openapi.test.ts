import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { generateOpenApiDocument, generateOpenApiYaml } from './openapi.ts';

interface Operation {
  security?: Record<string, unknown>[];
  responses?: Record<string, unknown>;
}
interface OpenApiDocument {
  components?: { securitySchemes?: Record<string, Record<string, unknown>> };
  paths: Record<string, Record<string, Operation>>;
}

const operationOf = (document: OpenApiDocument, path: string, method: string): Operation => {
  const operation = document.paths[path]?.[method];
  if (operation === undefined) throw new Error(`${method.toUpperCase()} ${path} is not documented`);
  return operation;
};

describe('OpenAPI document', () => {
  it('matches the committed apps/api/openapi.yaml (run `pnpm run openapi` after changing routes)', async () => {
    const committed = await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8');
    expect(await generateOpenApiYaml()).toBe(committed);
  });

  it('documents the bearer sessionToken scheme only (the browser cookie is the web app, not this contract) (AC-VERIFY-8)', async () => {
    const document = (await generateOpenApiDocument()) as unknown as OpenApiDocument;
    expect(document.components?.securitySchemes).toEqual({
      sessionToken: { type: 'http', scheme: 'bearer' },
    });

    const secured = (path: string, method: string): boolean =>
      operationOf(document, path, method).security?.some((entry) => 'sessionToken' in entry) ??
      false;
    // Protected routes require the token; public ones do not.
    expect(secured('/auth/me', 'get')).toBe(true);
    expect(secured('/auth/identities', 'get')).toBe(true);
    expect(secured('/auth/identities/{provider}', 'delete')).toBe(true);
    expect(secured('/auth/register', 'post')).toBe(false);
    expect(secured('/auth/login', 'post')).toBe(false);
    expect(secured('/auth/providers', 'get')).toBe(false);
    expect(secured('/health', 'get')).toBe(false);
  });

  it('documents the 401, 409, 422 and 429 answers of the auth endpoints and a 403 of the shared error shape (AC-VERIFY-8)', async () => {
    const document = (await generateOpenApiDocument()) as unknown as OpenApiDocument;
    const codes = (path: string, method: string): string[] =>
      Object.keys(operationOf(document, path, method).responses ?? {});
    expect(codes('/auth/me', 'get')).toContain('401');
    expect(codes('/auth/register', 'post')).toEqual(expect.arrayContaining(['201', '409', '422']));
    expect(codes('/auth/login', 'post')).toEqual(expect.arrayContaining(['200', '401', '429']));
    expect(codes('/auth/password/forgot', 'post')).toEqual(expect.arrayContaining(['202', '429']));
    expect(codes('/auth/identities/{provider}', 'delete')).toEqual(
      expect.arrayContaining(['204', '401', '409']),
    );
    const documents403 = Object.values(document.paths)
      .flatMap((methods) => Object.values(methods))
      .some((operation) => '403' in (operation.responses ?? {}));
    expect(documents403).toBe(true);
  });

  it('documents the Phase 2 team routes with the bearer requirement on every one and the guard 403 on the invite-code routes (AC-VERIFY-6)', async () => {
    const document = (await generateOpenApiDocument()) as unknown as OpenApiDocument;
    const routes: [string, string][] = [
      ['/teams', 'post'],
      ['/teams/find', 'get'],
      ['/teams/mine', 'get'],
      ['/teams/{teamId}', 'get'],
      ['/teams/invite/lookup', 'post'],
      ['/teams/{teamId}/join-requests', 'post'],
      ['/teams/{teamId}/invite-code', 'get'],
      ['/teams/{teamId}/invite-code/regenerate', 'post'],
    ];
    for (const [path, method] of routes) {
      const operation = operationOf(document, path, method);
      expect(
        operation.security?.some((entry) => 'sessionToken' in entry),
        `${method} ${path}`,
      ).toBe(true);
    }
    expect(Object.keys(operationOf(document, '/teams', 'post').responses ?? {})).toEqual(
      expect.arrayContaining(['200', '201', '401', '422']),
    );
    expect(
      Object.keys(operationOf(document, '/teams/{teamId}/invite-code', 'get').responses ?? {}),
    ).toEqual(expect.arrayContaining(['200', '401', '403']));
  });

  it('documents the five banking and GST routes with the bearer requirement and the 401, 403, 409 and 422 answers (team-banking AC-VERIFY-5)', async () => {
    const document = (await generateOpenApiDocument()) as unknown as OpenApiDocument;
    const routes: [string, string][] = [
      ['/teams/{teamId}/banking', 'get'],
      ['/teams/{teamId}/banking', 'put'],
      ['/teams/{teamId}/banking', 'delete'],
      ['/teams/{teamId}/gst', 'get'],
      ['/teams/{teamId}/gst', 'put'],
    ];
    for (const [path, method] of routes) {
      const operation = operationOf(document, path, method);
      expect(
        operation.security?.some((entry) => 'sessionToken' in entry),
        `${method} ${path}`,
      ).toBe(true);
      expect(Object.keys(operation.responses ?? {}), `${method} ${path}`).toEqual(
        expect.arrayContaining(['200', '401', '403', '409', '422']),
      );
    }
  });

  it('is built from the shared zod contract: the web api-client and the Fastify routes import the same schemas (AC-VERIFY-8)', async () => {
    const routes = await readFile(new URL('./modules/auth/routes.ts', import.meta.url), 'utf8');
    const client = await readFile(
      new URL('../../web/src/lib/api-client.ts', import.meta.url),
      'utf8',
    );
    for (const schema of [
      'AuthSuccessResponse',
      'ErrorResponse',
      'ForgotPasswordResponse',
      'IdentitiesResponse',
      'MeResponse',
      'OAuthAuthorizeResponse',
      'OAuthCallbackResponse',
      'OAuthCompleteResponse',
      'OAuthPendingResponse',
      'ProvidersResponse',
      'ResetPasswordResponse',
    ]) {
      expect(routes, `routes.ts uses ${schema}`).toContain(schema);
      expect(client, `api-client.ts uses ${schema}`).toContain(schema);
    }
    for (const source of [routes, client]) {
      expect(source).toContain("from '@sgm/shared'");
    }
  });
});

/**
 * `POST /webhooks/akahu` (wallet-and-akahu-billing Phase 4a; A4, CR-3; architecture Q1e). A public route, verified by signature:
 *
 *   1. both headers present, key id a safe token, signature plausible base64 ......... else 401 (`missing_header`, `bad_key_id`,
 *                                                                                          `bad_signature_format`)
 *   2. signing key resolved (cached, single-flight, capped) ........................... unknown -> 401 `unknown_key`;
 *                                                                                          fetch failed or capped -> 503
 *   3. RSA-SHA256 over the RAW request bytes ......................................... else 401 `signature_mismatch`
 *   4. JSON object, `type = ONE_OFF_PAYMENT_STATUS_UPDATE`, `_payment` a provider id .... else 200 `ignored` (signed but unusable)
 *   5. an intent has STORED that provider id (URL parameters are never read) .......... else 200 `unmatched`
 *   6. enqueue `akahu-sync` (one per provider id) ...................................... enqueue failure -> 503; else 200
 *
 * The event is only a signal: its `status` is never trusted and nothing is applied inline (the job re-reads Akahu). A replay or a
 * duplicate enqueues a re-read that changes nothing. The raw body is kept only inside this encapsulated plugin (its own content
 * type parser, 16 KiB limit). Log lines carry the rejection reason, the provider id and a short hash of the key id; never the
 * body, the signature or the key id itself (the header values are also redacted by the logger).
 */
import { createHash } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AkahuWebhookAck, ErrorResponse } from '@sgm/shared';
import {
  WEBHOOK_BODY_LIMIT_BYTES,
  SIGNATURE_HEADER,
  SIGNING_KEY_HEADER,
} from '../../lib/akahu/constants.ts';
import { GatewayUnavailableError, type WebhookKeyResolver } from '../../lib/akahu/gateway.ts';
import {
  parseSignatureHeaders,
  verifyWebhookSignature,
} from '../../lib/akahu/webhook-signature.ts';
import { publicRoute } from '../../lib/auth/policy.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import {
  PROVIDER_PAYMENT_ID_PATTERN,
  enqueueAkahuSync,
  findIntentByProviderId,
} from './apply-akahu-result.ts';

export interface AkahuWebhookRoutesOptions {
  readonly db: Database;
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  /** The gateway's signing-key resolver (`PaymentsGateway.webhookKeys`). */
  readonly keys: WebhookKeyResolver;
}

export const ONE_OFF_PAYMENT_EVENT = 'ONE_OFF_PAYMENT_STATUS_UPDATE';

const keyIdHash = (keyId: string): string =>
  createHash('sha256').update(keyId).digest('hex').slice(0, 12);

type EventRead =
  | { readonly ok: true; readonly akahuPaymentId: string }
  | { readonly ok: false; readonly reason: 'malformed' | 'other_type' };

function readEvent(raw: Buffer): EventRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed' };
  }
  const event = parsed as Record<string, unknown>;
  if (event.type !== ONE_OFF_PAYMENT_EVENT) {
    return { ok: false, reason: typeof event.type === 'string' ? 'other_type' : 'malformed' };
  }
  const id = event._payment;
  if (typeof id !== 'string' || !PROVIDER_PAYMENT_ID_PATTERN.test(id)) {
    return { ok: false, reason: 'malformed' };
  }
  return { ok: true, akahuPaymentId: id };
}

export const akahuWebhookRoutes: FastifyPluginAsync<AkahuWebhookRoutesOptions> = (app, options) => {
  // Only this plugin sees raw bytes: every content type is kept as a Buffer, up to 16 KiB (Fastify answers 413 above it).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  app.withTypeProvider<ZodTypeProvider>().post(
    '/akahu',
    {
      config: { policy: publicRoute() },
      bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
      schema: {
        summary: 'Akahu payment status webhook',
        description:
          'Server-to-server only. Verified by an RSA-SHA256 signature over the raw request body (`X-Akahu-Payments-Signature`, base64) with the key named in `X-Akahu-Payments-Signing-Key`. 401 for a missing, malformed, unknown-key or non-matching signature; 503 when the signing key cannot be fetched or the re-read cannot be queued (Akahu retries). Every verified event answers 200 `{ received: true }`, whether or not it names a known payment: the event is only a signal, the payment is re-read from Akahu by a background job and nothing is changed inline.',
        operationId: 'receiveAkahuWebhook',
        response: { 200: AkahuWebhookAck, 401: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (request) => {
      const reject = (reason: string, extra: Record<string, unknown> = {}): never => {
        request.log.warn(
          { event: 'akahu.webhook.rejected', reason, ...extra },
          'akahu webhook rejected',
        );
        throw new AppError('unauthenticated');
      };
      const headers = parseSignatureHeaders(
        request.headers[SIGNATURE_HEADER],
        request.headers[SIGNING_KEY_HEADER],
      );
      if (!headers.ok) return reject(headers.reason);
      const signingKeyIdHash = keyIdHash(headers.keyId);

      let key;
      try {
        key = await options.keys.resolve(headers.keyId);
      } catch (error) {
        const reason = error instanceof GatewayUnavailableError ? error.reason : 'key_fetch_failed';
        request.log.warn(
          { event: 'akahu.webhook.unavailable', reason, signingKeyIdHash },
          'akahu webhook signing key unavailable',
        );
        throw new AppError('service_unavailable');
      }
      if (key === 'unknown') return reject('unknown_key', { signingKeyIdHash });

      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      if (!verifyWebhookSignature(raw, headers.signature, key)) {
        return reject('signature_mismatch', { signingKeyIdHash });
      }

      const read = readEvent(raw);
      if (!read.ok) {
        request.log.info(
          { event: 'akahu.webhook.ignored', reason: read.reason },
          'akahu webhook ignored',
        );
        return { received: true as const };
      }
      const intent = await findIntentByProviderId(options.db, read.akahuPaymentId);
      if (intent === null) {
        request.log.info(
          { event: 'akahu.webhook.unmatched', akahuPaymentId: read.akahuPaymentId },
          'akahu webhook names no known payment',
        );
        return { received: true as const };
      }
      try {
        await enqueueAkahuSync(options.jobs, {
          akahuPaymentId: read.akahuPaymentId,
          source: 'webhook',
        });
      } catch (error) {
        request.log.warn(
          {
            event: 'akahu.webhook.unavailable',
            reason: 'enqueue_failed',
            errorClass: error instanceof Error ? error.name : typeof error,
          },
          'akahu webhook re-read could not be queued',
        );
        throw new AppError('service_unavailable');
      }
      request.log.info(
        {
          event: 'akahu.webhook.accepted',
          akahuPaymentId: read.akahuPaymentId,
          intentKind: intent.kind,
          intentId: intent.id,
        },
        'akahu webhook accepted',
      );
      return { received: true as const };
    },
  );
  return Promise.resolve();
};

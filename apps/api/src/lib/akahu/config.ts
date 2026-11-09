/**
 * Payments settings (`config.payments`) and the adapter factory (CR-12, A6, architecture Q1b). The adapter is chosen
 * only by `PAYMENTS_ADAPTER`; the fake is refused in production. The live Akahu adapter arrives in Phase 4, so
 * `akahu` refuses to build in this build.
 */
import { systemClock, type Clock } from '../clock.ts';
import { createFakePaymentsGateway, type FakeControl } from './fake-adapter.ts';
import { GatewayConfigurationError, type PaymentsGateway } from './gateway.ts';
import type { KeyObject } from 'node:crypto';

export interface AkahuCredentials {
  readonly appToken: string;
  readonly appSecret: string;
  readonly paymentsApiUrl: string;
  readonly webhookUrl: string;
}

export interface PaymentsConfig {
  readonly adapter: 'akahu' | 'fake';
  /** Present only with `adapter = 'akahu'`. */
  readonly akahu: AkahuCredentials | null;
  readonly paymentExpiryMinutes: number;
  /** Close a stale `CREATING` intent after this long. */
  readonly reconcileOrphanAgeSeconds: number;
  /** Re-read an `OPEN` intent after this long. */
  readonly reconcileMinAgeSeconds: number;
  readonly reconcileStuckAfterSeconds: number;
  readonly finalityHorizonHours: number;
}

export interface PaymentsGatewayDeps {
  readonly clock?: Clock;
  readonly nodeEnv?: 'development' | 'test' | 'production';
  readonly fakeControl?: FakeControl;
  readonly fakeWebhookKeys?: Readonly<Record<string, KeyObject>>;
}

export function createPaymentsGateway(
  config: PaymentsConfig,
  deps: PaymentsGatewayDeps = {},
): PaymentsGateway {
  if (config.adapter === 'akahu') {
    throw new GatewayConfigurationError('PAYMENTS_ADAPTER=akahu is not available in this build');
  }
  if (deps.nodeEnv === 'production') {
    throw new GatewayConfigurationError('PAYMENTS_ADAPTER=fake is not allowed in production');
  }
  return createFakePaymentsGateway({
    clock: deps.clock ?? systemClock,
    ...(deps.fakeControl ? { control: deps.fakeControl } : {}),
    ...(deps.fakeWebhookKeys ? { webhookKeys: deps.fakeWebhookKeys } : {}),
  });
}

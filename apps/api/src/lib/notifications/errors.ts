/** Extra context every delivery error carries. `providerCode` is an SMTP code or provider error code. */
export interface NotificationErrorInit {
  readonly adapter: string;
  readonly providerCode?: string;
  readonly cause?: unknown;
}

/**
 * Base of every failure a `Notifier` reports. `retryable` tells the job layer whether trying again
 * can help; messages never carry credentials or the message body.
 */
export class NotificationError extends Error {
  readonly retryable: boolean;
  readonly adapter: string;
  readonly providerCode?: string;

  constructor(message: string, retryable: boolean, init: NotificationErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.retryable = retryable;
    this.adapter = init.adapter;
    if (init.providerCode !== undefined) this.providerCode = init.providerCode;
  }
}

/** Network failure, timeout, 4xx SMTP (greylisting, mailbox busy), 429: trying again may succeed. */
export class TransientDeliveryError extends NotificationError {
  constructor(message: string, init: NotificationErrorInit) {
    super(message, true, init);
  }
}

/** Invalid or suppressed recipient, rejected content, or a message that fails validation: never retry. */
export class PermanentDeliveryError extends NotificationError {
  constructor(message: string, init: NotificationErrorInit) {
    super(message, false, init);
  }
}

/** Authentication failure or unknown sender: an operator must fix configuration; never retry. */
export class NotifierConfigurationError extends NotificationError {
  constructor(message: string, init: NotificationErrorInit) {
    super(message, false, init);
  }
}

import type { PaymentDocumentKind } from '@sgm/shared';
import {
  ADMIN_ACTION_TEXT,
  FILE_TYPE_SUFFIX,
  actionText,
  adminActionName,
  playerActionName,
} from '../../lib/invoices/labels.ts';
import { BUTTON_CLASS, LINK_CLASS } from '../auth/styles.ts';

type Variant = 'primary' | 'link';

type Props =
  | {
      /** The route-handler path (`myDocumentPath`). */
      href: string;
      /** The document kind picks the label: never derived from a GST amount (a registered team's $0.01 payment has $0.00 GST). */
      kind: PaymentDocumentKind;
      context: { location: string; day: string; amount: string };
      variant: Variant;
    }
  | {
      href: string;
      kind: 'ADMIN';
      context: { player: string; day: string; amount: string };
      variant: 'link';
    };

/**
 * The one download action of every surface (payment page, wallet list, admin Payments table; reused by the player-dashboard). A
 * plain anchor with NO `download` attribute (architecture D1): the route handler answers an `attachment`, so the browser saves
 * the file and the page stays; an error comes back as a redirect to a page that renders the sentence. It works without
 * JavaScript. The visible label is the start of the accessible name (WCAG 2.5.3) and the name states the file type and which
 * game and amount it is for, so a list of links is distinguishable.
 */
export function DownloadInvoiceLink(props: Props) {
  const [label, name] =
    props.kind === 'ADMIN'
      ? [ADMIN_ACTION_TEXT, adminActionName(props.context)]
      : [actionText(props.kind), playerActionName(props.kind, props.context)];
  return (
    <a
      href={props.href}
      aria-label={name}
      className={`${props.variant === 'primary' ? `${BUTTON_CLASS} sm:w-auto sm:self-start` : LINK_CLASS} gap-1`}
    >
      {label}
      <span aria-hidden="true" className={props.variant === 'primary' ? 'font-normal' : ''}>
        {FILE_TYPE_SUFFIX}
      </span>
    </a>
  );
}

'use client';

import { useEffect } from 'react';

/**
 * Deletes the `sgm_flash` cookie after /login has shown the conflicting email. It is a plain POST to a
 * route handler: a Server Action that changes cookies would re-render the page and drop the banner. The
 * cookie also expires on its own after 60 seconds, so a failure here is harmless.
 */
export function ClearFlash() {
  useEffect(() => {
    fetch('/auth/clear-flash', { method: 'POST', keepalive: true }).catch(() => undefined);
  }, []);
  return null;
}

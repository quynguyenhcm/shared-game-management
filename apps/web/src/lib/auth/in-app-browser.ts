const IN_APP_BROWSER = /FBAN|FBAV|FB_IAB|Instagram|Messenger/;

/**
 * True for the Facebook, Messenger and Instagram in-app browsers, where Google refuses to sign a user
 * in (`disallowed_useragent`), so the page shows a hint above "Continue with Google" (AC-VERIFY-13).
 */
export function isInAppBrowser(userAgent: string | null | undefined): boolean {
  return userAgent ? IN_APP_BROWSER.test(userAgent) : false;
}

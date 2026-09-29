/** Returns `adminUrl` pointed at another database on the same server. */
export function databaseUrlFor(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

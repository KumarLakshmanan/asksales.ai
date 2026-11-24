export function shouldSkipOwnerAuthCheck(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname === "/support"
    || pathname.startsWith("/support/")
    || pathname === "/support-widget"
    || pathname.startsWith("/support-widget/");
}

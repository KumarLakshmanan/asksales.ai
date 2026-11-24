/**
 * A request cancelled on purpose (a page or effect cleanup calling
 * AbortController.abort()) is not an error. Some cancelled fetch promises are
 * not awaited by anyone, so the browser reported them as uncaught
 * "AbortError: signal is aborted without reason" on every inbox load.
 * Only AbortError is ignored; every other rejection still reaches the console
 * and error reporting.
 */
export function installCancelledRequestGuard(): () => void {
  const ignoreCancelled = (event: PromiseRejectionEvent) => {
    const reason = event.reason as { name?: unknown } | null | undefined;
    if (reason && typeof reason === "object" && reason.name === "AbortError") event.preventDefault();
  };
  window.addEventListener("unhandledrejection", ignoreCancelled);
  return () => window.removeEventListener("unhandledrejection", ignoreCancelled);
}

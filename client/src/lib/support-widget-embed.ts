import { SUPPORT_WIDGET_CLOSE_MESSAGE, SUPPORT_WIDGET_HOST_PARAMETER, supportWidgetHostOrigin } from '../../../shared/supportWidgetEmbed';

/** Embed snippets must remain absolute when pasted into a customer's website. */
export function supportWidgetEmbedScriptUrl(apiBaseUrl: string, pageOrigin: string, token: string): string {
  const apiOrigin = new URL(apiBaseUrl || pageOrigin, pageOrigin);
  const script = new URL('/api/support-widget/embed.js', apiOrigin);
  script.searchParams.set('token', token);
  return script.toString();
}

/** Only the floating loader supplies a host origin. Standalone/inline chat stays open. */
export function requestSupportWidgetClose(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || window.parent === window) return;
  const hostOrigin = supportWidgetHostOrigin(new URLSearchParams(window.location.search).get(SUPPORT_WIDGET_HOST_PARAMETER));
  if (!hostOrigin) return;
  event.preventDefault();
  window.parent.postMessage({ type: SUPPORT_WIDGET_CLOSE_MESSAGE }, hostOrigin);
}

export interface EmailMessageWindowContent {
  subject?: string | null;
  sender: string;
  email?: string;
  receivedAt: string;
  content: string;
}

/** Email fields are text, including HTML-looking message bodies. */
export function populateEmailMessageWindow(target: Window, message: EmailMessageWindowContent) {
  target.opener = null;
  const doc = target.document;
  doc.head.replaceChildren();
  doc.body.replaceChildren();
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  doc.head.append(policy);
  doc.title = message.subject || 'Email View';
  const style = doc.createElement('style');
  style.textContent = 'body{font-family:system-ui,sans-serif;padding:40px;max-width:800px;margin:auto;color:#222}h1{font-size:24px}header{color:#666;border-bottom:1px solid #ddd;padding-bottom:16px;margin-bottom:24px}main{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}';
  doc.head.append(style);
  const subject = doc.createElement('h1');
  subject.textContent = message.subject || '';
  const metadata = doc.createElement('header');
  metadata.textContent = `From: ${message.sender} <${message.email || ''}> | Received: ${message.receivedAt}`;
  const body = doc.createElement('main');
  body.textContent = message.content;
  doc.body.append(subject, metadata, body);
}

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { emailDisplayText as ingestEmailText } from "../../../server/utils/emailDisplay";
import { EmailMessageContent } from "@/components/outreach/EmailMessageContent";

describe("EmailMessageContent", () => {
  it('preserves encoded literal examples from HTML ingestion through default display', () => {
    const html = '<style>body {color:red}</style><p>Contact &lt;sales@example.com&gt;</p><p>Example &amp;lt;script&amp;gt; and &lt;img src=x onerror=alert(1)&gt;</p><script>window.injection=true</script>';
    const storedText = ingestEmailText(html, 'html');
    const { container } = render(<EmailMessageContent content={storedText} htmlContent={html} />);
    expect(container.querySelector('p')?.textContent).toBe('Contact <sales@example.com>\nExample <script> and <img src=x onerror=alert(1)>');
    expect(container.querySelector('script,img,iframe')).toBeNull();
  });
  it.each([
    ['A customer sent a plain-text reply', 'A customer sent a plain-text reply'],
    ['Body text belongs in the message', 'Body text belongs in the message'],
    ['Table reservations are confirmed', 'Table reservations are confirmed'],
    ['a normal lowercase sentence', 'a normal lowercase sentence'],
    ['Body { color:red } is a literal snippet', 'Body { color:red } is a literal snippet'],
    ['Contact <sales@example.com> tomorrow', 'Contact <sales@example.com> tomorrow'],
    ['Contact &lt;sales@example.com&gt; tomorrow', 'Contact <sales@example.com> tomorrow'],
    ['Use <script> as a literal example', 'Use <script> as a literal example'],
    ['Use &amp;lt;script&amp;gt; as a literal example', 'Use <script> as a literal example'],
    ['<script>literal example</script>\n\nSecond paragraph', '<script>literal example</script>\n\nSecond paragraph'],
  ])('renders a plain body as inert text even when formatted HTML is available: %s', (content, expected) => {
    const { container } = render(<EmailMessageContent content={content} htmlContent="<p>Different formatted content</p>" />);
    expect(container.querySelector('p')?.textContent).toBe(expected);
    expect(container.querySelector('script,img,iframe')).toBeNull();
  });
  it('recovers legacy CSS-prefixed content from the explicit HTML field', () => {
    const { container } = render(<EmailMessageContent content="body, table { color:red }Actual message" htmlContent="<style>body, table { color:red }</style><p>Actual message</p>" />);
    expect(container.querySelector('p')?.textContent).toBe('Actual message');
  });
  it('removes styles, hidden preheaders and encoded fillers without injecting markup', () => {
    const html = '<style>body, table, td, a { color:red }</style><div hidden>secret preview</div><p>Hello &amp; welcome</p><p>&amp;#847;&amp;#8199;&amp;#65279;Second line &lt;img src=x onerror=alert(1)&gt;</p><script>alert(1)</script>';
    const { container } = render(<EmailMessageContent content={html} htmlContent={html} />);
    expect(container.querySelector('p')?.textContent).toBe('Hello & welcome\nSecond line <img src=x onerror=alert(1)>');
    expect(container.textContent).not.toContain('body, table');
    expect(container.textContent).not.toContain('secret preview');
    expect(container.querySelector('img,script,iframe')).toBeNull();
  });
  it("shows the theme-friendly text body until the original formatting is requested", () => {
    const { container } = render(
      <div className="dark">
        <EmailMessageContent
          content={"Hello Asha,\n\nHere is your proposal."}
          htmlContent={'<div style="width:1200px;background:white">Original email layout</div>'}
        />
      </div>,
    );

    expect(screen.getByText(/Here is your proposal/)).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View formatted email" }));
    const preview = container.querySelector("iframe");
    expect(preview?.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(preview?.getAttribute("srcdoc")).toContain("Original email layout");

    fireEvent.click(screen.getByRole("button", { name: "Show text" }));
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/Here is your proposal/)).toBeTruthy();
  });
});

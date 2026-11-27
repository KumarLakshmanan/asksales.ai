import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ContentCreatorBody,
  ContentCreatorComposer,
  ContentCreatorShell,
  ContentCreatorStage,
} from "@/components/content-studio/ContentCreatorShell";
import { CreatorPreview, type CreatorPreviewModel } from "@/components/content-studio/CreatorPreview";
import { CreatorScopeProvider } from '@/components/content-studio/CreatorScope';
vi.mock('@/components/content-studio/GeneratorReadiness', () => ({ GeneratorReadiness: () => null }));

describe("ContentCreatorShell", () => {
  it('keeps an embedded Recent action connected to generation and its disabled/loading state', async () => {
    const generate = vi.fn();
    const workspace = (busy = false) => (
      <CreatorScopeProvider value={{ threadId: 214 }}>
        <ContentCreatorShell><ContentCreatorBody recentCount={1}>
          <ContentCreatorComposer><button data-creator-action disabled={busy} onClick={generate}>{busy ? 'Generating…' : 'Generate Ad Copy'}</button></ContentCreatorComposer>
          <ContentCreatorStage preview={<p>Preview</p>}><p>Saved ad copy</p></ContentCreatorStage>
        </ContentCreatorBody></ContentCreatorShell>
      </CreatorScopeProvider>
    );
    const view = render(workspace());
    expect(screen.getByRole('tab', { name: 'Recent (1)' })).toHaveAttribute('aria-selected', 'true');
    const action = document.querySelector<HTMLButtonElement>('[data-creator-action-proxy]')!;
    await userEvent.click(action);
    expect(generate).toHaveBeenCalledOnce();
    view.rerender(workspace(true));
    await waitFor(() => { expect(action).toBeDisabled(); expect(action).toHaveTextContent('Generating…'); });
    await userEvent.click(action);
    expect(generate).toHaveBeenCalledOnce();
  });

  it('says what is missing instead of showing a dead button outside Compose', async () => {
    const generate = vi.fn();
    render(
      <ContentCreatorShell><ContentCreatorBody recentCount={1}>
        <ContentCreatorComposer>
          <label>Post description<textarea /></label>
          <button data-creator-action disabled data-creator-missing="Describe what the post should be about to generate it." onClick={generate}>Generate Post</button>
        </ContentCreatorComposer>
        <ContentCreatorStage preview={<p>Preview</p>}><p>Saved posts</p></ContentCreatorStage>
      </ContentCreatorBody></ContentCreatorShell>,
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Recent (1)' }));
    expect(screen.getByText('Describe what the post should be about to generate it.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Go to Compose' }));
    expect(screen.getByRole('tab', { name: 'Compose' })).toHaveAttribute('aria-selected', 'true');
    expect(generate).not.toHaveBeenCalled();
  });

  it("switches between compose, live preview, and recent results", async () => {
    const user = userEvent.setup();
    const generate = vi.fn();
    const model: CreatorPreviewModel = { format: "social", status: "draft", caption: "A live draft", platform: "LinkedIn" };

    render(
      <ContentCreatorShell>
        <ContentCreatorBody recentCount={2}>
          <ContentCreatorComposer>
            <label>Post description<input /></label>
            <button data-creator-action onClick={generate}>Generate Post</button>
          </ContentCreatorComposer>
          <ContentCreatorStage preview={<CreatorPreview model={model} />} recentCount={2}>
            <p>Two saved results</p>
          </ContentCreatorStage>
        </ContentCreatorBody>
      </ContentCreatorShell>,
    );

    expect(screen.getByRole("tab", { name: "Compose" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getAllByRole("tab", { name: "Preview" })[0]);
    expect(screen.getByText("A live draft")).toBeInTheDocument();
    expect(screen.getByText("LinkedIn")).toBeInTheDocument();
    const mobileAction = document.querySelector<HTMLButtonElement>("[data-creator-action-proxy]");
    expect(mobileAction).toHaveTextContent("Generate Post");
    expect(mobileAction?.previousElementSibling).toHaveAttribute("role", "tablist");
    await user.click(mobileAction!);
    expect(generate).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("tab", { name: "Recent (2)" }));
    expect(screen.getByText("Two saved results")).toBeInTheDocument();
  });
});

describe("CreatorPreview", () => {
  const cases: Array<{ model: CreatorPreviewModel; expected: string }> = [
    { model: { format: "social", caption: "Social proof", platform: "Instagram" }, expected: "Social proof" },
    { model: { format: "blog", title: "Article proof", body: "A useful article body" }, expected: "Article proof" },
    { model: { format: "email", subject: "Email proof", body: "Hello there" }, expected: "Email proof" },
    { model: { format: "sms", message: "SMS proof", maxCharacters: 160 }, expected: "SMS proof" },
    { model: { format: "dm", message: "DM proof", recipient: "Priya" }, expected: "DM proof" },
    { model: { format: "ad", body: "Ad proof", headline: "A clear headline" }, expected: "A clear headline" },
    { model: { format: "image", prompt: "Image proof", aspectRatio: "1:1" }, expected: "Image proof" },
    { model: { format: "video", prompt: "Video proof", duration: "8s" }, expected: "Video proof" },
  ];

  it.each(cases)("renders the $model.format proof adapter", ({ model, expected }) => {
    render(<CreatorPreview model={model} />);
    expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
    expect(screen.getByText("Live draft")).toBeInTheDocument();
  });

  it("surfaces an SMS character overflow", () => {
    render(<CreatorPreview model={{ format: "sms", message: "123456", maxCharacters: 5 }} />);
    expect(screen.getAllByText("6/5")[0]).toHaveClass("text-destructive");
  });

  it.each([
    { model: { format: "social", status: "generating", caption: "Launch prompt" } as CreatorPreviewModel, label: "Drafting your social post" },
    { model: { format: "image", status: "generating", prompt: "Product on a clean desk" } as CreatorPreviewModel, label: "Rendering your image" },
    { model: { format: "video", status: "generating", prompt: "Slow camera push" } as CreatorPreviewModel, label: "Rendering your video" },
  ])("shows an accessible generation state for $model.format", ({ model, label }) => {
    render(<CreatorPreview model={model} />);
    expect(screen.getByRole("status", { name: label })).toBeInTheDocument();
    expect(screen.getByText("Generating")).toBeInTheDocument();
    expect(screen.getByText("Submitted prompt")).toBeInTheDocument();
  });

  it('shows a neutral empty state without rendering an instruction as content', () => {
    render(<CreatorPreview model={{ format: 'email', status: 'empty', body: '', subject: '' }} />);
    expect(screen.getByText('Your preview will appear here')).toBeInTheDocument();
    expect(screen.queryByText('Live draft')).not.toBeInTheDocument();
    expect(screen.queryByText('Subject')).not.toBeInTheDocument();
  });

  it('does not invent SMS content or DM delivery state', () => {
    const view = render(<CreatorPreview model={{ format: 'sms', message: 'Hello', includeOptOut: true }} />);
    expect(screen.queryByText('Reply STOP to opt out.')).not.toBeInTheDocument();
    view.rerender(<CreatorPreview model={{ format: 'dm', message: 'Hello' }} />);
    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
    expect(screen.getByText('Not sent')).toBeInTheDocument();
  });

  it('renders article Markdown as an article rather than raw syntax', () => {
    render(<CreatorPreview model={{ format: 'blog', title: 'Draft', body: '## Details\n\n**Useful** content' }} />);
    expect(screen.getByRole('heading', { name: 'Details' })).toBeInTheDocument();
    expect(screen.getByText('Useful').tagName).toBe('STRONG');
  });

  it('shows the article title once without removing different body headings', () => {
    const view = render(<CreatorPreview model={{ format: 'blog', title: 'Draft', body: '# Draft\n\nArticle text' }} />);
    expect(screen.getAllByRole('heading', { name: 'Draft' })).toHaveLength(1);
    expect(screen.getByText('Article text')).toBeInTheDocument();
    view.rerender(<CreatorPreview model={{ format: 'blog', title: 'Draft', body: '# A different heading\n\nArticle text' }} />);
    expect(screen.getByRole('heading', { name: 'A different heading' })).toBeInTheDocument();
  });
});

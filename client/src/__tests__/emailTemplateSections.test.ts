import { describe, expect, it } from "vitest";
import { normalizeEmailTemplateSections, readEmailDraft } from "@/lib/emailTemplateSections";
import { readLibraryDraft, updateLibraryDraft } from "@/lib/libraryDraft";

it('keeps every email section and native HTML in the canonical library adapter', () => {
  const stored = JSON.stringify({ subject: 'Hello', preheader: 'Preview', greeting: 'Hi Asha,', body: 'Workflow notes.', cta: 'Read the notes', closing: 'Thanks,', signature: 'Team', html: '<p>Workflow notes.</p>' });
  const draft = readEmailDraft(stored);
  expect(draft.body).toBe('Hi Asha,\n\nWorkflow notes.\n\nRead the notes\n\nThanks,\n\nTeam');
  expect(draft.html).toBe('<p>Workflow notes.</p>');
  expect(readLibraryDraft(stored).body).toBe(draft.body);
  const edited = updateLibraryDraft(stored, 'email', 'Edited', draft.body, draft.html);
  expect(readEmailDraft(edited).body).toBe(draft.body);
});

it('renders a reviewed CTA stored in the body and CTA field only once', () => {
  expect(readEmailDraft({ subject: 'Hello', body: 'Workflow notes.\n\nRead the notes', cta: 'Read the notes' }).body).toBe('Workflow notes.\n\nRead the notes');
});

describe("normalizeEmailTemplateSections", () => {
  it("renders a reviewed CTA only once when it is already in the saved body", () => {
    const cta = "Book a demo—no pressure.";
    expect(normalizeEmailTemplateSections({ body: `Meet NimbusFlow.\n\n${cta}`, cta }))
      .toEqual({ body: `Meet NimbusFlow.\n\n${cta}`, cta: undefined });
    expect(normalizeEmailTemplateSections({ body: 'Meet NimbusFlow.', cta }).cta).toBe(cta);
  });
  it("moves first_name out of the signature and into the greeting", () => {
    expect(normalizeEmailTemplateSections({
      greeting: "Hello,",
      body: "Welcome to our product.",
      signature: "Asha\nCustomer Success\n{{first_name}}",
    })).toEqual({
      greeting: "Hi {{first_name}},",
      body: "Welcome to our product.",
      signature: "Asha\nCustomer Success",
    });
  });

  it("preserves an existing personalized greeting", () => {
    expect(normalizeEmailTemplateSections({
      greeting: "Dear {{first_name}},",
      signature: "Asha\n{{ first_name }}",
    })).toEqual({
      greeting: "Dear {{first_name}},",
      signature: "Asha",
    });
  });

  it("does not change a valid template", () => {
    const template = {
      greeting: "Hi {{first_name}},",
      signature: "Asha\nCustomer Success",
    };
    expect(normalizeEmailTemplateSections(template)).toBe(template);
  });
});

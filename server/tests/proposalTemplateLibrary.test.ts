import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { db } from "../models/db.js";
import {
  getFavoriteProposalTemplateIds,
  setProposalTemplateFavorite,
} from "../services/ProposalTemplateLibraryService.js";
import { validateProposalTemplate } from "../../shared/proposalTemplateRules.js";
import { materializeProposalTemplate } from "../../shared/proposals.js";
// @ts-expect-error Seed data intentionally exposes no TypeScript declarations.
import { proposalStarterTemplates } from "../data/proposalStarterTemplates.js";
// @ts-expect-error JavaScript migrations intentionally expose no TypeScript declarations.
import { up } from "../migrations/254_proposal_template_library.js";

const dialect = new PgDialect();
afterEach(() => { jest.restoreAllMocks(); });
describe("proposal template content and requirements", () => {
  it("keeps all ten shipped writing prompts out of customer copy", () => {
    expect(proposalStarterTemplates).toHaveLength(10);
    for (const template of proposalStarterTemplates) {
      expect(validateProposalTemplate(template, true)).toEqual([]);
      const document = materializeProposalTemplate(
        template.templateContent.sections,
        { client_name: "Alex", company_name: "Northstar" },
      );
      expect(
        document.sections
          .filter((section) => section.instruction)
          .every((section) => !section.body),
      ).toBe(true);
      expect(
        document.sections.map((section) => section.body).join("\n"),
      ).not.toMatch(
        /Prepare a|Describe .*verified customer|Do not invent|Confirm payment schedule/,
      );
      const legacy = materializeProposalTemplate(template.templateContent.sections.map((section: { body: string; instruction?: string }) => ({ ...section, body: section.instruction || section.body, instruction: undefined })), {});
      expect(legacy.sections.map(section => section.body).join('\n')).not.toMatch(/Prepare a|Describe .*verified customer|Do not invent|Confirm payment schedule/);
    }
  });
  it("requires custom placeholders to be declared before publishing", () => {
    const template = {
      name: "Custom",
      category: "Consulting",
      templateContent: {
        sections: [
          {
            title: "Scope",
            kind: "content" as const,
            body: "Deliver for {{client_name}} by {{project_deadline}}.",
          },
        ],
        placeholders: [],
        warnings: [],
        requiredFields: [] as string[],
      },
    };
    expect(validateProposalTemplate(template, false)).toEqual([]);
    expect(validateProposalTemplate(template, true)).toEqual([
      "Add these placeholders to required fields: project_deadline.",
    ]);
    template.templateContent.requiredFields = ["project_deadline"];
    expect(validateProposalTemplate(template, true)).toEqual([]);
  });
  it("repairs exact shipped guidance and preserves edited customer wording", async () => {
    const starter = proposalStarterTemplates[0];
    const legacy = {
      id: 1,
      user_id: null,
      template_key: starter.key,
      name: starter.name,
      category: "General",
      published: true,
      version: 1,
      template_content: {
        ...starter.templateContent,
        sections: starter.templateContent.sections.map(
          (section: { body: string; instruction?: string }, index: number) =>
            index === 2
              ? {
                  ...section,
                  body: "Our agreed channel scope is email.",
                  instruction: undefined,
                }
              : {
                  ...section,
                  body: section.instruction || section.body,
                  instruction: undefined,
                },
        ),
      },
    };
    const writes: { query: string; values: unknown[] }[] = [];
    const client = {
      query: async (query: string, values: unknown[] = []) => {
        writes.push({ query, values });
        if (query.startsWith("SELECT *"))
          return { rows: values[0] === starter.key ? [legacy] : [] };
        if (query.startsWith("UPDATE proposal_templates"))
          return {
            rows: [
              {
                ...legacy,
                template_content: JSON.parse(values[1] as string),
                category: values[2],
                version: 2,
              },
            ],
          };
        return { rows: [] };
      },
    };
    await up(client);
    const update = writes.find((write) =>
      write.query.startsWith("UPDATE proposal_templates"),
    )!;
    const content = JSON.parse(update.values[1] as string);
    expect(content.sections[0]).toMatchObject({
      body: "",
      instruction: starter.templateContent.sections[0].instruction,
    });
    expect(content.sections[2].body).toBe("Our agreed channel scope is email.");
    expect(update.values[2]).toBe("Marketing");
    expect(
      writes.filter((write) =>
        write.query.startsWith("INSERT INTO proposal_template_audit"),
      ),
    ).toHaveLength(2);
    expect(writes.some((write) => /UPDATE proposals\b/.test(write.query))).toBe(
      false,
    );
  });
});

describe("tenant-scoped template favorites", () => {
  it("adds favorites only through an atomic visible-template selection", async () => {
    const execute = jest.spyOn(db, "execute").mockResolvedValue({ rows: [] });
    expect(await setProposalTemplateFavorite(8, 42, true)).toBeNull();
    const query = dialect.sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.sql).toContain("INSERT INTO proposal_template_favorites");
    expect(query.sql).toContain("user_id IS NULL AND published");
    expect(query.params).toEqual([8, 42, 8]);
  });
  it("lists only the owner’s favorites for currently available templates", async () => {
    const execute = jest
      .spyOn(db, "execute")
      .mockResolvedValue({ rows: [{ id: 7 }] });
    expect(await getFavoriteProposalTemplateIds(8)).toEqual([7]);
    const query = dialect.sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.sql).toContain("f.user_id=");
    expect(query.sql).toContain("t.user_id IS NULL AND t.published");
    expect(query.params).toEqual([8, 8]);
  });
  it("removes a favorite without changing another owner’s rows", async () => {
    const execute = jest.spyOn(db, "execute").mockResolvedValue({ rows: [] });
    expect(await setProposalTemplateFavorite(8, 42, false)).toEqual({
      templateId: 42,
      favorite: false,
    });
    const query = dialect.sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.sql).toContain("WHERE user_id=");
    expect(query.params).toEqual([8, 42]);
  });
});

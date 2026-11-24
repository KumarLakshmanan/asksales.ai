import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { navSections } from "@/lib/sidebarConfig";
import { supportNavSections } from "@/lib/supportSidebarConfig";

describe("support resource surfaces", () => {
  const root = process.cwd();

  it("keeps the owner Support navigation focused on operations", () => {
    const supportSection = navSections.find((section) => section.section === "support");
    expect(supportSection?.children.map((item) => item.label)).toEqual([
      "Tickets",
      "Teams",
      "Notifications",
      "Pipeline",
      "Analytics",
    ]);
  });

  it("connects support-member creation to atomic notification onboarding", () => {
    const memberCreationPages = [
      "src/app/dashboard/(main)/support/teams/page.tsx",
      "src/app/dashboard/(main)/support/teams/[id]/page.tsx",
    ].map((file) => fs.readFileSync(path.resolve(root, file), "utf8"));

    for (const page of memberCreationPages) {
      expect(page).toContain("SupportMemberNotificationOnboardingFields");
      expect(page).toContain("...memberNotifications");
    }
  });

  it("keeps support notification controls global and assignment-only", () => {
    const settings = fs.readFileSync(path.resolve(root, "src/components/support/OwnerSupportNotificationSettings.tsx"), "utf8");
    const memberSettings = fs.readFileSync(path.resolve(root, "src/app/support/settings/page.tsx"), "utf8");
    expect(settings).toContain("Applies to every support team in this workspace");
    expect(settings).toContain("Only the assigned or reassigned member receives the external alert");
    expect(settings).toContain("Recipient readiness");
    expect(settings).toContain("Delivery activity");
    expect(settings).not.toContain("ChannelNotificationPreferencesForm");
    expect(settings).not.toContain("Support event");
    expect(settings).not.toContain("Team scope");
    expect(memberSettings).not.toContain("ChannelNotificationPreferencesForm");
    expect(memberSettings).toContain("There are no member-level email or WhatsApp switches");
  });

  it("gives support members published read-only resource pages without a social inbox", () => {
    expect(supportNavSections.map((section) => section.activePath)).toEqual(expect.arrayContaining([
      "/support/knowledge-base",
      "/support/media",
      "/support/playbooks",
    ]));
    expect(supportNavSections.map((section) => section.activePath)).not.toContain("/support/social-inbox");
    expect(fs.existsSync(path.resolve(root, "src/app/support/social-inbox/page.tsx"))).toBe(false);
    expect(fs.existsSync(path.resolve(root, "src/app/support/media/page.tsx"))).toBe(true);
    expect(fs.existsSync(path.resolve(root, "src/app/support/playbooks/page.tsx"))).toBe(true);
  });

  it("keeps member knowledge, media, and playbook surfaces view-only", () => {
    const pages = [
      "src/app/support/knowledge-base/page.tsx",
      "src/app/support/media/page.tsx",
      "src/app/support/playbooks/page.tsx",
    ].map((file) => fs.readFileSync(path.resolve(root, file), "utf8"));
    for (const page of pages) {
      expect(page).toContain("Read only");
      expect(page).not.toMatch(/supportApi\.(post|put|patch|delete)/);
      expect(page).not.toMatch(/>\s*(Edit|Create|Publish|Archive|Delete)\s*</);
    }
  });
});

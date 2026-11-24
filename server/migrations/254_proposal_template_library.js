import { proposalStarterTemplates } from "../data/proposalStarterTemplates.js";

export async function up(client) {
  await client.query(
    "CREATE INDEX IF NOT EXISTS proposal_template_audit_history ON proposal_template_audit(template_id,id DESC)",
  );
  // Match only the exact shipped guidance. Preserve custom text, user templates, and proposal snapshots.
  for (const template of proposalStarterTemplates) {
    const result = await client.query(
      "SELECT * FROM proposal_templates WHERE user_id IS NULL AND template_key=$1 FOR UPDATE",
      [template.key],
    );
    for (const row of result.rows) {
      const content = row.template_content || {};
      const sections = (content.sections || []).map((section) => {
        const original = template.templateContent.sections.find(
          (item) =>
            item.title === section.title && item.instruction === section.body,
        );
        return original && !section.instruction
          ? { ...section, instruction: section.body, body: "" }
          : section;
      });
      const nextContent = {
        ...content,
        sections,
        requiredFields:
          content.requiredFields || template.templateContent.requiredFields,
      };
      const category =
        !row.category || row.category === "General"
          ? template.category
          : row.category;
      if (
        JSON.stringify(content) === JSON.stringify(nextContent) &&
        category === row.category
      )
        continue;
      await client.query(
        "INSERT INTO proposal_template_audit(template_id,admin_id,action,snapshot) VALUES ($1,NULL,$2,$3::jsonb)",
        [
          row.id,
          "before_instruction_migration",
          JSON.stringify(toSnapshot(row)),
        ],
      );
      const saved = await client.query(
        "UPDATE proposal_templates SET template_content=$2::jsonb,category=$3,version=version+1,updated_at=NOW() WHERE id=$1 AND user_id IS NULL RETURNING *",
        [row.id, JSON.stringify(nextContent), category],
      );
      await client.query(
        "INSERT INTO proposal_template_audit(template_id,admin_id,action,snapshot) VALUES ($1,NULL,$2,$3::jsonb)",
        [
          row.id,
          "instruction_migration",
          JSON.stringify(toSnapshot(saved.rows[0])),
        ],
      );
    }
  }
}

function toSnapshot(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
      value,
    ]),
  );
}

export async function down(client) {
  // Do not put authoring instructions back into customer copy or erase template history.
  await client.query("SELECT 1");
}

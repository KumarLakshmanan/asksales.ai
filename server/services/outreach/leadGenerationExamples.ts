/** Provide business context without sending the contact record to an LLM. */
export function leadGenerationExamples(leads: Array<Record<string, unknown>>) {
  return leads.slice(0, 3).map(lead => {
    const text = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 160) : '';
    return {
      company: text(lead.company || lead.company_name),
      role: text(lead.role || lead.job_title),
      industry: text(lead.industry),
    };
  });
}

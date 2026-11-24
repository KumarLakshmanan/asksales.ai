/**
 * Strip internal XML-like tags from LLM response text before display.
 * These tags are used by agents internally but should never be shown to users.
 */
export function cleanResponseText(text: string): string {
  return text
    .replace(/<icp_data>[\s\S]*?<\/icp_data>/gi, '')
    .replace(/<FunctionCall>[\s\S]*?<\/FunctionCall>/gi, '')
    .replace(/<FunctionCallBegin>[\s\S]*?<\/?\s*FunctionCallEnd\s*>/gi, '')
    .replace(/<\/?FunctionCallBegin[^>]*>/gi, '')
    .replace(/<\/?FunctionCallEnd[^>]*>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/gi, '')
    .replace(/struct\s+Tool\s*\{[\s\S]*?\}\s*\}/gi, '')
    .trim();
}

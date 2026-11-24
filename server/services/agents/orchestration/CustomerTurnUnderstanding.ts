/** Closed conversational acknowledgements contain no business assertion or
 * permission to cancel a booking, unsubscribe, or transfer ownership. */
export function customerCourtesy(text: string): { replyText: string; closeEnquiry: boolean } | undefined {
  const lines=text.trim().split(/\n+/).map(line=>line.trim()).filter(Boolean);
  const normalize=(value:string)=>value.toLowerCase().replace(/[,.!]/g,' ').replace(/\s+/g,' ').trim();
  const thanks=(value:string)=>/^(?:thanks(?: a lot| so much)?|thank you(?: very much| so much)?)$/.test(normalize(value));
  const declined=/^(?:no (?:thanks|thank you)|not interested (?:thanks|thank you))$/.test(normalize(text));
  const budgetClosed=lines.length===2 && thanks(lines[1])
    && /^(?:(?:the|my|this) )?(?:(?:budget|buget) (?:is )?not (?:ok|okay)|(?:price|rate|cost) (?:is )?too high|too expensive|not within my budget)$/.test(normalize(lines[0]));
  if(declined||budgetClosed)return {replyText:'No problem. Thank you for letting us know. You can message again whenever you need help.',closeEnquiry:true};
  if(thanks(text))return {replyText:'You’re welcome! Let me know if you need anything else.',closeEnquiry:false};
  if(/^(?:வேண்டாம்[,.!\s]*நன்றி)[.!\s]*$/u.test(text.trim()))return {replyText:'பரவாயில்லை. உதவி தேவைப்பட்டால் மீண்டும் தொடர்புகொள்ளலாம்.',closeEnquiry:true};
  if(/^நன்றி[.!\s]*$/u.test(text.trim()))return {replyText:'பரவாயில்லை. வேறு உதவி தேவைப்பட்டால் சொல்லுங்கள்.',closeEnquiry:false};
  return undefined;
}

/** Recognize this fixed lead-form envelope, preserving ranges as incomplete
 * information. Free-form requests, added instructions and actions use NLU. */
export function hospitalityStayLeadForm(text:string): boolean {
  const lines=text.trim().split(/\n+/).map(line=>line.trim()).filter(Boolean);
  if(!/^hello! i filled (?:in|out) your form and would like to know more about your business\.$/i.test(lines[0]||''))return false;
  const fields=lines.slice(1).filter(line=>!/^(?:full name|phone number|email):\s*[^\n]+$/i.test(line));
  if(fields.length!==3)return false;
  const purpose=fields[0].match(/^what are you planning at [\p{L}\p{N} &'().,-]{1,80}\?:\s*(.+)$/iu)?.[1];
  const window=fields[1].match(/^when are you planning your stay\?:\s*(.+)$/i)?.[1];
  const guests=fields[2].match(/^how many guests are you planning for\?:\s*(.+)$/i)?.[1];
  if(!purpose||!window||!guests)return false;
  const words=purpose.toLowerCase().split(/\s+/);
  const vocabulary=new Set(['private','villa','stay','staycation','gateway','getaway','for','friends','holiday','leisure','pool','luxury','family','vacation','weekend','a','and']);
  if(!words.every(word=>vocabulary.has(word)||/^\d{1,2}$/.test(word))
    || !/\b(?:villa|stay|staycation|gateway|getaway|holiday|vacation)\b/i.test(purpose))return false;
  if(!/^(?:within|in|next) \d{1,2}(?:\s*[–-]\s*\d{1,2})? (?:days?|weeks?|months?)$/i.test(window))return false;
  const range=guests.match(/^(\d{1,2})\s*[–-]\s*(\d{1,2}) guests?$/i);
  return Boolean(range&&Number(range[1])>=1&&Number(range[2])>=Number(range[1])&&Number(range[2])<=50);
}

import {sql,type SQLWrapper} from 'drizzle-orm';

/** Local aliases are used only when the analysis explicitly selected India
 * and produced a complete +91 number. Never infer another country's code. */
export function contactImportPhoneAliases(value:string,country?:'IN'|'none') {
  const digits=value.replace(/\D/g,'');
  return country==='IN' && /^91\d{10}$/.test(digits)
    ? [digits,digits.slice(2),'0'+digits.slice(2),'00'+digits] : [digits];
}
/** The generated database key is internal to matching, outside contact edit
 * payloads. Comparing the stored value remains indexable under business RLS. */
export function contactImportPhoneMatch(table:SQLWrapper,value:string,country?:'IN'|'none') {
  return sql`${table}.${sql.identifier('phone_lookup_digits')}=ANY(${sql.param(contactImportPhoneAliases(value,country))}::text[])`;
}

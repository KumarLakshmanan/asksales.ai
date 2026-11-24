import { describe, expect, it } from 'vitest';
import { parseContactCSV, getMissingContactImportMappings } from '@/lib/contactImport';

describe('contact CSV preview', () => {
  it('allows phone-only customer files and optional company', () => {
    expect(getMissingContactImportMappings({Name:'firstName',Mobile:'phone'})).toEqual([]);
    expect(getMissingContactImportMappings({Email:'email'})).toEqual([]);
    expect(getMissingContactImportMappings({Name:'firstName'})).toEqual([{value:'identifier',label:'Email or Phone'}]);
  });
  it('preserves quoted commas, escaped quotes and multiline fields with a BOM', () => {
    expect(parseContactCSV('\uFEFFemail,company,notes\r\na@example.test,"Acme, Inc.","Line one\nLine ""two"""\r\n')).toEqual({
      headers: ['email', 'company', 'notes'],
      rows: [{ email: 'a@example.test', company: 'Acme, Inc.', notes: 'Line one\nLine "two"' }],
    });
  });
  it.each([
    ['email,email\na,b', 'unique'],
    ['email,\na,b', 'header'],
    ['email,company\na', 'columns'],
    ['email,company\na,"open', 'closing quote'],
    ['email,company\na,"closed"extra', 'quoting'],
    ['email,company', 'at least one'],
  ])('rejects malformed CSV: %s', (csv, message) => {
    expect(() => parseContactCSV(csv)).toThrow(message);
  });
  it('previews five complete records', () => {
    const csv = 'email,company\n' + Array.from({ length: 10 }, (_, i) => `a${i}@example.test,Company`).join('\n');
    expect(parseContactCSV(csv).rows).toHaveLength(5);
  });
  it('allows a large CSV preview for the resumable background importer',()=>{
    const csv='Name,Phone\n'+Array.from({length:10001},(_,i)=>`Guest ${i},+919${String(i).padStart(9,'0')}`).join('\n');
    expect(parseContactCSV(csv).rows).toHaveLength(5);
  });
});

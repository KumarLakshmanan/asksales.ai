import {describe,expect,it} from '@jest/globals';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import * as XLSX from '@e965/xlsx';
import {analyzeContactWorkbooks,normalizedContactPhone} from '../services/contacts/ContactWorkbookAnalysis.js';
const csv=(text:string,name='contacts.csv')=>({name,buffer:Buffer.from(text)});
const workbook=(sheets:Record<string,unknown[][]>)=>{
  const book=XLSX.utils.book_new();
  for(const [name,rows] of Object.entries(sheets))XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),name);
  return {name:'contacts.xlsx',buffer:XLSX.write(book,{type:'buffer',bookType:'xlsx'}) as Buffer};
};
describe('contact workbook analysis before CRM changes',()=>{
  it('normalizes Indian prefixes, numeric Excel cells and scientific notation without rounding',()=>{
    for(const input of ['+91 90000 00001','9000000001','09000000001','919000000001',9000000001,'9.000000001E9','9000000001.0']) expect(normalizedContactPhone(input,'IN')).toMatchObject({value:'+919000000001',key:'919000000001',issues:[]});
    expect(normalizedContactPhone('9.9999999999999999E20','IN').issues[0].code).toBe('unsafe_numeric_phone');
    expect(normalizedContactPhone('0044 7700 900123','IN').value).toBe('+447700900123');
    for(const invalid of ['+91 900000001','0091 900000001','+0919000000001']) {
      expect(normalizedContactPhone(invalid,'none')).toMatchObject({value:undefined,candidates:[]});
      expect(normalizedContactPhone(invalid,'IN').issues[0].code).toBe('invalid_international_phone');
    }
  });
  it('counts local numbers held for a missing phone country so the page can offer the fix',()=>{
    const file=csv(['Name,Phone','A,9000000001','B,9000000002'].join('\n'));
    const international=analyzeContactWorkbooks([file],{defaultCountry:'none'}).summary;
    expect(international.totals.readyContacts).toBe(0);
    expect(international.issueCounts).toMatchObject({country_code_required:2});
    const india=analyzeContactWorkbooks([file],{defaultCountry:'IN'}).summary;
    expect(india.totals.readyContacts).toBe(2);
    expect(india.issueCounts?.country_code_required).toBeUndefined();
  });
  it('flags multiple numbers and partial suffixes without inventing another recipient',()=>{
    const partial=normalizedContactPhone('9000000003/83','IN');
    expect(partial.candidates).toEqual(['919000000003']);expect(partial.issues[0].code).toBe('ambiguous_phone_suffix');
    const multiple=normalizedContactPhone('9000000001 / 9000000002','IN');
    expect(multiple.candidates).toHaveLength(2);expect(multiple.issues.some(i=>i.code==='multiple_phone_numbers')).toBe(true);
  });
  it('reads Excel UTF-16 exports and rejects null characters without silently changing identifiers',()=>{
    const file={name:'contacts.tsv',buffer:Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('Name\tPhone\nA\t9000000001','utf16le')])};
    expect(analyzeContactWorkbooks([file],{defaultCountry:'IN'}).summary.totals.readyContacts).toBe(1);
    expect(()=>analyzeContactWorkbooks([csv('Name,Email\nA,a\0@example.com')])).toThrow('null characters');
  });
  it('detects duplicate files by bytes and duplicate recipients across worksheets',()=>{
    const file=workbook({Weekend:[['Name','Contact'],['A',9000000001]],Weekday:[['Name','Phone'],['A','+919000000001'],['B','9000000002']]});
    const {summary,rows}=analyzeContactWorkbooks([file,{...file,name:'copy.xlsx'}],{defaultCountry:'IN'});
    expect(summary.totals).toMatchObject({files:2,distinctFiles:1,duplicateFiles:1,sheets:2,rows:3,uniqueContacts:2,uniquePhoneEntries:2,duplicateRows:1,readyContacts:2});
    expect(rows.find(row=>row.status==='duplicate')?.duplicateOf).toBeDefined();
  });
  it('never collapses different phones through a shared email or an ambiguous email-only row',()=>{
    const {summary,rows}=analyzeContactWorkbooks([csv('Name,Phone,Email\nA,9000000001,shared@example.com\nB,9000000002,shared@example.com\nOffice,,SHARED@example.com\nC,9000000001,other@example.com')],{defaultCountry:'IN'});
    expect(summary.totals).toMatchObject({uniqueContacts:3,uniquePhoneEntries:2,uniqueEmails:2,duplicateRows:1});
    expect(rows.filter(row=>row.status!=='duplicate').map(row=>row.identity)).toEqual(['phone:919000000001','phone:919000000002','email:shared@example.com']);
  });
  it('joins an email-only row when its email has exactly one phone and preserves missing fields',()=>{
    const {summary,rows}=analyzeContactWorkbooks([csv('Name,Email,Phone\nA,PERSON@example.com,\n,person@example.com,9000000001')],{defaultCountry:'IN'});
    expect(summary.totals.uniqueContacts).toBe(1);
    const contact=rows.find(row=>row.status==='ready')!.contact;
    expect(contact).toMatchObject({firstName:'A',email:'person@example.com',phone:'+919000000001'});
  });
  it('detects real headers and row provenance without counting side totals or formatted blanks',()=>{
    const file=workbook({Contacts:[['Guest list'],[],['Name','Contact','','','Total'],['A','9000000001','','',999],[],['B','','','',1200]]});
    const {summary,rows}=analyzeContactWorkbooks([file],{defaultCountry:'IN'});
    expect(summary.sheets[0].headerRow).toBe(3);expect(rows.map(row=>row.rowNumber)).toEqual([4,6]);
    expect(summary.totals).toMatchObject({rows:2,uniqueContacts:1,invalidRows:1});
  });
  it('keeps invalid identifiers reviewable and does not import unresolved country codes',()=>{
    const {summary,rows}=analyzeContactWorkbooks([csv('Name,Phone,Email\nA,9000000001,broken\nB,,\nC,,c@example.com')]);
    expect(summary.totals).toMatchObject({readyContacts:1,reviewContacts:1,invalidRows:1,uniqueContacts:2});
    expect(rows[0].issues.map(i=>i.code)).toEqual(['invalid_email','country_code_required']);expect(rows[0].contact.phone).toBeUndefined();
  });
  it('requires mapping for unknown columns and allows explicit worksheet exclusion',()=>{
    const file=workbook({Contacts:[['Guest','Number'],['A','9000000001']]});
    const initial=analyzeContactWorkbooks([file]);expect(initial.summary.totals.rows).toBe(0);expect(initial.summary.sheets[0].warnings).toHaveLength(1);
    const {hash}=initial.summary.files[0];
    const mapped=analyzeContactWorkbooks([file],{defaultCountry:'IN',sheets:[{fileHash:hash,sheetName:'Contacts',included:true,headerRow:1,mapping:{A:'firstName',B:'phone'}}]});
    expect(mapped.summary.totals.readyContacts).toBe(1);
    expect(analyzeContactWorkbooks([file],{defaultCountry:'IN',sheets:[{fileHash:hash,sheetName:'Contacts',included:false}]}).summary.totals.rows).toBe(0);
  });
  it('does not execute a formula and flags its cached identifier value for review',()=>{
    const file=workbook({Contacts:[['Name','Phone'],['A',{t:'n',v:9000000001,f:'100+8999999901'}]]});
    const {rows}=analyzeContactWorkbooks([file],{defaultCountry:'IN'});
    expect(rows[0].contact.phone).toBe('+919000000001');expect(rows[0].status).toBe('review');expect(rows[0].issues[0].code).toBe('formula_identifier');
  });
  it('does not turn an Excel date in a phone column into a 14-digit recipient',()=>{
    const {summary,rows}=analyzeContactWorkbooks([workbook({Contacts:[['Name','Phone'],['A',new Date('2026-10-01T00:00:00Z')]]})],{defaultCountry:'IN'});
    expect(summary.totals.uniquePhoneEntries).toBe(0);expect(rows[0].status).toBe('invalid');
    expect(rows[0].issues.some(issue=>issue.code==='date_identifier')).toBe(true);
  });
  it('rejects unsupported and corrupt uploads and ambiguous duplicate mappings',()=>{
    expect(()=>analyzeContactWorkbooks([csv('data','run.js')])).toThrow('Upload Excel');
    expect(()=>analyzeContactWorkbooks([csv('invalid','file.xlsx')])).toThrow('incomplete');
    expect(()=>analyzeContactWorkbooks([])).toThrow('1–20');
    const file=workbook({Contacts:[['Name','Phone','Email'],['A','9000000001','a@example.com']]});
    const hash=analyzeContactWorkbooks([file]).summary.files[0].hash;
    expect(()=>analyzeContactWorkbooks([file],{defaultCountry:'IN',sheets:[{fileHash:hash,sheetName:'Contacts',included:true,mapping:{A:'phone',B:'phone'}}]})).toThrow('only once');
  });
  it('applies the archive expansion budget even when OOXML is renamed to .xls',()=>{
    const file=workbook({Contacts:[['Name','Phone'],['A','9000000001']]});
    const data=Buffer.from(file.buffer),directory=data.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
    data.writeUInt32LE(300*1024*1024,directory+24);
    expect(()=>analyzeContactWorkbooks([{name:'renamed.xls',buffer:data}])).toThrow('safe expanded');
  });
});
const downloads=process.env.CONTACT_WORKBOOK_QA_DIR;
(downloads ? it : it.skip)('reconciles the six actual workbooks read-only without exposing contact data',()=>{
  const names=['Database 3.xlsx','Database 3 (1).xlsx','SuzyQ Database Master.xlsx','Company Database.xlsx','Bangalore companies 2.xlsx','Corporate Database.xlsx'];
  const {summary,rows}=analyzeContactWorkbooks(names.map(name=>({name,buffer:readFileSync(join(downloads!,name))})),{defaultCountry:'IN'});
  console.info('Workbook QA totals',summary.totals);
  // The earlier manual count interpreted this date-valued cell as 14 digits.
  // It is an invalid identifier, so the corrected counts are one lower.
  expect(rows.find(row=>row.fileName==='Corporate Database.xlsx' && row.sheetName==='Zomato Guest Data 2025' && row.rowNumber===851)?.issues.map(i=>i.code)).toContain('date_identifier');
  expect(summary.totals).toMatchObject({files:6,distinctFiles:5,duplicateFiles:1,rows:46396,uniquePhoneEntries:30300,uniqueEmails:8874,indianMobileNumbers:30216,uniqueContacts:39124});
},30000);

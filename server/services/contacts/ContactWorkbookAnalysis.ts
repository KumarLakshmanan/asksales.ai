import {createHash} from 'node:crypto';
import * as XLSX from '@e965/xlsx';
import {parse} from 'csv-parse/sync';
import {contactAnalysisFields,type ContactAnalysisField,type ContactAnalysisIssue,type ContactAnalysisOptions,type ContactAnalysisSummary,type AnalyzedContactRow} from '../../../shared/contactAnalysis.js';

export class ContactAnalysisError extends Error {constructor(message:string,public readonly status=400){super(message);}}
export interface ContactAnalysisFile {name:string; buffer:Buffer}
const MAX_UPLOAD=25*1024*1024,MAX_EXPANDED=256*1024*1024;
const tidy=(value:unknown)=>String(value ?? '').normalize('NFKC').trim();
const header=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]/g,'');
const issue=(code:string,message:string,field?:string,severity:ContactAnalysisIssue['severity']='review'):ContactAnalysisIssue=>({code,message,...(field ? {field} : {}),severity});
const aliases:Record<string,ContactAnalysisField>={
  name:'firstName',fullname:'firstName',guestname:'firstName',customername:'firstName',contactname:'firstName',firstname:'firstName',first:'firstName',lastname:'lastName',surname:'lastName',
  contact:'phone',contactnumber:'phone',contactno:'phone',mobileno:'phone',mobile:'phone',mobilenumber:'phone',phone:'phone',phonenumber:'phone',telephone:'phone',whatsapp:'phone',whatsappnumber:'phone',
  email:'email',emailid:'email',emailaddress:'email',emailids:'email',company:'company',companyname:'company',organization:'company',organisation:'company',
  title:'role',designation:'role',jobtitle:'role',role:'role',notes:'notes',remarks:'notes',website:'website',domain:'website',linkedin:'linkedinUrl',linkedinurl:'linkedinUrl',
};

/** Inspect ZIP metadata before a workbook parser expands XML. No extraction or
 * execution of formulas, macros, links or uploaded filenames is performed. */
export function validateContactWorkbookFile(file:ContactAnalysisFile) {
  if(!file.name || file.name.length>500 || file.name.includes('\0')) throw new ContactAnalysisError('Contact filenames must be 1–500 characters.');
  if(!file.buffer.length || file.buffer.length>MAX_UPLOAD) throw new ContactAnalysisError('Each contact file must contain data and be at most 25 MB.');
  if(!/\.(xlsx|xls|csv|tsv)$/i.test(file.name)) throw new ContactAnalysisError('Upload Excel (.xlsx or .xls), CSV or TSV files.');
  const zipSignature=file.buffer.length>=4 && [0x04034b50,0x06054b50].includes(file.buffer.readUInt32LE(0));
  // The parser detects formats by bytes, so renaming OOXML to .xls must not
  // bypass the archive budget.
  if(!/\.xlsx$/i.test(file.name) && !(/\.xls$/i.test(file.name) && zipSignature)) return file.buffer.length;
  const buffer=file.buffer;
  let end=-1;
  for(let pos=buffer.length-22;pos>=Math.max(0,buffer.length-65557);pos--) if(buffer.readUInt32LE(pos)===0x06054b50 && pos+22+buffer.readUInt16LE(pos+20)===buffer.length){end=pos;break;}
  if(end<0) throw new ContactAnalysisError('This Excel file is incomplete or is not a supported workbook.');
  const entries=buffer.readUInt16LE(end+10),start=buffer.readUInt32LE(end+16),size=buffer.readUInt32LE(end+12);
  if(entries===65535 || entries>10000 || start+size>end || buffer.readUInt16LE(end+4)!==0 || buffer.readUInt16LE(end+6)!==0) throw new ContactAnalysisError('This workbook archive is too large or uses an unsupported format.');
  let expanded=0,position=start;
  for(let index=0;index<entries;index++) {
    if(position+46>end || buffer.readUInt32LE(position)!==0x02014b50) throw new ContactAnalysisError('This workbook archive is invalid.');
    const flags=buffer.readUInt16LE(position+8),packed=buffer.readUInt32LE(position+20),unpacked=buffer.readUInt32LE(position+24);
    expanded+=unpacked;
    if(flags&1 || unpacked===0xffffffff || expanded>MAX_EXPANDED || (unpacked>1024*1024 && unpacked/Math.max(1,packed)>2000)) throw new ContactAnalysisError('This workbook is encrypted or exceeds the safe expanded file size.');
    position+=46+buffer.readUInt16LE(position+28)+buffer.readUInt16LE(position+30)+buffer.readUInt16LE(position+32);
    if(position>start+size) throw new ContactAnalysisError('This workbook archive is invalid.');
  }
  if(position!==start+size) throw new ContactAnalysisError('This workbook archive is incomplete.');
  return expanded;
}
export function validateContactAnalysisFiles(files:ContactAnalysisFile[]) {
  if(!files.length || files.length>20 || files.reduce((bytes,file)=>bytes+file.buffer.length,0)>100*1024*1024) throw new ContactAnalysisError('Upload 1–20 contact files, up to 100 MB combined.');
  if(files.reduce((bytes,file)=>bytes+validateContactWorkbookFile(file),0)>MAX_EXPANDED) throw new ContactAnalysisError('The combined expanded workbooks exceed 256 MB. Analyze smaller groups of files.');
}

export function normalizedContactEmail(value:unknown) {
  const text=tidy(value).replace(/^mailto:/i,'').toLowerCase();
  if(!text) return {value:undefined,issues:[] as ContactAnalysisIssue[]};
  if(text.length>254 || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(text)) return {value:undefined,issues:[issue('invalid_email','Correct this email address before importing.','email')]};
  return {value:text,issues:[] as ContactAnalysisIssue[]};
}
export function normalizedContactPhone(value:unknown,defaultCountry:ContactAnalysisOptions['defaultCountry']) {
  let input=tidy(value);
  const issues:ContactAnalysisIssue[]=[];
  if(!input) return {value:undefined,key:undefined,candidates:[] as string[],issues};
  if(/^[+]?\d+(?:\.\d+)?[eE][+\-]?\d+$/.test(input)) {
    const number=Number(input);
    if(Number.isSafeInteger(number)) input=String(number);
    else return {value:undefined,key:undefined,candidates:[],issues:[issue('unsafe_numeric_phone','The spreadsheet may have rounded this number. Restore it as text.','phone')]};
  }
  if(/^\d+\.0+$/.test(input)) input=input.slice(0,input.indexOf('.'));
  const parts=input.split(/[\/;,|\n]+/).map(tidy).filter(Boolean),candidates:string[]=[];
  let primaryValue:string|undefined,primaryKey:string|undefined;
  for(const [index,part] of parts.entries()) {
    let digits=part.replace(/\D/g,'');
    if(part.startsWith('00')) digits=digits.slice(2);
    if(digits.length<7 || digits.length>15) {
      issues.push(issue(index ? 'ambiguous_phone_suffix' : 'invalid_phone',index ? 'A partial or additional number needs review; it was not expanded into a new recipient.' : 'A phone number must have 7–15 digits.','phone'));
      continue;
    }
    const international=/^(\+|00)/.test(part);
    if(international && (digits.startsWith('0') || (digits.startsWith('91') && digits.length!==12))) {
      issues.push(issue('invalid_international_phone','Enter a complete international number; +91 requires ten digits after the country code.','phone'));
      continue;
    }
    if((defaultCountry==='IN' && !international && digits.length<10) || !digits.replace(/0/g,'')) {
      issues.push(issue('incomplete_indian_phone','This is incomplete for an Indian phone number. Enter the full number.','phone'));
      continue;
    }
    if(defaultCountry==='IN') {
      if(digits.length===11 && digits.startsWith('0')) digits=digits.slice(1);
      if(digits.length===10 && !international) digits='91'+digits;
    }
    const isIndia=digits.length===12 && digits.startsWith('91');
    const formatted=international || isIndia ? '+'+digits : undefined;
    if(!formatted) issues.push(issue('country_code_required','Choose a default country or enter the full international phone number.','phone'));
    if(!/^[+0-9\s().-]+$/.test(part)) issues.push(issue('phone_extra_text','This phone cell contains extra text. Verify the number before importing.','phone'));
    if(isIndia && !/^91[6-9]\d{9}$/.test(digits)) issues.push(issue('non_mobile_indian_phone','This does not have the usual Indian mobile format. Verify its intended channel.','phone'));
    if(!candidates.includes(digits)) candidates.push(digits);
    if(primaryKey===undefined) {primaryKey=digits;primaryValue=formatted;}
  }
  if(parts.length>1 && candidates.length>1) issues.push(issue('multiple_phone_numbers','Choose a single primary phone number or split this contact into separate rows.','phone'));
  return {value:primaryValue,key:primaryKey,candidates,issues};
}

type Cell={value:string; formula:boolean; date?:boolean};
type Sheet={name:string; rows:Array<{number:number; cells:Map<number,Cell>}>};
function readSheets(file:ContactAnalysisFile):Sheet[] {
  validateContactWorkbookFile(file);
  try {
    if(/\.(csv|tsv)$/i.test(file.name)) {
      const bytes=file.buffer;
      const text=bytes[0]===0xff && bytes[1]===0xfe ? bytes.subarray(2).toString('utf16le')
        : bytes[0]===0xfe && bytes[1]===0xff ? Buffer.from(bytes.subarray(2)).swap16().toString('utf16le') : bytes.toString('utf8');
      if(text.includes('\0'))throw new ContactAnalysisError('The contact file contains invalid null characters. Save it as UTF-8 CSV or a valid Excel workbook.');
      const rows=parse(text,{bom:true,delimiter:/\.tsv$/i.test(file.name) ? '\t' : ',',relax_column_count:true,max_record_size:1024*1024}) as string[][];
      return [{name:'Contacts',rows:rows.map((cells,index)=>({number:index+1,cells:new Map(cells.map((value,column)=>[column,{value:tidy(value),formula:false}]))}))}];
    }
    const book=XLSX.read(file.buffer,{type:'buffer',cellHTML:false,cellStyles:false,cellText:false,cellNF:true,cellFormula:true,bookVBA:false});
    if(!book.SheetNames.length)throw new ContactAnalysisError('This workbook contains no worksheets.');
    return book.SheetNames.map(name=>{
      const byRow=new Map<number,Map<number,Cell>>();
      // Sparse cells preserve row provenance and avoid trusting oversized !ref
      // dimensions caused by formatting or an isolated far-away cell.
      for(const [address,cell] of Object.entries(book.Sheets[name])) {
        if(!/^[A-Z]+[1-9]\d*$/.test(address)) continue;
        const source=cell as XLSX.CellObject;
        if(typeof source.v==='string' && source.v.includes('\0'))throw new ContactAnalysisError('A worksheet contains invalid null characters. Correct those cells before uploading it.');
        if(source.v==null && !source.f) continue;
        const date=source.t==='d' || (source.t==='n' && XLSX.SSF.is_date(source.z || ''));
        const value=date ? XLSX.utils.format_cell(source) : tidy(source.v);
        if(!value && !source.f) continue;
        const {r,c}=XLSX.utils.decode_cell(address);
        if(!byRow.has(r+1)) byRow.set(r+1,new Map());
        byRow.get(r+1)!.set(c,{value,formula:Boolean(source.f),date});
      }
      return {name,rows:[...byRow].sort(([a],[b])=>a-b).map(([number,cells])=>({number,cells}))};
    });
  } catch(error) {
    if(error instanceof ContactAnalysisError) throw error;
    throw new ContactAnalysisError(`“${file.name}” could not be read. Check that it is a valid, unencrypted contact workbook.`);
  }
}

function sheetMapping(sheet:Sheet,override:NonNullable<ContactAnalysisOptions['sheets']>[number]|undefined) {
  const score=(row:Sheet['rows'][number])=>[...row.cells.values()].reduce((total,cell)=>total+(['email','phone'].includes(aliases[header(cell.value)]) ? 20 : aliases[header(cell.value)] ? 1 : 0),0);
  const best=sheet.rows.slice(0,50).reduce<Sheet['rows'][number]|undefined>((best,row)=>!best || score(row)>score(best) ? row : best,undefined);
  const headerRow=override?.headerRow ?? best?.number ?? 1;
  const row=sheet.rows.find(row=>row.number===headerRow);
  const used=new Set<string>();
  const columns=[...(row?.cells || [])].map(([index,cell])=>{
    const key=XLSX.utils.encode_col(index);
    let field=override?.mapping?.[key] || aliases[header(cell.value)] || 'skip';
    if(!contactAnalysisFields.includes(field)) throw new ContactAnalysisError('A worksheet mapping contains an unsupported contact field.');
    if(field!=='skip' && used.has(field)) {
      if(override?.mapping) throw new ContactAnalysisError('Map each contact field only once per worksheet.');
      field='skip';
    }
    if(field!=='skip') used.add(field);
    return {key,label:cell.value || key,field,index};
  });
  if(override?.mapping && Object.keys(override.mapping).some(key=>!columns.some(column=>column.key===key))) throw new ContactAnalysisError('A mapping refers to a missing worksheet column.');
  return {headerRow,columns};
}

export function analyzeContactWorkbooks(files:ContactAnalysisFile[],options:ContactAnalysisOptions={defaultCountry:'none'}) {
  validateContactAnalysisFiles(files);
  if(!['IN','none'].includes(options.defaultCountry)) throw new ContactAnalysisError('Choose a supported default phone country.');
  const rows:AnalyzedContactRow[]=[],summary:ContactAnalysisSummary={
    version:1,checkedAt:new Date().toISOString(),defaultCountry:options.defaultCountry,options,files:[],sheets:[],
    totals:{files:files.length,distinctFiles:0,duplicateFiles:0,sheets:0,rows:0,uniqueContacts:0,uniquePhoneEntries:0,uniqueEmails:0,indianMobileNumbers:0,readyContacts:0,reviewContacts:0,duplicateRows:0,invalidRows:0,excludedRows:0},
    definitions:{identity:'Phone numbers identify recipients first. Email-only rows join a phone recipient only when that email maps to exactly one phone. Different phone recipients are never merged through a shared email.',
      phones:'Unique phone entries include plausible identifiers for the selected country: Indian local numbers require at least 10 digits; explicit international numbers have 7–15 digits. Only complete international numbers are ready to import. Mobile format does not prove a WhatsApp account exists.',
      consent:'Contact analysis and CRM import do not establish marketing consent or send messages. Outreach still requires recipient eligibility and a reviewed send.'},
  };
  const seenFiles=new Map<string,string>();
  const corrections=new Map((options.rows || []).map(row=>[`${row.fileHash}:${row.sheetName}:${row.rowNumber}`,row]));
  for(const file of files) {
    validateContactWorkbookFile(file);
    const fileHash=createHash('sha256').update(file.buffer).digest('hex'),duplicateOf=seenFiles.get(fileHash);
    summary.files.push({name:file.name,hash:fileHash,bytes:file.buffer.length,...(duplicateOf ? {duplicateOf} : {})});
    if(duplicateOf){summary.totals.duplicateFiles++;continue;}
    seenFiles.set(fileHash,file.name);summary.totals.distinctFiles++;
    for(const sheet of readSheets(file)) {
      const override=options.sheets?.find(item=>item.fileHash===fileHash && item.sheetName===sheet.name);
      const {columns,headerRow}=sheetMapping(sheet,override),included=override?.included!==false;
      const identityColumns=columns.some(column=>column.field==='email' || column.field==='phone');
      const sheetSummary={fileHash,fileName:file.name,sheetName:sheet.name,included,headerRow,columns:columns.map(({index:_,...column})=>column),rowCount:0,warnings:identityColumns ? [] : ['No phone or email column was detected. Map a contact identifier before importing this worksheet.']};
      summary.sheets.push(sheetSummary);summary.totals.sheets++;
      if(!included || !identityColumns) continue;
      for(const source of sheet.rows) {
        if(source.number<=headerRow) continue;
        const mapped:AnalyzedContactRow['contact']={},raw:Record<string,string>={};let issues:ContactAnalysisIssue[]=[];
        for(const column of columns) {
          const cell=source.cells.get(column.index),value=cell?.value || '';
          raw[column.key]=value;
          if(column.field==='skip') continue;
          mapped[column.field]=value;
          if(cell?.date && ['email','phone'].includes(column.field)) {
            mapped[column.field]='';
            issues.push(issue('date_identifier','This identifier cell contains an Excel date, not a phone or email. Correct it before importing.',column.field,'error'));
          }
          if(cell?.formula && ['email','phone'].includes(column.field)) issues.push(issue('formula_identifier','This identifier uses a formula. Verify the saved value before importing.',column.field));
        }
        if(!Object.values(mapped).some(Boolean) && !issues.length) continue;
        if(!issues.length && columns.filter(column=>column.field!=='skip').every(column=>!mapped[column.field as Exclude<ContactAnalysisField,'skip'>] || mapped[column.field as Exclude<ContactAnalysisField,'skip'>]===column.label)) continue;
        const correction=corrections.get(`${fileHash}:${sheet.name}:${source.number}`);
        for(const [field,value] of Object.entries(correction?.contact || {})) {
          if(!contactAnalysisFields.includes(field as ContactAnalysisField) || field==='skip') throw new ContactAnalysisError('A row correction contains an unsupported contact field.');
          mapped[field as Exclude<ContactAnalysisField,'skip'>]=tidy(value);issues=issues.filter(issue=>issue.field!==field);
        }
        const email=normalizedContactEmail(mapped.email),phone=normalizedContactPhone(mapped.phone,options.defaultCountry);
        issues.push(...email.issues,...phone.issues);mapped.email=email.value; mapped.phone=phone.value;
        for(const [field,limit] of [['firstName',255],['lastName',255],['company',255],['role',255],['website',500],['linkedinUrl',500]] as const)
          if(Array.from(mapped[field] || '').length>limit) issues.push(issue('field_too_long',`${field} must contain at most ${limit} characters.`,field));
        if(!phone.key && !email.value) issues.push(issue('missing_identifier','Add a valid email or phone number. It cannot be imported yet.',undefined,'error'));
        const status=correction?.excluded ? 'excluded' : issues.some(i=>i.severity==='error') ? 'invalid' : issues.some(i=>i.severity==='review') ? 'review' : 'ready';
        rows.push({key:`${fileHash}:${sheet.name}:${source.number}`,fileHash,fileName:file.name,sheetName:sheet.name,rowNumber:source.number,raw,contact:mapped,
          phoneKey:phone.key,phoneCandidates:phone.candidates,emailKey:email.value,status,issues});
        sheetSummary.rowCount++;
      }
    }
  }
  const emailPhones=new Map<string,Set<string>>(),phones=new Set<string>(),emails=new Set<string>();
  for(const row of rows) {
    if(row.status==='excluded')continue;
    for(const phone of row.phoneCandidates) phones.add(phone);
    if(row.emailKey) {emails.add(row.emailKey);if(!emailPhones.has(row.emailKey))emailPhones.set(row.emailKey,new Set());if(row.phoneKey)emailPhones.get(row.emailKey)!.add(row.phoneKey);}
  }
  const groups=new Map<string,AnalyzedContactRow[]>();
  for(const row of rows) {
    if(row.status==='invalid' || row.status==='excluded') continue;
    const matches=row.emailKey ? emailPhones.get(row.emailKey) : undefined;
    const phone=row.phoneKey || (matches?.size===1 ? [...matches][0] : undefined);
    row.identity=phone ? `phone:${phone}` : row.emailKey ? `email:${row.emailKey}` : undefined;
    if(!row.identity) continue;
    if(matches && matches.size>1) row.issues.push(issue('shared_email','This email belongs to several phone recipients. Those recipients remain separate.', 'email','info'));
    if(!groups.has(row.identity))groups.set(row.identity,[]);
    groups.get(row.identity)!.push(row);
  }
  for(const group of groups.values()) {
    // Prefer a clean phone-bearing row; retain all source rows for review.
    group.sort((a,b)=>Number(a.status!=='ready')-Number(b.status!=='ready') || Number(!a.phoneKey)-Number(!b.phoneKey));
    const primary=group[0];
    for(const duplicate of group.slice(1)) {
      for(const field of ['firstName','lastName','email','phone','company','role','notes','website','linkedinUrl'] as const) if(!primary.contact[field] && duplicate.status==='ready') primary.contact[field]=duplicate.contact[field];
      duplicate.status='duplicate';duplicate.duplicateOf=primary.key;
    }
  }
  summary.totals={...summary.totals,rows:rows.length,uniqueContacts:groups.size,uniquePhoneEntries:phones.size,uniqueEmails:emails.size,
    indianMobileNumbers:[...phones].filter(phone=>/^91[6-9]\d{9}$/.test(phone)).length,
    readyContacts:rows.filter(row=>row.status==='ready').length,reviewContacts:rows.filter(row=>row.status==='review').length,
    duplicateRows:rows.filter(row=>row.status==='duplicate').length,invalidRows:rows.filter(row=>row.status==='invalid').length,excludedRows:rows.filter(row=>row.status==='excluded').length};
  // Rows held back per reason, so the page can name the fix (e.g. a phone country) when nothing is ready.
  summary.issueCounts={};
  for(const row of rows) if(row.status==='review' || row.status==='invalid')
    for(const code of new Set(row.issues.filter(item=>item.severity!=='info').map(item=>item.code))) summary.issueCounts[code]=(summary.issueCounts[code] || 0)+1;
  return {summary,rows};
}

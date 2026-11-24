export const contactAnalysisFields=['skip','firstName','lastName','email','phone','company','role','notes','website','linkedinUrl'] as const;
export type ContactAnalysisField=typeof contactAnalysisFields[number];
export interface ContactAnalysisOptions {
  defaultCountry:'IN' | 'none';
  sheets?: Array<{fileHash:string; sheetName:string; included:boolean; headerRow?:number; mapping?:Record<string,ContactAnalysisField>}>;
  rows?:Array<{fileHash:string;sheetName:string;rowNumber:number;excluded?:boolean;contact?:Partial<Record<Exclude<ContactAnalysisField,'skip'>,string>>}>;
}
export interface ContactAnalysisIssue {code:string; field?:string; severity:'info' | 'review' | 'error'; message:string}
export interface AnalyzedContactRow {
  key:string; fileHash:string; fileName:string; sheetName:string; rowNumber:number;
  raw:Record<string,string>; contact:Partial<Record<Exclude<ContactAnalysisField,'skip'>,string>>;
  phoneKey?:string; phoneCandidates:string[]; emailKey?:string; identity?:string;
  status:'ready' | 'review' | 'invalid' | 'duplicate' | 'excluded'; duplicateOf?:string;
  issues:ContactAnalysisIssue[];
}
export interface ContactAnalysisSummary {
  version:1; checkedAt:string; defaultCountry:'IN' | 'none';
  options:ContactAnalysisOptions;
  files:Array<{name:string; hash:string; bytes:number; duplicateOf?:string}>;
  sheets:Array<{fileHash:string; fileName:string; sheetName:string; included:boolean; headerRow:number;
    columns:Array<{key:string; label:string; field:ContactAnalysisField}>; rowCount:number; warnings:string[]}>;
  totals:{files:number; distinctFiles:number; duplicateFiles:number; sheets:number; rows:number;
    uniqueContacts:number; uniquePhoneEntries:number; uniqueEmails:number; indianMobileNumbers:number;
    readyContacts:number; reviewContacts:number; duplicateRows:number; invalidRows:number; excludedRows:number};
  definitions:{identity:string; phones:string; consent:string};
  /** Review and invalid rows per issue code. Absent on summaries saved before it existed. */
  issueCounts?:Record<string,number>;
}

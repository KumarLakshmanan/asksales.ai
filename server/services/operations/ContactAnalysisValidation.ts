import {z} from 'zod';
import {contactAnalysisFields} from '../../../shared/contactAnalysis.js';
export const contactAnalysisOptionsSchema=z.object({
  defaultCountry:z.enum(['IN','none']).default('none'),
  sheets:z.array(z.object({fileHash:z.string().regex(/^[a-f0-9]{64}$/),sheetName:z.string().min(1).max(255),included:z.boolean(),
    headerRow:z.number().int().min(1).max(1048576).optional(),mapping:z.record(z.string().regex(/^[A-Z]{1,3}$/),z.enum(contactAnalysisFields)).optional(),
  }).strict()).max(500).optional(),
  rows:z.array(z.object({fileHash:z.string().regex(/^[a-f0-9]{64}$/),sheetName:z.string().min(1).max(255),rowNumber:z.number().int().positive().max(2147483647),
    excluded:z.boolean().optional(),contact:z.partialRecord(z.enum(['firstName','lastName','email','phone','company','role','notes','website','linkedinUrl']),z.string().max(4000)).optional(),
  }).strict()).max(2000).optional(),
}).strict().superRefine((value,context)=>{
  for(const [field,items,key] of [
    ['sheets',value.sheets || [],(row:{fileHash:string;sheetName:string})=>`${row.fileHash}:${row.sheetName}`],
    ['rows',value.rows || [],(row:{fileHash:string;sheetName:string;rowNumber?:number})=>`${row.fileHash}:${row.sheetName}:${row.rowNumber}`],
  ] as const) {
    const seen=new Set<string>();
    items.forEach((item,index)=>{const identity=key(item);if(seen.has(identity))context.addIssue({code:'custom',path:[field,index],message:'Each worksheet or source row may only be configured once.'});seen.add(identity);});
  }
});
export const operationIdSchema=z.string().uuid();
export const operationRequestKeySchema=z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
export const analysisPageSchema=z.object({status:z.enum(['ready','review','invalid','duplicate','excluded']).optional(),
  after:z.coerce.number().int().min(0).max(2147483647).default(0),pageSize:z.coerce.number().int().min(1).max(200).default(50),
}).strict();

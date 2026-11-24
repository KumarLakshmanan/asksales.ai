import type {InboxChannel} from './outreachInbox.js';
import type {OutreachLocalFollowUps} from './outreachLocalFollowUps.js';
import type {DashboardOperationResult} from './dashboardOperations.js';

export interface PreparedOutreachComposer {
  channel:InboxChannel;leadIds:number[];threadId?:number;accountId:string;providerAccountId:string;
  body:string;subject?:string;htmlMode?:boolean;templateId?:string;templateValues?:Record<string,string>;
  whatsappMode:'template';optInConfirmed:false;sendWhen:'now'|'later';scheduledFor?:string;
  followUps:Partial<Record<InboxChannel,OutreachLocalFollowUps>>;
}
export interface PreparedOutreach {
  id:string;businessProfileId:number;name:string;createdAt:string;expiresAt:string;
  audience:{source:'crm'|'campaign';importId:number;name:string;count:number};
  draft:PreparedOutreachComposer;warnings:string[];card:DashboardOperationResult;
  launch?:{submittedAt:string;status:'processing'|'submitted';receipt?:Record<string,unknown>};
}

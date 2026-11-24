import {AutomationBuilder} from '@/components/crm/AutomationBuilder';
export default async function EditAutomationPage({params}:{params:Promise<{id:string}>}){
  const {id}=await params;return <AutomationBuilder automationId={Number(id)}/>;
}

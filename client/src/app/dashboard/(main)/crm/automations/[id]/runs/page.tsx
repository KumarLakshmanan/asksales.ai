import {AutomationRuns} from '@/components/crm/AutomationRuns';
export default async function AutomationRunsPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{run?:string}>}){
  const [{id},{run}]=await Promise.all([params,searchParams]);return <AutomationRuns automationId={Number(id)} initialRunId={run ? Number(run) : undefined}/>;
}

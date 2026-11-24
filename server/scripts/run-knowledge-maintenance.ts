import { knowledgeMaintenanceService } from '../services/knowledge/KnowledgeMaintenanceService.js';

knowledgeMaintenanceService.run()
  .then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (Array.isArray(report.failures) && report.failures.length > 0) process.exitCode = 1;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });

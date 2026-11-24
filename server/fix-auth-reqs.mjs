import fs from 'fs';
import path from 'path';

const files = [
    'apiCredentialsController.ts',
    'apifyController.ts',
    'campaignAnalyticsController.ts',
    'contentCalendarController.ts',
    'contentTemplatesController.ts',
    'emailSendersController.ts',
    'integrationDisconnectController.ts',
    'integrationsController.ts',
    'notificationsController.ts',
    'outreachConversationsController.ts',
    'settingsController.ts',
    'userSuggestionsController.ts',
    'webhooksController.ts'
];

for (const file of files) {
    const filePath = path.join(process.cwd(), 'controllers', file);
    if (!fs.existsSync(filePath)) continue;
    
    let content = fs.readFileSync(filePath, 'utf-8');
    let lines = content.split('\n');
    
    let startIdx = -1;
    let endIdx = -1;
    
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].match(/^interface (AuthenticatedRequest|AuthRequest) extends Request/)) {
            startIdx = i;
            let braces = 0;
            for (let j = i; j < lines.length; j++) {
                const openCount = (lines[j].match(/\{/g) || []).length;
                const closeCount = (lines[j].match(/\}/g) || []).length;
                braces += openCount - closeCount;
                if (braces === 0) {
                    endIdx = j;
                    break;
                }
            }
            break;
        }
    }
    
    if (startIdx !== -1 && endIdx !== -1) {
        lines.splice(startIdx, endIdx - startIdx + 1);
        content = lines.join('\n');
        
        if (!content.includes('../types/express')) {
            content = "import type { AuthenticatedRequest, AuthenticatedRequest as AuthRequest } from '../types/express.js';\n" + content;
        }
        fs.writeFileSync(filePath, content, 'utf-8');
        console.log(`Fixed ${file}`);
    }
}

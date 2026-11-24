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
    'outreachConversationsController.ts',
    'userSuggestionsController.ts',
    'webhooksController.ts'
];

for (const file of files) {
    const filePath = path.join(process.cwd(), 'controllers', file);
    let content = fs.readFileSync(filePath, 'utf-8');
    
    // Specifically target the left over bits from interface AuthRequest { user?: { id: number } }
    // It usually looks like:
    // // Extend Express Request to include user
    // ;
    // }
    content = content.replace(/\/\/ Extend Express Request to include user\s*;\s*\}/g, '');
    content = content.replace(/\/\/ Extend Express Request to include user\s*\}/g, '');
    
    // Also, some files might just have a `;\n}` or `\n  };\n}`. Let's just fix it manually if needed,
    // or run a smart regex that looks at lines 1-30.
    const lines = content.split('\n');
    let newLines = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // If line is just `}` or `;` or `  };` and we are before line 40
        if (i < 40 && (line.trim() === '}' || line.trim() === ';' || line.trim() === '};')) {
            // skip it
            continue;
        }
        newLines.push(line);
    }
    
    fs.writeFileSync(filePath, newLines.join('\n'), 'utf-8');
    console.log(`Fixed ${file}`);
}

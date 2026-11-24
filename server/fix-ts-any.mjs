import fs from 'fs';
import path from 'path';

const log = fs.readFileSync('ts-errors.log', 'utf-8');
const lines = log.split('\n');

const fixes = {};

lines.forEach(line => {
    const match = line.match(/^(.+?)\((\d+),(\d+)\): error TS7006: Parameter '([^']+)' implicitly has an 'any' type\./);
    if (match) {
        const file = match[1];
        const lineNum = parseInt(match[2], 10) - 1;
        const colNum = parseInt(match[3], 10) - 1;
        const param = match[4];

        if (!fixes[file]) fixes[file] = [];
        fixes[file].push({ line: lineNum, col: colNum, param });
    }
});

for (const file of Object.keys(fixes)) {
    const filePath = path.join(process.cwd(), file);
    if (!fs.existsSync(filePath)) continue;

    let content = fs.readFileSync(filePath, 'utf-8').split('\n');
    
    // Sort by line descending, then col descending so we can modify without affecting offsets
    fixes[file].sort((a, b) => {
        if (a.line !== b.line) return b.line - a.line;
        return b.col - a.col;
    });

    for (const fix of fixes[file]) {
        const lineText = content[fix.line];
        // We need to insert `: any` after the parameter.
        // The column points to the start of the parameter.
        const before = lineText.substring(0, fix.col + fix.param.length);
        const after = lineText.substring(fix.col + fix.param.length);
        content[fix.line] = before + ': any' + after;
    }

    fs.writeFileSync(filePath, content.join('\n'), 'utf-8');
    console.log(`Fixed implicitly any in ${file}`);
}

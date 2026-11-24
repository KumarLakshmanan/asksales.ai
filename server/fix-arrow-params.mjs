import fs from 'fs';
import path from 'path';

function walkSync(currentDirPath, callback) {
    fs.readdirSync(currentDirPath).forEach(function (name) {
        var filePath = path.join(currentDirPath, name);
        var stat = fs.statSync(filePath);
        if (stat.isFile()) {
            callback(filePath, stat);
        } else if (stat.isDirectory()) {
            walkSync(filePath, callback);
        }
    });
}

const dirs = [path.join(process.cwd(), 'controllers'), path.join(process.cwd(), 'mastra'), path.join(process.cwd(), 'models'), path.join(process.cwd(), 'scripts'), path.join(process.cwd(), 'services'), path.join(process.cwd(), 'tests')];
let modifiedCount = 0;

for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    walkSync(dir, (filePath) => {
        if (filePath.endsWith('.ts')) {
            const content = fs.readFileSync(filePath, 'utf-8');
            let newContent = content.replace(/\b([a-zA-Z0-9_]+): any =>/g, '($1: any) =>');
            if (newContent !== content) {
                fs.writeFileSync(filePath, newContent, 'utf-8');
                modifiedCount++;
            }
        }
    });
}

console.log(`Fixed arrow params in ${modifiedCount} files.`);

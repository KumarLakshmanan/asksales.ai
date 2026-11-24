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

const testsDir = path.join(process.cwd(), 'tests');
let modifiedCount = 0;

walkSync(testsDir, (filePath) => {
    if (filePath.endsWith('.ts')) {
        const content = fs.readFileSync(filePath, 'utf-8');
        let newContent = content.replace(/jest\.fn\(\)\.mock/g, 'jest.fn<any>().mock');
        if (newContent !== content) {
            fs.writeFileSync(filePath, newContent, 'utf-8');
            modifiedCount++;
        }
    }
});

console.log(`Fixed jest mocks in ${modifiedCount} files.`);

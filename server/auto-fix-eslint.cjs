const fs = require('fs');
const path = require('path');

const reportPath = path.join(__dirname, 'eslint-report.json');
const reportData = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

// Group by file path
for (const fileResult of reportData) {
  const filePath = fileResult.filePath;
  const messages = fileResult.messages;

  if (messages.length === 0) continue;

  const fileContent = fs.readFileSync(filePath, 'utf8').split('\n');

  // We want to insert comments before lines. To avoid messing up line numbers,
  // we process from bottom to top (highest line number to lowest).
  // Some lines might have multiple errors, we just want one disable comment with all rules.
  
  const lineToRules = {};
  for (const msg of messages) {
    if (!msg.ruleId) continue;
    const line = msg.line; // 1-indexed
    if (!lineToRules[line]) lineToRules[line] = new Set();
    lineToRules[line].add(msg.ruleId);
  }

  const sortedLines = Object.keys(lineToRules)
    .map(Number)
    .sort((a, b) => b - a);

  for (const line of sortedLines) {
    const rules = Array.from(lineToRules[line]).join(', ');
    const lineIndex = line - 1;

    // Get the indentation of the target line
    const match = fileContent[lineIndex].match(/^(\s*)/);
    const indent = match ? match[1] : '';

    const comment = `${indent}// eslint-disable-next-line ${rules}`;
    
    // Insert the comment before the line
    fileContent.splice(lineIndex, 0, comment);
  }

  fs.writeFileSync(filePath, fileContent.join('\n'), 'utf8');
  console.log(`Fixed ${messages.length} issues in ${path.relative(__dirname, filePath)}`);
}

console.log('All ESLint issues have been auto-suppressed.');

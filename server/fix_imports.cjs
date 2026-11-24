const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'mastra', 'tools', 'executors');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));

for (const file of files) {
  const filePath = path.join(dir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  const newContent = content.replace(/import\s+(?:type\s+)?{\s*ToolContext\s*}\s+from\s+['"]\.\.\/index(?:\.js)?['"];/g, "import type { ToolContext } from '../toolRegistry.js';");
  if (newContent !== content) {
    fs.writeFileSync(filePath, newContent, 'utf8');
    console.log(`Updated ${file}`);
  }
}

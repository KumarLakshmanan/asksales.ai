const fs = require('fs');

function updateFile(path, hasVideo) {
  let content = fs.readFileSync(path, 'utf8');
  
  // Add RefreshCw to lucide-react import
  if (content.includes('lucide-react') && !content.includes('RefreshCw')) {
    content = content.replace(/import\s+\{([^}]+)\}\s+from\s+["']lucide-react["'];/, (match, p1) => {
      return `import { ${p1.trim()}, RefreshCw } from "lucide-react";`;
    });
  }

  // Update logic for EmailCard / AdCopyCard (which check !parsedContent.imageUrl)
  // SmsCard checks parsedContent.imagePrompt without !imageUrl in the same way, let's just replace the block.

  const patternGenerating = /const showImageGenerating = isGeneratingImage && parsedContent\.imagePrompt([^\n;]*);/g;
  
  if (hasVideo) {
    content = content.replace(
      /const showImageGenerating = isGeneratingImage && parsedContent\.imagePrompt([^;\n]*);\n\s*const showVideoGenerating = isGeneratingVideo && parsedContent\.videoPrompt([^;\n]*);\n\s*if \(!showImageGenerating && !showVideoGenerating\) return null;/g,
      `const showImageGenerating = isGeneratingImage && parsedContent.imagePrompt$1;
          const showVideoGenerating = isGeneratingVideo && parsedContent.videoPrompt$2;
          const showImageError = !isGeneratingImage && parsedContent.imagePrompt$1;
          const showVideoError = !isGeneratingVideo && parsedContent.videoPrompt$2;
          if (!showImageGenerating && !showVideoGenerating && !showImageError && !showVideoError) return null;`
    );

    // Now inject the UI. We look for `{showImageGenerating && (`
    content = content.replace(
      /\{showVideoGenerating && \([\s\S]*?<\/div>\s*\)\s*\}/,
      `$&
              {showImageError && onGenerateImage && (
                <div className="flex items-center justify-between gap-2 text-sm text-red-500 bg-red-50/50 p-2 rounded mt-2">
                  <span>Failed to generate image.</span>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); onGenerateImage(parsedContent.imagePrompt!); }}>
                    <RefreshCw className="w-3 h-3 mr-1" /> Retry
                  </Button>
                </div>
              )}
              {showVideoError && onGenerateVideo && (
                <div className="flex items-center justify-between gap-2 text-sm text-red-500 bg-red-50/50 p-2 rounded mt-2">
                  <span>Failed to generate video.</span>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); onGenerateVideo(parsedContent.videoPrompt!); }}>
                    <RefreshCw className="w-3 h-3 mr-1" /> Retry
                  </Button>
                </div>
              )}`
    );

  } else {
    // SMS card
    content = content.replace(
      /if \(isGeneratingImage && parsedContent\.imagePrompt\) \{/g,
      `const showImageGenerating = isGeneratingImage && parsedContent.imagePrompt;
          const showImageError = !isGeneratingImage && parsedContent.imagePrompt && !imageUrl;
          
          if (showImageGenerating || showImageError) {`
    );
    
    // Oh wait, SmsCard might be structured differently. Let's just do it manually with multi_replace_file_content!
  }

  fs.writeFileSync(path, content);
}

// I'll just use multi_replace for accuracy instead of this script.

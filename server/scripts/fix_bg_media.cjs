const fs = require('fs');

const path = 'server/controllers/contentStudioController.ts';
let code = fs.readFileSync(path, 'utf8');

// For Email
code = code.replace(
  /if \(imageUrl\) \{\s*const updatedContent = \{\s*\.\.\.emailContent,\s*imageUrl: imageUrl,\s*imageAssetId,\s*\};\s*await ContentAssetModel\.update\(savedAsset\.id, \{\s*imageUrl: imageUrl,\s*imageUrls: \[imageUrl\],\s*content: JSON\.stringify\(updatedContent\),\s*\}\);\s*const \{ webSocketEmitter \} = await import\('\.\.\/services\/agents\/WebSocketEmitter'\);\s*webSocketEmitter\.emit\(userId, 'content_asset_updated', \{\s*assetId: savedAsset\.id,\s*type: 'email',\s*imageUrl: imageUrl,\s*\}\);\s*logger\.info\(`\[ContentStudioController\] Email Asset \$\{savedAsset\.id\} updated with generated banner image`\);\s*\}/s,
  `if (imageUrl || emailContent.imagePrompt) {
          const updatedContent = {
            ...emailContent,
            imageUrl: imageUrl,
            imageAssetId,
          };
          
          await ContentAssetModel.update(savedAsset.id, {
            imageUrl: imageUrl || null,
            imageUrls: imageUrl ? [imageUrl] : [],
            content: JSON.stringify(updatedContent),
          });

          const { webSocketEmitter } = await import('../services/agents/WebSocketEmitter');
          webSocketEmitter.emit(userId, 'content_asset_updated', {
            assetId: savedAsset.id,
            type: 'email',
            imageUrl: imageUrl,
            error: (emailContent.imagePrompt && !imageUrl) ? 'Failed to generate image' : undefined,
          });
          logger.info(\`[ContentStudioController] Email Asset \${savedAsset.id} updated with generated banner image (or failed attempt)\`);
        }`
);

// For Social
code = code.replace(
  /if \(imageUrl \|\| videoUrl\) \{\s*const updatedContent = \{\s*\.\.\.socialContent,\s*imageUrl: imageUrl \|\| socialContent\.imageUrl,\s*videoUrl: videoUrl \|\| socialContent\.videoUrl,\s*imageAssetId,\s*videoAssetId,\s*\};\s*await ContentAssetModel\.update\(savedAsset\.id, \{\s*imageUrl: imageUrl \|\| null,\s*imageUrls: imageUrl \? \[imageUrl\] : \[\],\s*videoUrl: videoUrl \|\| null,\s*videoUrls: videoUrl \? \[videoUrl\] : \[\],\s*content: JSON\.stringify\(updatedContent\),\s*\}\);\s*const \{ webSocketEmitter \} = await import\('\.\.\/services\/agents\/WebSocketEmitter'\);\s*webSocketEmitter\.emit\(userId, 'content_asset_updated', \{\s*assetId: savedAsset\.id,\s*type: 'social_post',\s*imageUrl: imageUrl,\s*videoUrl: videoUrl,\s*\}\);\s*logger\.info\(`\[ContentStudioController\] Social post Asset \$\{savedAsset\.id\} updated with generated media`\);\s*\}/s,
  `if (imageUrl || videoUrl || socialContent.imagePrompt || socialContent.videoPrompt) {
          const updatedContent = {
            ...socialContent,
            imageUrl: imageUrl || socialContent.imageUrl,
            videoUrl: videoUrl || socialContent.videoUrl,
            imageAssetId,
            videoAssetId,
          };
          
          await ContentAssetModel.update(savedAsset.id, {
            imageUrl: imageUrl || null,
            imageUrls: imageUrl ? [imageUrl] : [],
            videoUrl: videoUrl || null,
            videoUrls: videoUrl ? [videoUrl] : [],
            content: JSON.stringify(updatedContent),
          });

          const { webSocketEmitter } = await import('../services/agents/WebSocketEmitter');
          webSocketEmitter.emit(userId, 'content_asset_updated', {
            assetId: savedAsset.id,
            type: 'social_post',
            imageUrl: imageUrl,
            videoUrl: videoUrl,
            error: ((socialContent.imagePrompt && !imageUrl) || (socialContent.videoPrompt && !videoUrl)) ? 'Failed to generate media' : undefined,
          });
          logger.info(\`[ContentStudioController] Social post Asset \${savedAsset.id} updated with generated media (or failed attempt)\`);
        }`
);

// For Social Message (DM)
code = code.replace(
  /if \(imageUrl \|\| videoUrl\) \{\s*const updatedContent = \{\s*\.\.\.messageContent,\s*imageUrl: imageUrl \|\| messageContent\.imageUrl,\s*videoUrl: videoUrl \|\| messageContent\.videoUrl,\s*imageAssetId,\s*videoAssetId,\s*\};\s*await ContentAssetModel\.update\(savedAsset\.id, \{\s*imageUrl: imageUrl \|\| null,\s*imageUrls: imageUrl \? \[imageUrl\] : \[\],\s*videoUrl: videoUrl \|\| null,\s*videoUrls: videoUrl \? \[videoUrl\] : \[\],\s*content: JSON\.stringify\(updatedContent\),\s*\}\);\s*const \{ webSocketEmitter \} = await import\('\.\.\/services\/agents\/WebSocketEmitter'\);\s*webSocketEmitter\.emit\(userId, 'content_asset_updated', \{\s*assetId: savedAsset\.id,\s*type: 'dm_post',\s*imageUrl: imageUrl,\s*videoUrl: videoUrl,\s*\}\);\s*logger\.info\(`\[ContentStudioController\] DM Asset \$\{savedAsset\.id\} updated with generated media`\);\s*\}/s,
  `if (imageUrl || videoUrl || messageContent.imagePrompt || messageContent.videoPrompt) {
          const updatedContent = {
            ...messageContent,
            imageUrl: imageUrl || messageContent.imageUrl,
            videoUrl: videoUrl || messageContent.videoUrl,
            imageAssetId,
            videoAssetId,
          };
          
          await ContentAssetModel.update(savedAsset.id, {
            imageUrl: imageUrl || null,
            imageUrls: imageUrl ? [imageUrl] : [],
            videoUrl: videoUrl || null,
            videoUrls: videoUrl ? [videoUrl] : [],
            content: JSON.stringify(updatedContent),
          });

          const { webSocketEmitter } = await import('../services/agents/WebSocketEmitter');
          webSocketEmitter.emit(userId, 'content_asset_updated', {
            assetId: savedAsset.id,
            type: 'dm_post',
            imageUrl: imageUrl,
            videoUrl: videoUrl,
            error: ((messageContent.imagePrompt && !imageUrl) || (messageContent.videoPrompt && !videoUrl)) ? 'Failed to generate media' : undefined,
          });
          logger.info(\`[ContentStudioController] DM Asset \${savedAsset.id} updated with generated media (or failed attempt)\`);
        }`
);

// For Ad Copy
code = code.replace(
  /if \(imageUrl \|\| videoUrl\) \{\s*const updatedContent = \{\s*\.\.\.adContent,\s*imageUrl: imageUrl \|\| adContent\.imageUrl,\s*videoUrl: videoUrl \|\| adContent\.videoUrl,\s*imageAssetId,\s*videoAssetId,\s*\};\s*await ContentAssetModel\.update\(savedAsset\.id, \{\s*imageUrl: imageUrl \|\| null,\s*imageUrls: imageUrl \? \[imageUrl\] : \[\],\s*videoUrl: videoUrl \|\| null,\s*videoUrls: videoUrl \? \[videoUrl\] : \[\],\s*content: JSON\.stringify\(updatedContent\),\s*\}\);\s*const \{ webSocketEmitter \} = await import\('\.\.\/services\/agents\/WebSocketEmitter'\);\s*webSocketEmitter\.emit\(userId, 'content_asset_updated', \{\s*assetId: savedAsset\.id,\s*type: 'ad_copy',\s*imageUrl: imageUrl,\s*videoUrl: videoUrl,\s*\}\);\s*logger\.info\(`\[ContentStudioController\] Ad copy Asset \$\{savedAsset\.id\} updated with generated media`\);\s*\}/s,
  `if (imageUrl || videoUrl || adContent.imagePrompt || adContent.videoPrompt) {
          const updatedContent = {
            ...adContent,
            imageUrl: imageUrl || adContent.imageUrl,
            videoUrl: videoUrl || adContent.videoUrl,
            imageAssetId,
            videoAssetId,
          };
          
          await ContentAssetModel.update(savedAsset.id, {
            imageUrl: imageUrl || null,
            imageUrls: imageUrl ? [imageUrl] : [],
            videoUrl: videoUrl || null,
            videoUrls: videoUrl ? [videoUrl] : [],
            content: JSON.stringify(updatedContent),
          });

          const { webSocketEmitter } = await import('../services/agents/WebSocketEmitter');
          webSocketEmitter.emit(userId, 'content_asset_updated', {
            assetId: savedAsset.id,
            type: 'ad_copy',
            imageUrl: imageUrl,
            videoUrl: videoUrl,
            error: ((adContent.imagePrompt && !imageUrl) || (adContent.videoPrompt && !videoUrl)) ? 'Failed to generate media' : undefined,
          });
          logger.info(\`[ContentStudioController] Ad copy Asset \${savedAsset.id} updated with generated media (or failed attempt)\`);
        }`
);

fs.writeFileSync(path, code);
console.log('Fixed media events!');

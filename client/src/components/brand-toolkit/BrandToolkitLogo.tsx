import { useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';

type BrandToolkitLogoProps = { src?: string | null; name?: string };

export function BrandToolkitLogo({ src, name }: BrandToolkitLogoProps) {
  // A different asset gets a fresh load attempt; unrelated card updates retain
  // the failed-image fallback without retries or changes to the saved URL.
  return <LogoImage key={src || 'missing'} src={src} name={name} />;
}

function LogoImage({ src, name }: BrandToolkitLogoProps) {
  const [failed, setFailed] = useState(false);
  const brandName = name?.trim() || 'Untitled Brand';
  if (!src?.trim() || failed) {
    const description = `${brandName} ${failed ? 'logo unavailable' : 'has no logo'}`;
    return (
      <div role="img" aria-label={description} title={description} className="flex max-w-[80%] flex-col items-center gap-2 text-muted-foreground">
        <div className="flex items-center justify-center w-16 h-16 rounded-xl bg-purple-100 dark:bg-purple-900/40 shadow-sm border border-purple-200/20">
          <ImageIcon className="h-8 w-8 text-purple-400" aria-hidden="true" />
        </div>
        <span className="text-xs">{failed ? 'Logo unavailable' : 'No logo'}</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={`${brandName} logo`}
      title={`${brandName} logo`}
      onError={() => setFailed(true)}
      className="max-h-20 max-w-[80%] object-contain rounded-lg p-2 shadow-sm bg-white dark:bg-zinc-900 border border-border/10"
    />
  );
}

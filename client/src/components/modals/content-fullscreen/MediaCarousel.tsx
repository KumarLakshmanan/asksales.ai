import { useState } from "react";
import { ChevronLeft, ChevronRight, Image, Video } from "lucide-react";
import type { MediaItem } from "./types";
import { normalizeUploadUrl } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

interface MediaCarouselProps {
  mediaItems: MediaItem[];
}

export default function MediaCarousel({ mediaItems }: MediaCarouselProps) {
  const [carouselIndex, setCarouselIndex] = useState(0);

  if (mediaItems.length === 0) return null;

  return (
    <div className="relative">
      <div className="aspect-video bg-gray-100 rounded-lg overflow-hidden relative">
        {mediaItems[carouselIndex]?.type === "image" && mediaItems[carouselIndex].url ? (
          <img
            src={normalizeUploadUrl(mediaItems[carouselIndex].url!)}
            alt="Content Media"
            className="w-full h-full object-contain"
          />
        ) : mediaItems[carouselIndex]?.type === "video" && mediaItems[carouselIndex].url ? (
          <video
            src={normalizeUploadUrl(mediaItems[carouselIndex].url!)}
            controls
            className="w-full h-full object-contain"
          />
        ) : mediaItems[carouselIndex]?.type === "image_placeholder" ? (
          <div className="w-full h-full relative bg-gradient-to-br from-purple-50 to-violet-50 flex items-center justify-center animate-pulse">
            <div className="flex flex-col items-center justify-center p-4 text-center">
              <div className="w-16 h-16 rounded-full bg-purple-100 flex items-center justify-center mb-3">
                <Spinner size="xl" label={null} className="text-purple-500" />
              </div>
              <p className="text-sm font-medium text-purple-700">Generating Image...</p>
              {mediaItems[carouselIndex].prompt && (
                <p className="text-xs text-purple-500 mt-1 line-clamp-3 max-w-md">{mediaItems[carouselIndex].prompt}</p>
              )}
            </div>
          </div>
        ) : (
          <div className="w-full h-full relative bg-gradient-to-br from-blue-50 to-cyan-50 flex items-center justify-center animate-pulse">
            <div className="flex flex-col items-center justify-center p-4 text-center">
              <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center mb-3">
                <Spinner size="xl" label={null} className="text-blue-500" />
              </div>
              <p className="text-sm font-medium text-blue-700">Generating Video...</p>
              {mediaItems[carouselIndex].prompt && (
                <p className="text-xs text-blue-500 mt-1 line-clamp-3 max-w-md">{mediaItems[carouselIndex].prompt}</p>
              )}
            </div>
          </div>
        )}

        {mediaItems.length > 1 && (
          <>
            <button
              onClick={() =>
                setCarouselIndex((prev) =>
                  prev === 0 ? mediaItems.length - 1 : prev - 1
                )
              }
              className="absolute left-2 top-1/2 -translate-y-1/2 p-2 bg-black/50 rounded-full text-white hover:bg-black/70 transition-colors"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() =>
                setCarouselIndex((prev) =>
                  prev === mediaItems.length - 1 ? 0 : prev + 1
                )
              }
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-black/50 rounded-full text-white hover:bg-black/70 transition-colors"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1.5">
              {mediaItems.map((item, idx) => (
                <button
                  key={idx}
                  onClick={() => setCarouselIndex(idx)}
                  className={`w-2.5 h-2.5 rounded-full transition-colors ${
                    idx === carouselIndex ? "bg-white" : "bg-white/50"
                  }`}
                />
              ))}
            </div>
            <div className="absolute top-2 right-2 flex gap-1">
              <span
                className={`px-2 py-0.5 rounded text-xs font-medium ${
                  mediaItems[carouselIndex]?.type === "image" || mediaItems[carouselIndex]?.type === "image_placeholder"
                    ? "bg-purple-500 text-white"
                    : "bg-violet-500 text-white"
                }`}
              >
                {mediaItems[carouselIndex]?.type === "image" || mediaItems[carouselIndex]?.type === "image_placeholder" ? (
                  <>
                    <Image className="w-3 h-3 inline mr-1"
 />
                    Image
                  </>
                ) : (
                  <>
                    <Video className="w-3 h-3 inline mr-1" />
                    Video
                  </>
                )}
              </span>
            </div>
            <div className="absolute top-2 left-2 bg-black/50 text-white text-xs px-2 py-1 rounded">
              {carouselIndex + 1} / {mediaItems.length}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

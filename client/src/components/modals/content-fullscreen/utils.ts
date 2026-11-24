// Helper function to strip HTML tags and convert to plain text
export const stripHtml = (html: string): string => {
  if (!html) return "";
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<\/div>/gi, "\n")
    .replace(/<div[^>]*>/gi, "")
    .replace(/<li>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/(ul|ol)>/gi, "\n")
    .replace(/<(ul|ol)[^>]*>/gi, "")
    .replace(/<strong>/gi, "")
    .replace(/<\/strong>/gi, "")
    .replace(/<em>/gi, "")
    .replace(/<\/em>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
};

// Helper function to safely format dates
export function formatDate(dateValue: string | number | undefined): string | null {
  if (!dateValue) return null;

  let date: Date;

  if (typeof dateValue === "string") {
    const numValue = Number(dateValue);
    if (!isNaN(numValue) && numValue > 1000000000000) {
      date = new Date(numValue);
    } else if (!isNaN(numValue) && numValue > 1000000000) {
      date = new Date(numValue * 1000);
    } else {
      date = new Date(dateValue);
    }
  } else if (typeof dateValue === "number") {
    date = dateValue > 1000000000000 ? new Date(dateValue) : new Date(dateValue * 1000);
  } else {
    return null;
  }

  if (isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Get status badge color
export const getStatusColor = (s: string | undefined) => {
  switch (s?.toLowerCase()) {
    case "active":
    case "sent":
    case "published":
      return "bg-green-100 text-green-800";
    case "pending":
    case "scheduled":
      return "bg-yellow-100 text-yellow-800";
    case "draft":
      return "bg-gray-100 text-gray-800";
    case "paused":
      return "bg-orange-100 text-orange-800";
    default:
      return "bg-blue-100 text-blue-800";
  }
};

// Get platform badge color
export const getPlatformColor = (p: string | undefined) => {
  switch (p?.toLowerCase()) {
    case "linkedin":
      return "bg-blue-600 text-white";
    case "twitter":
    case "x":
      return "bg-black text-white";
    case "instagram":
      return "bg-gradient-to-r from-purple-500 to-pink-500 text-white";
    case "facebook":
      return "bg-blue-500 text-white";
    case "meta":
      return "bg-blue-500 text-white";
    default:
      return "bg-gray-500 text-white";
  }
};

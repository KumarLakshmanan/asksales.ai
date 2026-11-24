"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function UserProfilePage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard/settings?tab=profile");
  }, [router]);

  return null;
}

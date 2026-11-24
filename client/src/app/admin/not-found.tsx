"use client";

import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function AdminNotFound() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-12 text-foreground">
      <Card className="w-full max-w-md border-border shadow-sm">
        <CardContent className="p-6 text-center sm:p-8">
          <span className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <FileQuestion className="h-7 w-7" aria-hidden="true" />
          </span>
          <p className="mb-2 text-sm font-medium text-primary">Error 404</p>
          <h1 className="text-2xl font-semibold tracking-tight">Admin page not found</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            This address may be outdated, or the page may have moved.
          </p>
          <Button asChild className="mt-6">
            <Link href="/admin/dashboard/home">Return to dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

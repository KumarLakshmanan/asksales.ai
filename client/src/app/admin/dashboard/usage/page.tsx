"use client";

import React from "react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Brain,
  Server,
  ShieldCheck,
  ArrowRight,
  BarChart3,
  Image,
  Video,
  Database,
} from "lucide-react";

interface UsageProvider {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  gradient: string;
  bgGradient: string;
  href: string;
}

const providers: UsageProvider[] = [
  {
    id: "llms",
    title: "LLMs",
    description:
      "Track usage across all LLM providers — OpenAI, OpenRouter, Gemini LLM, Custom API.",
    icon: Brain,
    gradient: "from-purple-500 to-purple-700",
    bgGradient: "from-purple-500/10 to-purple-700/10",
    href: "/admin/dashboard/usage/llms",
  },
  {
    id: "gemini-image",
    title: "Gemini Image",
    description:
      "Track AI image generation usage, requests, and costs via Google Gemini.",
    icon: Image,
    gradient: "from-pink-500 to-pink-700",
    bgGradient: "from-pink-500/10 to-pink-700/10",
    href: "/admin/dashboard/usage/gemini-image",
  },
  {
    id: "gemini-video",
    title: "Gemini Video",
    description:
      "Track AI video generation usage, requests, and costs via Google Gemini.",
    icon: Video,
    gradient: "from-indigo-500 to-indigo-700",
    bgGradient: "from-indigo-500/10 to-indigo-700/10",
    href: "/admin/dashboard/usage/gemini-video",
  },
  {
    id: "apify",
    title: "Apify",
    description:
      "View Apify actor runs, scraping credits, and compute unit consumption.",
    icon: Server,
    gradient: "from-emerald-500 to-emerald-700",
    bgGradient: "from-emerald-500/10 to-emerald-700/10",
    href: "/admin/dashboard/usage/apify",
  },
  {
    id: "zerobounce",
    title: "ZeroBounce",
    description:
      "Monitor email validation credits, verification results, and usage trends.",
    icon: ShieldCheck,
    gradient: "from-cyan-500 to-cyan-700",
    bgGradient: "from-cyan-500/10 to-cyan-700/10",
    href: "/admin/dashboard/usage/zerobounce",
  },
  {
    id: "embeddings",
    title: "Embeddings",
    description:
      "Track embedding provider calls, tokens, generated texts, estimated costs, and success rates.",
    icon: Database,
    gradient: "from-teal-500 to-cyan-700",
    bgGradient: "from-teal-500/10 to-cyan-700/10",
    href: "/admin/dashboard/usage/embeddings",
  },
  {
    id: "platform",
    title: "Platform Analytics",
    description:
      "Aggregated usage across all services — costs, trends, and provider comparison.",
    icon: BarChart3,
    gradient: "from-violet-500 to-violet-700",
    bgGradient: "from-violet-500/10 to-violet-700/10",
    href: "/admin/dashboard/usage/platform",
  },
];

const llmProviderReports = [
  {
    title: "OpenAI",
    description: "Model-level token, request, and cost reporting.",
    href: "/admin/dashboard/usage/openai",
  },
  {
    title: "Gemini LLM",
    description: "Dedicated Gemini language model usage reporting.",
    href: "/admin/dashboard/usage/gemini",
  },
  {
    title: "OpenRouter",
    description: "Requests and costs routed through OpenRouter.",
    href: "/admin/dashboard/usage/openrouter",
  },
];

export default function UsagePage() {
  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black tracking-tighter flex items-center gap-2">
          <BarChart3 className="h-8 w-8 text-purple-600" />
          Usage Overview
        </h1>
        <p className="text-muted-foreground mt-1">
          Monitor API usage and costs across all integrated providers
        </p>
      </div>

      {/* Provider Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {providers.map((provider) => (
          <Card
            key={provider.id}
            className={`relative overflow-hidden bg-gradient-to-br ${provider.bgGradient} border-0 hover:shadow-lg transition-shadow`}
          >
            <CardHeader>
              <div className="flex items-center justify-between">
                <div
                  className={`p-3 rounded-lg bg-gradient-to-br ${provider.gradient}`}
                >
                  <provider.icon className="h-6 w-6 text-white" />
                </div>
              </div>
              <CardTitle className="mt-4 text-xl">{provider.title}</CardTitle>
              <CardDescription className="text-muted-foreground">
                {provider.description}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link href={provider.href}>
                <Button
                  variant="outline"
                  className="w-full border-purple-200 hover:bg-purple-50 hover:text-purple-700 dark:border-purple-800 dark:hover:bg-purple-950 dark:hover:text-purple-300"
                >
                  View Details
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>

      <section className="space-y-3" aria-labelledby="llm-provider-reports">
        <div>
          <h2 id="llm-provider-reports" className="text-lg font-semibold">LLM provider reports</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Open a provider-specific report. The combined LLM report also supports provider filtering.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {llmProviderReports.map((report) => (
            <Card key={report.href} className="border-border/70 shadow-none">
              <CardContent className="flex h-full items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <h3 className="font-medium">{report.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{report.description}</p>
                </div>
                <Button asChild variant="outline" size="icon" className="shrink-0">
                  <Link href={report.href} aria-label={`Open ${report.title} usage report`}>
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}

"use client";

import { BarChart3, CheckCircle2, Facebook, Instagram, Link2, Plus, Youtube } from "lucide-react";
import { Button } from "@/components/ui/button";
import styles from "@/components/marketing/marketing.module.css";

export function SocialAccountSetup({ onConnect }: { onConnect: () => void }) {
  return <div className={styles.workspace}><div className={`${styles.setup} ${styles.setupHero}`}><div>
    <div className={styles.metricIcon}><BarChart3 aria-hidden="true" className="h-5 w-5"/></div>
    <h2 className="mt-5 text-xl font-semibold tracking-tight sm:text-2xl">Connect your social accounts</h2>
    <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Connect a Facebook Page, Instagram professional account, or YouTube channel to explore organic performance and published content.</p>
    <div className={styles.providers}>
      {[
        { title: "Facebook Page", detail: "Page insights and posts", icon: Facebook },
        { title: "Instagram professional", detail: "Account insights and content", icon: Instagram },
        { title: "YouTube channel", detail: "Channel performance", icon: Youtube },
      ].map(({ title, detail, icon: Icon }) => <div className={styles.provider} key={title}><Icon aria-hidden="true" className="h-6 w-6 shrink-0 text-primary"/><div><p className="text-sm font-semibold">{title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p></div></div>)}
    </div>
    <Button onClick={onConnect}><Plus aria-hidden="true" className="mr-2 h-4 w-4"/>Integrate accounts</Button>
    <p className="mt-3 text-xs leading-5 text-muted-foreground">Choose and connect an account in Integrations, then return here to sync its available evidence.</p>
    </div><aside className="space-y-3 rounded-xl bg-primary/[.025] p-5" aria-label="What Social Insights measures"><BarChart3 className="h-9 w-9 text-primary" aria-hidden="true"/><h3 className="text-sm font-semibold">Your organic performance, in one place</h3>{['Account reach, engagement and views', 'Published posts and content trends', 'Available audience and conversation evidence'].map(text => <p className="flex gap-2 text-xs leading-5 text-muted-foreground" key={text}><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true"/>{text}</p>)}</aside></div>
    <section className="rounded-xl border bg-card px-5 py-4"><h3 className="text-sm font-semibold">How it works</h3><ol className={styles.steps} aria-label="Social Insights setup">
      {[
        ["Connect account", "Review access with the provider."],
        ["Sync evidence", "Load the available organic measurements."],
        ["Explore insights", "Review trends, content and conversations."],
      ].map(([title, detail], index) => <li className={styles.step} key={title} aria-current={index === 0 ? "step" : undefined}><span className={styles.stepNumber}>{index + 1}</span><div><p className="text-sm font-semibold">{title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p></div></li>)}
    </ol></section>
    <section className="rounded-xl border bg-card px-5 py-4"><h3 className="text-sm font-semibold">Your connected accounts</h3><div className="flex flex-col items-center gap-2 py-6 text-center"><span className={styles.metricIcon}><Link2 className="h-5 w-5" aria-hidden="true"/></span><p className="text-sm font-medium">No social accounts connected yet</p><p className="max-w-lg text-xs text-muted-foreground">Connect a Facebook Page, Instagram professional account, or YouTube channel to load its available insights.</p></div></section>
  </div>;
}

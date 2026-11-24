import PublicLayout from "@/components/PublicLayout";
import Hero from "@/components/landing/Hero";
import LogoMarquee from "@/components/landing/LogoMarquee";
import MeetAgents from "@/components/landing/MeetAgents";
import Features from "@/components/landing/Features";
import CTA from "@/components/landing/CTA";

export default function Home() {
  return (
    <PublicLayout>
      <div>
        <Hero />
        <LogoMarquee />
        <MeetAgents />
        <Features />
        <CTA />
      </div>
    </PublicLayout>
  );
}

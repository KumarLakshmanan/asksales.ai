import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Rocket, Target, Globe, Zap, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface LeadConfigTabProps {
 initialConfig?: {
 keywords: string[];
 platforms: string[];
 leadCount: number;
 locations: string[];
 };
 onStartGeneration?: (config: {
 keywords: string[];
 platforms: string[];
 leadCount: number;
 locations: string[];
 }) => void;
 isProcessing?: boolean;
}

export default function LeadConfigTab({ 
 initialConfig = {
 keywords: [],
 platforms: ["linkedin", "google"],
 leadCount: 100,
 locations: []
 },
 onStartGeneration,
 isProcessing = false
}: LeadConfigTabProps) {
 const [config, setConfig] = useState(initialConfig);

 // Sync local state when initialConfig prop changes
 useEffect(() => {
   setConfig(initialConfig);
 }, [initialConfig]);

 return (
 <div className="h-full overflow-auto bg-background p-6 space-y-6">
 {/* Header */}
 <div className="border border-border/40 bg-card p-6 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-6 relative overflow-hidden shadow-sm">
 <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full -mr-16 -mt-16 blur-2xl opacity-50" />
 <div className="flex items-center gap-5 relative z-10">
 <div className="w-14 h-9 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20 shadow-sm">
 <Settings2 className="w-8 h-8 text-primary" />
 </div>
 <div>
 <div className="flex items-center gap-2.5 mb-1.5">
 <Badge variant="outline" className="text-xs px-2.5 py-0.5 border-primary/30 bg-primary/10 text-primary rounded-md">Lead Settings</Badge>
 <div className="w-1 h-1 rounded-full bg-primary/40" />
 </div>
 <h2 className="text-sm font-semibold">Generation Settings</h2>
 <p className="text-[9px] text-muted-foreground/40 font-semibold uppercase mt-1">
 Configure parameters for lead generation execution
 </p>
 </div>
 </div>
 </div>

 <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
 <div className="space-y-6">
 {/* Platforms Selection */}
 <div className="border border-border/40 bg-card p-6 rounded-xl shadow-sm">
 <div className="flex items-center gap-3 mb-5">
 <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20">
 <Globe className="h-4 w-4 text-primary" />
 </div>
 <p className="text-xs text-muted-foreground/60">Platforms</p>
 </div>
 
 <div className="flex flex-wrap gap-2">
 {["linkedin", "google", "facebook", "twitter", "instagram"].map((platform) => {
 const isActive = config.platforms.includes(platform);
 return (
 <button
 key={platform}
 onClick={() => {
 setConfig((prev) => ({
 ...prev,
 platforms: prev.platforms.includes(platform)
 ? prev.platforms.filter((p) => p !== platform)
 : [...prev.platforms, platform],
 }));
 }}
 className={cn(
 "px-4 py-2.5 rounded-xl text-[10px] font-semibold uppercase transition-all duration-300 border",
 isActive 
 ? "bg-primary text-primary-foreground border-primary shadow shadow-primary/20" 
 : "bg-background/20 text-muted-foreground/60 border-border/40 hover:bg-primary/5 hover:text-primary hover:border-primary/20"
 )}
 >
 {platform}
 </button>
 );
 })}
 </div>
 </div>

 {/* Keywords & Locations Summary */}
 <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
 <div className="border border-border/40 bg-card p-6 rounded-xl shadow-sm">
 <div className="flex items-center gap-3 mb-4">
 <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20">
 <Target className="h-3.5 w-3.5 text-primary" />
 </div>
 <p className="text-xs text-muted-foreground/60">Key Strings</p>
 </div>
 <p className="text-[11px] font-semibold text-foreground leading-tight">
 {config.keywords.length > 0 ? config.keywords.join(", ") : "No strings configured"}
 </p>
 </div>

 <div className="border border-border/40 bg-card p-6 rounded-xl shadow-sm">
 <div className="flex items-center gap-3 mb-4">
 <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20">
 <Globe className="h-3.5 w-3.5 text-primary" />
 </div>
 <p className="text-xs text-muted-foreground/60">Geo Domains</p>
 </div>
 <p className="text-[11px] font-semibold text-foreground leading-tight">
  {config.locations.length > 0 ? config.locations.join(", ") : "All Locations"}
 </p>
 </div>
 </div>
 </div>

 <div className="space-y-6">
 {/* Target Count Slider */}
 <div className="border border-border/40 bg-card p-6 rounded-xl shadow-sm">
 <div className="flex items-center justify-between mb-6">
 <div className="flex items-center gap-3">
 <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20">
 <Zap className="h-4 w-4 text-primary" />
 </div>
 <p className="text-xs text-muted-foreground/60">Target Lead Count</p>
 </div>
 <Badge variant="outline" className="h-7 px-3 rounded-lg border-primary/20 bg-primary/5 text-primary font-semibold text-sm">
 {config.leadCount} Leads
 </Badge>
 </div>
 
 <input
 type="range"
 min="50"
 max="1000"
 step="50"
 value={config.leadCount}
 onChange={(e) =>
 setConfig((prev) => ({ ...prev, leadCount: parseInt(e.target.value) }))
 }
 className="w-full h-1.5 bg-background/40 rounded-full appearance-none cursor-pointer accent-primary border border-border/40"
 />
 <div className="flex justify-between mt-3">
 <span className="text-[10px] font-semibold text-muted-foreground/30 uppercase">Low</span>
 <span className="text-[10px] font-semibold text-muted-foreground/30 uppercase">High</span>
 </div>
 </div>

 {/* Action Button */}
 <Button
 onClick={() => onStartGeneration?.(config)}
 disabled={isProcessing || config.platforms.length === 0}
 className="w-full h-16 rounded-xl bg-primary text-primary-foreground font-semibold text-base shadow-sm shadow-primary/5 transition-all group overflow-hidden relative"
 >
 <div className="flex items-center justify-center gap-3 relative z-10">
 <Rocket className="w-5 h-5 group-hover:rotate-12 transition-transform" />
 <span>Start Lead Generation</span>
 </div>
 </Button>
 </div>
 </div>
 </div>
 );
}

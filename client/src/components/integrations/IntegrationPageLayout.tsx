"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft, type LucideIcon } from "lucide-react";
import { motion, type Variants } from "framer-motion";
import { cn } from "@/lib/utils";
import { type ReactNode } from "react";

const containerVariants: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.4,
      staggerChildren: 0.05,
    },
  },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0 },
};

interface IntegrationPageLayoutProps {
  icon: LucideIcon;
  iconBgClass: string;
  iconShadowClass?: string;
  name: string;
  subtitle: string;
  statusHeader?: ReactNode;
  actions?: ReactNode;
  connections?: ReactNode;
  fullWidth?: ReactNode;
  disconnectDialog?: ReactNode;
  loading?: boolean;
  loadingMessage?: string;
  loadingIcon?: LucideIcon;
  loadingIconColor?: string;
  className?: string;
}

function LoadingState({
  icon: Icon,
  message,
  iconColor = "text-primary",
}: {
  icon?: LucideIcon;
  message: string;
  iconColor?: string;
}) {
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center space-y-4 px-4" role="status" aria-live="polite">
      <div className="relative">
        <div className="w-16 h-16 rounded-full border-4 border-primary/10 border-t-primary animate-spin" />
        {Icon && (
          <Icon
            className={cn(
              "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-6",
              iconColor
            )}
          />
        )}
      </div>
      <p className="text-sm font-medium text-muted-foreground">
        {message}
      </p>
    </div>
  );
}

export function IntegrationPageLayout({
  icon: Icon,
  iconBgClass,
  iconShadowClass,
  name,
  subtitle,
  statusHeader,
  actions,
  connections,
  fullWidth,
  disconnectDialog,
  loading,
  loadingMessage = "Loading integration...",
  loadingIcon,
  loadingIconColor,
  className,
}: IntegrationPageLayoutProps) {
  const router = useRouter();

  return (
    <>
      <motion.div
        variants={containerVariants}
        initial={fullWidth ? false : "hidden"}
        animate="visible"
        className={cn(
          "mx-auto w-full max-w-[1600px] space-y-8 px-4 py-6 sm:px-6 lg:px-8",
          className
        )}
      >
        {/* Header */}
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div className="space-y-3">
            {!fullWidth && <Button
              variant="ghost"
              size="sm"
              className="h-8 -ml-2 gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => router.push("/dashboard/integrations")}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              All Integrations
            </Button>}

            <div className="flex items-center gap-4">
              {!fullWidth && <div
                className={cn(
                  "w-10 h-10 rounded-xl flex items-center justify-center shadow-lg",
                  iconBgClass,
                  iconShadowClass
                )}
              >
                <Icon className="w-5 h-5 text-white" />
              </div>}
              <div>
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{name}</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {subtitle}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {!loading && !fullWidth && statusHeader}

            {!loading && !fullWidth && statusHeader && (
              <div className="h-6 w-px bg-border/40 hidden sm:block" />
            )}

            {actions && (
              <div className="flex items-center gap-2">{actions}</div>
            )}
          </div>
        </div>

        {/* Content */}
        {loading ? <LoadingState icon={loadingIcon} message={loadingMessage} iconColor={loadingIconColor} /> : fullWidth || (
          <div className="grid grid-cols-1 items-start gap-6">
            <motion.div variants={itemVariants} className="space-y-4">
              <h2 className="px-1 text-base font-semibold tracking-tight text-foreground">
                Connection setup
              </h2>
              <div className="max-w-5xl space-y-4">{connections}</div>
            </motion.div>
          </div>
        )}
      </motion.div>

      {disconnectDialog}
    </>
  );
}

export { itemVariants, containerVariants };

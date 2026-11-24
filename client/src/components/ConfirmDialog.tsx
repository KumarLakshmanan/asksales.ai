import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  variant?: "destructive" | "default";
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = "Update",
  cancelText = "Back",
  onConfirm,
  variant = "default",
}: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="top-1/2 bottom-auto max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-md overflow-y-auto overflow-x-hidden rounded-3xl border-none bg-card/60 p-6 shadow-[0_0_100px_rgba(0,0,0,0.4)] backdrop-blur-3xl sm:rounded-[3rem] sm:p-10">
        <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 blur-3xl rounded-full translate-x-1/2 -translate-y-1/2" />
        
        <AlertDialogHeader className="space-y-6 relative z-10">
          <div className="mx-auto flex items-center justify-center p-4 rounded-3xl bg-amber-500/10 border border-amber-500/20 text-amber-600 shadow-xl shadow-amber-500/5">
             <AlertTriangle className="h-10 w-10" />
          </div>
          <div className="space-y-2 text-center">
             <AlertDialogTitle className="text-2xl font-black tracking-tighter leading-none">{title}</AlertDialogTitle>
             <AlertDialogDescription className="text-base font-medium text-muted-foreground leading-relaxed px-4">
               {description}
             </AlertDialogDescription>
          </div>
        </AlertDialogHeader>

        <AlertDialogFooter className="mt-10 flex flex-col sm:flex-row gap-3 relative z-10 sm:justify-center">
          <AlertDialogCancel className="h-14 rounded-2xl bg-muted/40 border-none font-black text-xs uppercase tracking-widest hover:bg-muted active:scale-95 transition-all px-8">
            {cancelText}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={cn(
              "h-14 rounded-2xl font-black text-xs uppercase tracking-widest active:scale-95 transition-all px-10 shadow-xl",
              variant === "destructive" 
                ? "bg-rose-600 hover:bg-rose-700 text-white shadow-rose-600/20" 
                : "bg-primary hover:bg-primary/90 text-white shadow-primary/20"
            )}
          >
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>

      </AlertDialogContent>
    </AlertDialog>
  );
}

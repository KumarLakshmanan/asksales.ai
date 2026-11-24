"use client";

import { useRouter } from "next/navigation";
import {
  Facebook,
  Instagram,
  Mail,
  MessageCircle,
  MessageSquare,
  ArrowRight,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface CreateConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: number;
  contactName: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  leadId: number | null;
}
const channels = [
  {
    channel: "email",
    label: "Email",
    icon: Mail,
    description: "Personalized email from your sending account",
  },
  {
    channel: "whatsapp",
    label: "WhatsApp",
    icon: MessageCircle,
    description: "Approved templates and eligible replies",
  },
  {
    channel: "instagram",
    label: "Instagram",
    icon: Instagram,
    description: "Eligible conversations with your professional account",
  },
  {
    channel: "facebook",
    label: "Messenger",
    icon: Facebook,
    description: "Eligible conversations with your Facebook Page",
  },
  {
    channel: "sms",
    label: "SMS",
    icon: MessageSquare,
    description: "Personalized texts from your verified MSG91 sender",
  },
];

export function CreateConversationDialog({
  open,
  onOpenChange,
  contactId,
  contactName,
  leadId,
}: CreateConversationDialogProps) {
  const router = useRouter();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send outreach</DialogTitle>
          <DialogDescription>
            Choose a channel for {contactName}. The composer checks the account
            and recipient before sending.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {channels.map(({ channel, label, icon: Icon, description }) => (
            <Button
              key={channel}
              variant="outline"
              className="h-auto w-full justify-start gap-3 px-3 py-3"
              onClick={() => {
                router.push(
                  `/dashboard/outreach/create?channel=${channel}&contactId=${contactId}${leadId ? `&leadId=${leadId}` : ""}`,
                );
                onOpenChange(false);
              }}
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-sm font-medium">{label}</span>
                <span className="mt-1 block whitespace-normal text-xs font-normal text-muted-foreground">
                  {description}
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

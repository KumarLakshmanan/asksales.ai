/**
 * OutreachDeleteDialog - Shared delete conversation confirmation dialog
 */

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
import type { OutreachConversation } from "./types";

interface OutreachDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversation: OutreachConversation | null;
  onConfirm: () => void;
  itemLabel?: string;
}

export function OutreachDeleteDialog({
  open,
  onOpenChange,
  conversation,
  onConfirm,
  itemLabel = "Conversation",
}: OutreachDeleteDialogProps) {
  const leadIdentifier =
    conversation?.leadName ||
    conversation?.leadPhone ||
    conversation?.leadEmail ||
    conversation?.leadInstagram ||
    "Unknown";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {itemLabel}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete this {itemLabel.toLowerCase()} with{" "}
            <span className="font-medium">{leadIdentifier}</span>?
            This will permanently remove all messages and cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

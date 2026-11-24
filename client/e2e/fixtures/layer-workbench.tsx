"use client";

import { Button } from '@/components/ui/button';
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Sheet, SheetTrigger, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Drawer, DrawerTrigger, DrawerContent, DrawerTitle, DrawerDescription } from '@/components/ui/drawer';
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogCancel } from '@/components/ui/alert-dialog';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu';
import { Menubar, MenubarMenu, MenubarTrigger, MenubarContent, MenubarItem } from '@/components/ui/menubar';

// Mounted only by the disposable local browser harness, never a product route.
function FloatingControls() {
  return <div className="flex flex-col gap-3">
    <Select defaultValue="one"><SelectTrigger aria-label="Fixture choice"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="one">First choice</SelectItem><SelectItem value="two">Second choice</SelectItem></SelectContent></Select>
    <Popover><PopoverTrigger asChild><Button variant="outline">Fixture popover</Button></PopoverTrigger><PopoverContent><label>Popover input<input aria-label="Popover input" className="border bg-background" /></label></PopoverContent></Popover>
    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline">Fixture menu</Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>Local action</DropdownMenuItem><DropdownMenuSub><DropdownMenuSubTrigger>More choices</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuItem>Nested choice</DropdownMenuItem></DropdownMenuSubContent></DropdownMenuSub></DropdownMenuContent></DropdownMenu>
    <div className="overflow-hidden"><Tooltip delayDuration={0}><TooltipTrigger asChild><Button variant="outline">Fixture tooltip</Button></TooltipTrigger><TooltipContent>Unclipped tooltip</TooltipContent></Tooltip></div>
    <div className="overflow-hidden"><HoverCard openDelay={0}><HoverCardTrigger asChild><a href="#fixture" className="block rounded border p-2">Fixture hover card</a></HoverCardTrigger><HoverCardContent>Unclipped hover card</HoverCardContent></HoverCard></div>
    <ContextMenu><ContextMenuTrigger className="rounded border p-2">Fixture context menu</ContextMenuTrigger><ContextMenuContent><ContextMenuItem>Context choice</ContextMenuItem></ContextMenuContent></ContextMenu>
    <Menubar><MenubarMenu><MenubarTrigger>Fixture menubar</MenubarTrigger><MenubarContent><MenubarItem>Menubar choice</MenubarItem></MenubarContent></MenubarMenu></Menubar>
  </div>;
}

export default function LayerWorkbench() {
  return <div className="min-h-screen bg-background p-4 text-foreground">
    <h1>Local portal fixture</h1>
    <div className="fixed left-0 top-0 z-[var(--layer-navigation)] h-12 w-12 bg-sidebar" aria-hidden />
    <div className="mx-auto max-w-lg space-y-4">
      <FloatingControls />
      <Dialog><DialogTrigger asChild><Button>Fixture dialog</Button></DialogTrigger><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogTitle>Outer fixture dialog</DialogTitle><DialogDescription>Read-only local controls.</DialogDescription><FloatingControls />
        <Dialog><DialogTrigger asChild><Button>Nested fixture dialog</Button></DialogTrigger><DialogContent><DialogTitle>Inner fixture dialog</DialogTitle><DialogDescription>Second modal level.</DialogDescription><FloatingControls /></DialogContent></Dialog>
        <AlertDialog><AlertDialogTrigger asChild><Button>Nested fixture alert</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogTitle>Nested fixture alert</AlertDialogTitle><AlertDialogDescription>Safe cancellation only.</AlertDialogDescription><AlertDialogCancel>Cancel fixture alert</AlertDialogCancel></AlertDialogContent></AlertDialog>
      </DialogContent></Dialog>
      <Sheet><SheetTrigger asChild><Button>Fixture sheet</Button></SheetTrigger><SheetContent className="overflow-y-auto"><SheetTitle>Fixture sheet</SheetTitle><SheetDescription>Read-only local controls.</SheetDescription><FloatingControls /></SheetContent></Sheet>
      <Drawer><DrawerTrigger asChild><Button>Fixture drawer</Button></DrawerTrigger><DrawerContent className="max-h-[90dvh] overflow-y-auto"><DrawerTitle>Fixture drawer</DrawerTitle><DrawerDescription>Read-only local controls.</DrawerDescription><FloatingControls /></DrawerContent></Drawer>
    </div>
  </div>;
}

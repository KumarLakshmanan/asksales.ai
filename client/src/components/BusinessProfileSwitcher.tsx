"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Archive, ArchiveRestore, ArrowRight, Building2, Check, ChevronsUpDown, Pencil, Plus, Star, Trash2, Users, Mail, X } from "lucide-react";
import { ModalLayerScope, useModalLayerStyle } from "@/components/ui/layers";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { confirmUnsavedNavigation, restoreUnsavedNavigation } from "@/hooks/use-unsaved-changes";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { businessProfileName, useBusinessProfiles, type BusinessProfileSummary } from "@/hooks/use-business-profiles";
import { clearBusinessProfileSelection, openBusinessDashboard, selectBusinessProfile } from "@/lib/business-profile";
import api from "@/lib/api";

function ProfileMark({ profile }: { profile: BusinessProfileSummary | null }) {
  const label = profile ? businessProfileName(profile) : "Business profile";
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-sm font-semibold text-primary" aria-hidden="true">
      {profile ? label.charAt(0).toUpperCase() : <Building2 className="h-4 w-4" />}
    </span>
  );
}

export function BusinessProfileSwitcher() {
  const modalLayerStyle = useModalLayerStyle();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { user, setHasBusinessProfile } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [settingDefaultId, setSettingDefaultId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("recent");
  const [roleFilter, setRoleFilter] = useState("all");
  const [showArchived, setShowArchived] = useState(false);
  const [archivedProfiles, setArchivedProfiles] = useState<BusinessProfileSummary[]>([]);
  const [archivesLoading, setArchivesLoading] = useState(false);
  const [archiveId, setArchiveId] = useState<number | null>(null);
  const [archivingId, setArchivingId] = useState<number | null>(null);
  const [recent, setRecent] = useState<number[]>([]);
  const [favorites, setFavorites] = useState<number[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const { profiles, activeProfile, isLoading, isError, isSwitching, switchProfile, setDefaultProfile, refetch } = useBusinessProfiles();

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(`workspace-chooser:${user?.id}`) || "null");
      setRecent(Array.isArray(stored?.recent) ? stored.recent : []);
      setFavorites(Array.isArray(stored?.favorites) ? stored.favorites : []);
    } catch { setRecent([]); setFavorites([]); }
    setArchivedProfiles([]);
  }, [user?.id]);
  const savePreferences = (nextRecent: number[], nextFavorites = favorites) => {
    setRecent(nextRecent); setFavorites(nextFavorites);
    try { if (user?.id) localStorage.setItem(`workspace-chooser:${user.id}`, JSON.stringify({ recent: nextRecent, favorites: nextFavorites })); } catch { /* Chooser remains usable without storage. */ }
  };
  useEffect(() => {
    if (!open || !showArchived) return;
    let active = true;
    setArchivesLoading(true);
    api.get<BusinessProfileSummary[]>("/api/settings/business-profiles?includeArchived=1")
      .then(items => { if (active) setArchivedProfiles(items.filter(item => item.archivedAt)); })
      .catch(error => { if (active) setActionError(error instanceof Error ? error.message : "Archived profiles could not be loaded."); })
      .finally(() => { if (active) setArchivesLoading(false); });
    return () => { active = false; };
  }, [open, showArchived, user?.id]);
  const visibleProfiles = useMemo(() => [...profiles, ...(showArchived ? archivedProfiles : [])]
    .filter(profile => [businessProfileName(profile), profile.industry].join(" ").toLowerCase().includes(search.trim().toLowerCase()))
    .filter(profile => roleFilter === "all" || (roleFilter === "owner" ? profile.role === "owner" : profile.role !== "owner"))
    .sort((a, b) => {
      if (Boolean(a.archivedAt) !== Boolean(b.archivedAt)) return a.archivedAt ? 1 : -1;
      if (sort === "name") return businessProfileName(a).localeCompare(businessProfileName(b));
      if (sort === "newest") return Date.parse(b.createdAt || "") - Date.parse(a.createdAt || "") || b.id - a.id;
      if (favorites.includes(a.id) !== favorites.includes(b.id)) return favorites.includes(a.id) ? -1 : 1;
      const rank = (id: number) => recent.includes(id) ? recent.indexOf(id) : Number.MAX_SAFE_INTEGER;
      return rank(a.id) - rank(b.id) || Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) || businessProfileName(a).localeCompare(businessProfileName(b));
    }), [profiles, archivedProfiles, showArchived, search, roleFilter, sort, recent, favorites]);

  useEffect(() => {
    if (pathname !== "/dashboard/home" || searchParams.get("workspace") !== "choose") return;
    setOpen(true);
    const url = new URL(window.location.href);
    url.searchParams.delete("workspace");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [pathname, searchParams]);

  const navigate = (path: string) => {
    if (!confirmUnsavedNavigation()) return;
    setOpen(false);
    router.push(path);
  };

  const handleSelect = async (id: number) => {
    if (id !== activeProfile?.id && !confirmUnsavedNavigation("workspace")) return;
    savePreferences([id, ...recent.filter(item => item !== id)].slice(0, 20));
    if (id === activeProfile?.id) {
      setOpen(false);
      return;
    }
    try {
      await switchProfile(id);
    } catch (error) {
      restoreUnsavedNavigation();
      toast({
        title: "Could not switch business profile",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleSetDefault = async (id: number) => {
    setSettingDefaultId(id);
    setActionError(null);
    try {
      await setDefaultProfile(id);
      toast({ title: "Default business profile updated" });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not update the default profile.");
    } finally {
      setSettingDefaultId(null);
    }
  };

  const handleArchive = async (profile: BusinessProfileSummary, restore = false) => {
    if (profile.id === activeProfile?.id && !confirmUnsavedNavigation("workspace")) return;
    if (!restore && profiles.length <= 1) { setActionError("Add another active workspace before archiving this profile."); return; }
    setArchivingId(profile.id); setActionError(null);
    try {
      await api.post(`/api/settings/business-profiles/${profile.id}/${restore ? "restore" : "archive"}`, { expectedVersion: profile.version });
      setArchiveId(null);
      setArchivedProfiles(items => restore ? items.filter(item => item.id !== profile.id) : [...items.filter(item => item.id !== profile.id), { ...profile, archivedAt: new Date().toISOString(), version: (profile.version ?? 0) + 1 }]);
      if (!restore && activeProfile?.id === profile.id) {
        const remaining = profiles.filter(item => item.id !== profile.id);
        await queryClient.cancelQueries();
        if (remaining.length) selectBusinessProfile(remaining.find(item => item.isDefault)?.id ?? remaining[0].id);
        else { clearBusinessProfileSelection(); setHasBusinessProfile(false); }
        queryClient.clear(); setOpen(false);
        if (remaining.length) openBusinessDashboard(); else router.replace("/setup/business-profile");
      } else await queryClient.invalidateQueries({ queryKey: ["business-profiles", user?.id] });
      toast({ title: restore ? "Business profile restored" : "Business profile archived" });
    } catch (error) { restoreUnsavedNavigation(); setActionError(error instanceof Error ? error.message : "The profile could not be updated."); }
    finally { setArchivingId(null); }
  };

  const handleDelete = async (id: number) => {
    if (id === activeProfile?.id && !confirmUnsavedNavigation("workspace")) return;
    setDeletingId(id);
    setActionError(null);
    try {
      await api.delete(`/api/settings/business-profiles/${id}`);
      const remaining = profiles.filter(profile => profile.id !== id);
      await queryClient.cancelQueries({ queryKey: ["business-profiles", user?.id] });
      queryClient.setQueryData(["business-profiles", user?.id], remaining);
      setArchivedProfiles(current => current.filter(profile => profile.id !== id));
      savePreferences(recent.filter(profileId => profileId !== id), favorites.filter(profileId => profileId !== id));
      setDeleteId(null);
      if (remaining.length === 0) {
        clearBusinessProfileSelection();
        setHasBusinessProfile(false);
        setOpen(false);
        router.replace("/setup/business-profile");
      } else if (activeProfile?.id === id) {
        await queryClient.cancelQueries();
        selectBusinessProfile(remaining.find(profile => profile.isDefault)?.id ?? remaining[0].id);
        queryClient.clear();
        openBusinessDashboard();
      } else {
        await queryClient.invalidateQueries({ queryKey: ["business-profiles", user?.id] });
        toast({ title: "Business profile deleted" });
      }
    } catch (error) {
      restoreUnsavedNavigation();
      setActionError(error instanceof Error ? error.message : "Could not delete this profile.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={`Switch business profile. Current: ${activeProfile ? businessProfileName(activeProfile) : "none"}`}
          className="flex w-full min-w-0 items-center gap-2.5 rounded-xl border border-sidebar-border bg-sidebar-accent/70 px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ProfileMark profile={activeProfile} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-foreground">
              {isLoading ? "Loading profiles…" : activeProfile ? businessProfileName(activeProfile) : "Business profiles"}
            </span>
            <span className="block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Business profile</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </DialogPrimitive.Trigger>

      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-ui-layer="modal" style={modalLayerStyle} className="fixed inset-0 z-[var(--ui-layer)] bg-background" />
        <DialogPrimitive.Content data-ui-layer="modal" style={modalLayerStyle} className="fixed inset-0 z-[var(--ui-layer)] flex h-dvh w-screen flex-col overflow-y-auto bg-background text-foreground focus:outline-none">
        <ModalLayerScope>
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-10 pt-5 sm:px-8 sm:pt-8">
            <div className="flex items-start justify-between gap-6">
              <div className="min-w-0">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Building2 className="h-6 w-6" aria-hidden="true" />
                </div>
                <DialogPrimitive.Title className="text-2xl font-semibold tracking-tight sm:text-3xl">Choose a business profile</DialogPrimitive.Title>
                <DialogPrimitive.Description className="mt-2 text-sm text-muted-foreground">
                  Your business profile is your workspace. Open a business you own or have joined.
                </DialogPrimitive.Description>
              </div>
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon" aria-label="Close business chooser" className="h-10 w-10 shrink-0 rounded-full">
                  <X className="h-5 w-5" />
                </Button>
              </DialogPrimitive.Close>
            </div>

            <div className="mt-6 space-y-3">
              <SearchInput aria-label="Search business profiles" placeholder="Search by name or industry" value={search} onValueChange={setSearch} />
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <label className="flex items-center gap-2">Sort<select aria-label="Sort business profiles" value={sort} onChange={event => setSort(event.target.value)} className="rounded-lg border border-border bg-card p-2"><option value="recent">Favorites & recent</option><option value="name">Name</option><option value="newest">Newest</option></select></label>
                <label className="flex items-center gap-2">Access<select aria-label="Filter business profiles by access" value={roleFilter} onChange={event => setRoleFilter(event.target.value)} className="rounded-lg border border-border bg-card p-2"><option value="all">All</option><option value="owner">Owned by you</option><option value="joined">Joined</option></select></label>
                <label className="ml-auto flex items-center gap-2"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />Show archived</label>
              </div>
              <p className="text-xs text-muted-foreground" role="status">{visibleProfiles.length} {visibleProfiles.length === 1 ? "profile" : "profiles"}{archivesLoading ? " · Loading archived profiles…" : ""}</p>
            </div>
            <div className="mt-5 space-y-3">
              {actionError && <Callout tone="danger">{actionError}</Callout>}
              {isLoading ? (
                <LoadingState className="min-h-32" label="Loading business profiles" />
              ) : isError ? (
                <div role="alert" className="rounded-xl border border-border bg-card p-6 text-center">
                  <p className="text-sm text-muted-foreground">Your business profiles could not be loaded.</p>
                  <Button variant="outline" className="mt-4" onClick={() => void refetch()}>Try again</Button>
                </div>
              ) : profiles.length === 0 ? (
                <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">No business profiles yet. Add one to get started.</p>
              ) : visibleProfiles.length === 0 ? <p className="p-6 text-sm text-muted-foreground">No matching profiles. Try a different search or filter.</p> : visibleProfiles.map((profile) => {
                const name = businessProfileName(profile);
                const active = profile.id === activeProfile?.id;
                return (
                  <div key={profile.id} data-testid={`business-profile-${profile.id}`} className={`rounded-2xl border bg-card p-2 transition-colors sm:p-3 ${active ? "border-primary/45" : "border-border hover:border-primary/30"}`}>
                    <div className="flex items-center gap-2 sm:gap-3">
                    <button
                      type="button"
                      disabled={isSwitching || archivingId !== null || deletingId !== null || Boolean(profile.archivedAt)}
                      onClick={() => void handleSelect(profile.id)}
                      aria-label={`Open ${name} business profile`}
                      className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-xl p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:gap-4"
                    >
                      <ProfileMark profile={profile} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold sm:text-base">{name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{`${profile.role === "owner" ? "Owner" : profile.role === "billing_admin" ? "Billing admin" : "Staff member"}${active ? " · Current business" : ""}${profile.isDefault ? " · Default" : ""}`}</span>
                      </span>
                      {active ? <Check className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" /> : <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                    </button>
                    <Button variant="ghost" size="icon" aria-label={`${favorites.includes(profile.id) ? "Unfavorite" : "Favorite"} ${name}`} aria-pressed={favorites.includes(profile.id)} onClick={() => savePreferences(recent, favorites.includes(profile.id) ? favorites.filter(id => id !== profile.id) : [...favorites, profile.id])}><Star className={`h-4 w-4 ${favorites.includes(profile.id) ? "fill-primary text-primary" : "text-muted-foreground"}`} /></Button>
                    {profile.role === "owner" && !profile.archivedAt && <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => navigate(`/dashboard/business-profiles/${profile.id}`)}
                      aria-label={`Edit ${name}`}
                      className="h-9 shrink-0 gap-1.5 rounded-lg px-2.5 sm:px-3"
                    >
                      <Pencil className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Edit</span>
                    </Button>}
                    </div>
                    <p className="px-2 pb-1 text-xs text-muted-foreground">{profile.archivedAt ? "Archived · Restore to open this workspace" : profile.brandToolkitCompleted === false || profile.setupComplete === false ? "Setup incomplete · Continue in this workspace" : profile.brandToolkitCompleted === true || profile.setupComplete === true ? "Setup complete" : ""}{!profile.archivedAt && profile.ownerApproved === false ? " · Account review pending" : ""}</p>
                    {profile.role === "owner" && <div className="mt-2 flex flex-wrap items-center justify-end gap-2 border-t border-border/70 pt-2">
                      {!profile.archivedAt && !profile.isDefault && <Button type="button" variant="ghost" size="sm" disabled={settingDefaultId !== null || deletingId !== null} onClick={() => void handleSetDefault(profile.id)} className="gap-1.5 text-xs"><Star className="h-3.5 w-3.5" />{settingDefaultId === profile.id ? "Updating…" : "Make default"}</Button>}
                      {profile.archivedAt ? <Button type="button" variant="outline" size="sm" disabled={archivingId !== null} onClick={() => void handleArchive(profile, true)} className="gap-1.5 text-xs"><ArchiveRestore className="h-3.5 w-3.5" />{archivingId === profile.id ? "Restoring…" : "Restore"}</Button> : <Button type="button" variant="ghost" size="sm" disabled={archivingId !== null || profiles.length <= 1} title={profiles.length <= 1 ? "Add another workspace before archiving this one." : undefined} onClick={() => { setArchiveId(profile.id); setDeleteId(null); }} className="gap-1.5 text-xs"><Archive className="h-3.5 w-3.5" />Archive</Button>}
                      <Button type="button" variant="ghost" size="sm" disabled={deletingId !== null} onClick={() => { setDeleteId(profile.id); setActionError(null); }} className="gap-1.5 text-xs text-destructive hover:text-destructive"><Trash2 className="h-3.5 w-3.5" />Delete</Button>
                    </div>}
                    {profile.role === "owner" && !profile.archivedAt && profiles.length <= 1 && <p className="px-2 pt-2 text-xs text-muted-foreground">Add another workspace before archiving this one.</p>}
                    {archiveId === profile.id && <div className="mt-3 rounded-xl border border-border bg-muted/30 p-3" role="group" aria-label={`Archive ${name}`}><p className="text-sm font-medium">Archive {name}?</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Campaigns, content, and staff records are retained. This workspace will be unavailable until you restore it. To stop scheduled deliveries, pause the campaigns first. If this is your current workspace, you will switch to another available profile.</p><div className="mt-3 flex justify-end gap-2"><Button variant="outline" size="sm" disabled={archivingId !== null} onClick={() => setArchiveId(null)}>Cancel</Button><Button size="sm" disabled={archivingId !== null} onClick={() => void handleArchive(profile)}>{archivingId === profile.id ? "Archiving…" : "Archive profile"}</Button></div></div>}
                    {deleteId === profile.id && <div className="mt-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3" role="group" aria-label={`Delete ${name}`}>
                      <p className="text-sm font-medium">Delete {name}?</p>
                      <p className="mt-1 text-xs text-muted-foreground">This permanently removes the profile, its brand toolkit, setup drafts, and setup images. Linked campaigns, content, files, or customer records block deletion. Archive the profile to retain that data.</p>
                      <div className="mt-3 flex justify-end gap-2"><Button type="button" variant="outline" size="sm" disabled={deletingId !== null} onClick={() => setDeleteId(null)}>Cancel</Button><Button type="button" variant="destructive" size="sm" disabled={deletingId !== null} onClick={() => void handleDelete(profile.id)}>{deletingId === profile.id ? "Deleting…" : "Delete profile"}</Button></div>
                    </div>}
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() => navigate("/setup/business-profile/new")}
                className="flex min-h-16 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-border px-4 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/45 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus className="h-4 w-4" /> Add business profile
              </button>
            </div>
            <div className="mt-6 flex flex-wrap gap-5 border-t border-border pt-5">
              {activeProfile && <Button variant="ghost" className="gap-2" onClick={() => navigate('/dashboard/settings/team')}><Users className="h-4 w-4" aria-hidden />{activeProfile.role === 'owner' ? 'Manage staff' : 'View staff'}</Button>}
              <Button variant="ghost" className="gap-2" onClick={() => navigate('/dashboard/invitations')}><Mail className="h-4 w-4" aria-hidden />Your invitations</Button>
            </div>
          </div>
        </ModalLayerScope>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

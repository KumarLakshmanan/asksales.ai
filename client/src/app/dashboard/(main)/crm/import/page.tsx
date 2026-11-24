"use client";

import { useState, useCallback, useSyncExternalStore } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Upload, ArrowRight, AlertCircle, X,
  Database, DatabaseBackup, ShieldCheck, FileType,
  CheckCircle2, Settings2, Layers, UserCheck, Info, Sparkles, Copy
} from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from "@/components/ui/table";
import {creatorSessionScope} from '@/lib/creator-session';
import {subscribeBusinessProfile} from '@/lib/business-profile';
import {useCrmImportRecovery,type ImportResult} from '@/hooks/use-crm-import-recovery';
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { getMissingContactImportMappings, parseContactCSV } from "@/lib/contactImport";

const CONTACT_FIELDS = [
  { value: "skip", label: "-- Skip --" },
  { value: "firstName", label: "First Name" },
  { value: "lastName", label: "Last Name" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "company", label: "Company" },
  { value: "role", label: "Role" },
  { value: "status", label: "Status" },
  { value: "dealValue", label: "Deal Value" },
  { value: "notes", label: "Notes" },
  { value: "tags", label: "Tags" },
  { value: "linkedinUrl", label: "LinkedIn URL" },
  { value: "website", label: "Website" },
];

type AutoMappingInfo = { field: string; confidence: number };
export default function CRMImportPage() {
  const scope=useSyncExternalStore(subscribeBusinessProfile,creatorSessionScope,()=> 'anonymous');
  return <CRMImportWizard key={scope} scope={scope} />;
}
function CRMImportWizard({scope}:{scope:string}) {
  const { toast } = useToast();
  const router = useRouter();

  const [step, setStep] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [autoMappedFields, setAutoMappedFields] = useState<Record<string, AutoMappingInfo>>({});
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const recovery=useCrmImportRecovery(scope,result=>{setImportResult(result);setStep(3);toast({title:'Import completed',description:`${result.successCount} of ${result.totalRecords} records imported.`});});
  const importing=recovery.busy;
  const {verifyFile:verifyImportFile,run:runImport}=recovery;

  const autoMap = useCallback((headers: string[]) => {
    const mapping: Record<string, string> = {};
    const autoMapped: Record<string, AutoMappingInfo> = {};
    const usedFields = new Set<string>();
    const aliases: Record<string, string[]> = {
      firstName: ["first name", "firstname", "first_name", "given name", "name"],
      lastName: ["last name", "lastname", "last_name", "surname", "family name"],
      email: ["email", "e-mail", "email address", "emailaddress", "mail"],
      phone: ["phone", "telephone", "phone number", "mobile", "cell", "contact"],
      company: ["company", "organization", "org", "company name", "corporation"],
      role: ["job title", "title", "position", "role", "jobtitle", "job_title", "designation"],
      status: ["status", "stage", "pipeline stage", "lifecycle"],
      dealValue: ["deal value", "value", "amount", "dealvalue", "deal_value", "price"],
      notes: ["notes", "note", "description", "comments", "obs"],
      tags: ["tags", "tag", "labels", "categories", "keywords"],
      linkedinUrl: ["linkedin", "linkedin url", "linkedin_url", "linkedinurl", "profile"],
      website: ["website", "url", "web", "domain"],
    };
    for (const header of headers) {
      const lower = header.toLowerCase().trim();
      for (const [field, options] of Object.entries(aliases)) {
        const aliasIndex = options.indexOf(lower);
        if (aliasIndex !== -1 && !usedFields.has(field)) {
          mapping[header] = field;
          autoMapped[header] = { field, confidence: aliasIndex === 0 ? 100 : 95 };
          usedFields.add(field);
          break;
        }
      }
      if (!mapping[header]) mapping[header] = "skip";
    }
    return { mapping, autoMapped };
  }, []);

  const handleFile = useCallback(
    (selected: File) => {
      if (!selected.name.toLowerCase().endsWith(".csv")) {
        toast({ title: "Invalid file", description: "Please upload a .csv file", variant: "destructive" });
        return;
      }
      if (selected.size > 10 * 1024 * 1024) {
        toast({ title: "File too large", description: "Maximum file size is 10 MB", variant: "destructive" });
        return;
      }
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
        const { headers, rows } = parseContactCSV(String(event.target?.result || ""));
        setCsvHeaders(headers);
        setPreviewRows(rows);
        const automaticMapping = autoMap(headers);
        const savedMapping=await verifyImportFile(selected);
        if(creatorSessionScope()!==scope)return;
        setColumnMapping(savedMapping||automaticMapping.mapping);
        setAutoMappedFields(automaticMapping.autoMapped);
        setFile(selected);
        setStep(2);
        } catch (error) {
          if(creatorSessionScope()!==scope)return;
          toast({ title: "Invalid CSV", description: error instanceof Error ? error.message : "Check the CSV formatting.", variant: "destructive" });
        }
      };
      reader.onerror = () => toast({ title: "File could not be read", description: "Choose the file again.", variant: "destructive" });
      reader.readAsText(selected);
    },
    [toast, autoMap, verifyImportFile,scope]
  );

  const handleImport = useCallback(async () => {
    if (!file || importing) return;
    const missingRequired = getMissingContactImportMappings(columnMapping);
    if (missingRequired.length > 0) {
      toast({
        title: "Mandatory mappings missing",
        description: `Map ${missingRequired.map(({ label }) => label).join(", ")} before importing.`,
        variant: "destructive",
      });
      return;
    }
    await runImport(file,columnMapping);
  }, [file,columnMapping,importing,toast,runImport]);

  const mappedFieldCount = Object.values(columnMapping).filter((v) => v !== "skip").length;
  const missingRequiredMappings = getMissingContactImportMappings(columnMapping);
  const mappingProgress = csvHeaders.length ? Math.round((mappedFieldCount / csvHeaders.length) * 100) : 0;

  const steps = [
    { num: 1, label: "Upload", icon: Database },
    { num: 2, label: "Map Fields", icon: Settings2 },
    { num: 3, label: "Done", icon: ShieldCheck },
  ];

  return (
    <div className="p-5 space-y-5 max-w-screen-xl mx-auto">
      {/* Header */}
      <PageHeader icon={DatabaseBackup} title="Import Contacts" subtitle="Quick import: upload one CSV file with automatic field mapping. For Excel or several files, use Analyze Excel or multiple files." actions={<Button onClick={()=>router.push('/dashboard/crm/import/analyze')}>Analyze Excel or multiple files</Button>} />

      {(recovery.receipt||recovery.message)&&step!==3&&<div role="status" className="rounded-xl border border-amber-400/50 p-4 text-sm space-y-2">
        <p className="font-semibold">{recovery.operationLink ? 'Background import saved' : recovery.receipt?.importId?`Import #${recovery.receipt.importId}`:'Import response needs reconciliation'}</p>
        <p>{recovery.message}</p>
        {recovery.operationLink && <Button variant="outline" onClick={()=>router.push(recovery.operationLink!)}>View background import</Button>}
        {recovery.status&&<p>{recovery.status.processedRecords??0} of {recovery.status.totalRecords} row receipts committed · {recovery.status.successCount} imported.</p>}
        {recovery.receipt?.importId&&<Button variant="outline" size="sm" disabled={importing} onClick={()=>void recovery.check()}>Check saved import status</Button>}
        {!file&&recovery.receipt&&<p>Reselect the original CSV below. The original mapping is preserved; file contents are not stored in the browser.</p>}
      </div>}
      {/* Step Indicator */}
      <div className="flex items-center gap-0 max-w-sm">
        {steps.map((s, i) => (
          <div key={s.num} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <div className={cn(
                "w-7 h-7 rounded-lg flex items-center justify-center transition-all text-xs font-semibold",
                step > s.num ? "bg-emerald-500 text-white" :
                step === s.num ? "bg-primary text-white" :
                "bg-muted text-muted-foreground/40"
              )}>
                {step > s.num ? <CheckCircle2 className="h-3.5 w-3.5" /> : <s.icon className="h-3.5 w-3.5" />}
              </div>
              <span className={cn(
                "text-[10px] font-medium whitespace-nowrap",
                step >= s.num ? "text-foreground" : "text-muted-foreground/40"
              )}>
                {s.label}
              </span>
            </div>
            {i < 2 && (
              <div className="flex-1 h-px bg-border/40 mx-2 -mt-3 relative overflow-hidden">
                <motion.div
                  initial={{ width: "0%" }}
                  animate={{ width: step > i + 1 ? "100%" : "0%" }}
                  transition={{ duration: 0.5 }}
                  className="absolute inset-0 bg-emerald-500"
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {/* Step 1: Upload */}
        {step === 1 && (
          <motion.div key="step-1" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }} className="max-w-2xl">
            <Card className="border border-border/60 rounded-2xl shadow-sm">
              <CardHeader className="pb-3 pt-5 px-5">
                <CardTitle className="text-sm font-semibold">Upload CSV File</CardTitle>
                <CardDescription className="text-xs">
                  Upload your CSV file to start importing contacts. Columns are detected automatically.
                </CardDescription>
              </CardHeader>
              <CardContent className="px-5 pb-5 space-y-4">
                <label onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const dropped = event.dataTransfer.files[0]; if (dropped) handleFile(dropped); }} className="relative focus-within:ring-2 focus-within:ring-primary flex flex-col items-center justify-center border-2 border-dashed border-border/50 rounded-xl p-10 cursor-pointer hover:border-primary/40 hover:bg-primary/[0.02] transition-all text-center group">
                  <div className="w-12 h-12 rounded-xl bg-muted/50 flex items-center justify-center mb-3 group-hover:bg-primary/10 transition-colors">
                    <Upload className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                  </div>
                  <p className="text-sm font-medium mb-1">Drop a CSV here or choose a file</p>
                  <p className="text-xs text-muted-foreground">Maximum 10 MB · CSV format only</p>
                  <input type="file" aria-label="Upload CSV file" accept=".csv" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" onChange={(event) => { const selected = event.target.files?.[0]; if (selected) handleFile(selected); event.target.value = ""; }} />
                </label>

                <div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                      <FileType className="h-3.5 w-3.5 text-primary" /> Supported Fields
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {["First Name", "Last Name", "Email", "Phone", "Company", "Role", "Deal Value"].map((tag) => (
                        <Badge key={tag} variant="outline" className="text-[10px] font-medium px-2 py-0.5 rounded-md border-border/60">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Step 2: Map Fields */}
        {step === 2 && (
          <motion.div key="step-2" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }} className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Mapping */}
              <div className="lg:col-span-2">
                <Card className="border border-border/60 rounded-2xl shadow-sm">
                  <CardHeader className="pb-3 pt-5 px-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Settings2 className="h-4 w-4 text-primary" />
                        <div>
                          <CardTitle className="text-sm font-semibold">Map Columns</CardTitle>
                          <CardDescription className="text-xs">Match CSV columns to CRM fields</CardDescription>
                        </div>
                      </div>
                      <Badge variant="outline" className="text-xs border-border/60 gap-1.5">
                        <FileType className="h-3 w-3 opacity-50" />
                        {file?.name}
                      </Badge>
                    </div>
                    <div className="mt-3 space-y-1.5" aria-label={`${mappedFieldCount} of ${csvHeaders.length} fields mapped`}>
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium">Mapping progress</span>
                        <span className="text-muted-foreground">
                          {mappedFieldCount}/{csvHeaders.length} fields mapped
                          {csvHeaders.length - mappedFieldCount > 0 && ` · ${csvHeaders.length - mappedFieldCount} skipped`}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-all duration-300"
                          style={{ width: `${mappingProgress}%` }}
                        />
                      </div>
                      {Object.keys(autoMappedFields).length > 0 && (
                        <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Sparkles className="h-2.5 w-2.5 text-sky-500" />
                          Blue rows were auto-mapped; confidence shows the header-match quality.
                        </p>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="px-5 pb-5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {csvHeaders.map((header) => {
                        const autoMapping = autoMappedFields[header];
                        return (
                          <div key={header}
                            className={cn(
                              "flex items-center justify-between gap-2 p-2.5 rounded-lg border transition-colors",
                              autoMapping
                                ? "bg-sky-500/5 border-sky-500/25 hover:bg-sky-500/10"
                                : "bg-muted/30 border-border/30 hover:bg-muted/50",
                            )}>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wide leading-none">CSV</p>
                              {autoMapping && (
                                <Badge className="h-4 gap-1 border-sky-500/20 bg-sky-500/10 px-1.5 text-[9px] font-medium text-sky-700 shadow-none hover:bg-sky-500/10 dark:text-sky-300">
                                  <Sparkles className="h-2.5 w-2.5" /> Auto · {autoMapping.confidence}%
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs font-medium truncate">{header}</p>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <ArrowRight className="h-3 w-3 text-muted-foreground/40" />
                            <Select disabled={importing||!!recovery.receipt} value={columnMapping[header] || "skip"}
                              onValueChange={(val) => {
                                setColumnMapping((prev) => ({ ...prev, [header]: val }));
                                setAutoMappedFields((prev) => {
                                  const next = { ...prev };
                                  delete next[header];
                                  return next;
                                });
                              }}>
                              <SelectTrigger aria-label={`Map ${header}`} disabled={importing} className="h-7 w-36 text-xs rounded-lg border-border/60 focus:ring-1 focus:ring-primary/20">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="rounded-xl border-border/60 p-1">
                                {CONTACT_FIELDS.map((f) => (
                                  <SelectItem
                                    key={f.value}
                                    value={f.value}
                                    disabled={f.value !== "skip" && Object.entries(columnMapping).some(([mappedHeader, value]) => mappedHeader !== header && value === f.value)}
                                    className="text-xs rounded-lg"
                                  >
                                    {f.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          </div>
                        );
                      })}
                    </div>
                    {recovery.receipt&&<p className="text-xs text-muted-foreground">Previously saved rows remain in CRM.</p>}
                  </CardContent>
                </Card>
              </div>

              {/* Sidebar */}
              <div className="space-y-3">
                <Card className="border border-border/60 rounded-2xl shadow-sm bg-primary text-white overflow-hidden">
                  <CardContent className="p-5 space-y-4">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 bg-white/10 rounded-lg">
                        <DatabaseBackup className="w-4 h-4" />
                      </div>
                      <h3 className="text-sm font-semibold">Import Summary</h3>
                    </div>
                    <div className="space-y-2.5">
                      {[
                        { label: "Mapping Progress", value: `${mappedFieldCount}/${csvHeaders.length}` },
                        { label: "Total Columns", value: csvHeaders.length },
                      ].map((row) => (
                        <div key={row.label} className="flex items-center justify-between py-2 border-b border-white/10">
                          <span className="text-xs text-white/60">{row.label}</span>
                          <span className="text-base font-bold">{row.value}</span>
                        </div>
                      ))}
                      <div className="flex items-center justify-between py-2">
                        <span className="text-xs text-white/60">Status</span>
                        <Badge className={cn(
                          "border-none text-[10px]",
                          missingRequiredMappings.length === 0
                            ? "bg-emerald-500/20 text-emerald-300"
                            : "bg-amber-500/20 text-amber-200",
                        )}>
                          {missingRequiredMappings.length === 0 ? "Ready" : "Action required"}
                        </Badge>
                      </div>
                    </div>
                    {missingRequiredMappings.length > 0 && (
                      <div className="rounded-lg border border-amber-300/20 bg-amber-300/10 p-2.5 text-xs text-amber-100">
                        Mandatory: map {missingRequiredMappings.map(({ label }) => label).join(", ")}.
                      </div>
                    )}
                    <Button
                      className="w-full h-9 rounded-xl bg-white text-primary hover:bg-white/90 text-xs font-semibold"
                      onClick={handleImport}
                      loading={importing}
                      loadingText="Importing..."
                      disabled={missingRequiredMappings.length > 0}
                    >
                      <DatabaseBackup className="h-3.5 w-3.5 mr-2" />
                      {recovery.receipt ? "Reconcile same import" : "Import Contacts"}
                    </Button>
                  </CardContent>
                </Card>

                <Card className="border border-border/60 rounded-2xl shadow-sm">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <Info className="h-4 w-4 text-indigo-500" />
                      <h4 className="text-xs font-medium">Tips</h4>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Map <span className="font-medium text-foreground">Email or Phone</span>.
                      Company is optional. Phone numbers identify phone contacts; email identifies email-only contacts.
                      Existing phone contacts are reused. Invalid rows appear in the final summary.
                    </p>
                    <Button variant="ghost" size="sm"
                      className="w-full h-8 rounded-lg border border-border/40 text-xs justify-between"
                      disabled={importing} onClick={() => { setStep(1); setFile(null); recovery.clear(); }}>
                      {recovery.receipt ? "Start another import" : "Cancel Import"} <X className="w-3.5 h-3.5 opacity-50" />
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* Preview */}
            <Card className="border border-border/60 rounded-2xl shadow-sm">
              <CardHeader className="pb-3 pt-4 px-5">
                <CardTitle className="text-sm font-semibold">
                  Data Preview <span className="text-xs font-normal text-muted-foreground ml-1">({previewRows.length} rows)</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-5 pb-5">
                <div className="overflow-x-auto rounded-xl border border-border/40">
                  <Table>
                    <TableHeader className="bg-muted/30">
                      <TableRow className="hover:bg-transparent border-border/40">
                        {csvHeaders.map((h) => (
                          <TableHead key={h} className="text-[10px] font-semibold uppercase tracking-wide px-4 whitespace-nowrap h-9">
                            <div className="flex items-center gap-1.5">
                              {h}
                              {columnMapping[h] && columnMapping[h] !== "skip" && (
                                <Badge variant="outline" className="text-[9px] font-medium bg-emerald-500/10 border-emerald-500/20 text-emerald-600 px-1.5 py-0 rounded-md h-4">
                                  {columnMapping[h]}
                                </Badge>
                              )}
                            </div>
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewRows.map((row, i) => (
                        <TableRow key={i} className="hover:bg-muted/20 border-border/30 h-9">
                          {csvHeaders.map((h) => (
                            <TableCell key={h} className="text-xs py-2 px-4 max-w-[200px] truncate text-muted-foreground">
                              {row[h]}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Step 3: Results */}
        {step === 3 && importResult && (
          <motion.div key="step-3" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }}
            className="max-w-4xl mx-auto">
            <Card className="border border-border/60 rounded-2xl shadow-sm overflow-hidden">
              <div className={cn("h-1", importResult.errorCount > 0 || importResult.skippedCount > 0 || importResult.duplicateCount > 0 ? "bg-amber-500" : "bg-emerald-500")} />
              <CardContent className="p-8">
                <div className="text-center">
                  <div className={cn(
                    "w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-5",
                    importResult.errorCount > 0 || importResult.skippedCount > 0 || importResult.duplicateCount > 0 ? "bg-amber-500" : "bg-emerald-500",
                  )}>
                    {importResult.errorCount > 0 || importResult.skippedCount > 0 || importResult.duplicateCount > 0
                      ? <AlertCircle className="h-7 w-7 text-white" />
                      : <CheckCircle2 className="h-7 w-7 text-white" />}
                  </div>
                  <h2 className="text-base font-semibold mb-1">Import Complete</h2>
                  <p className="text-xs text-muted-foreground mb-6">
                    {importResult.successCount} of {importResult.totalRecords} records were imported successfully.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 mb-6">
                  {[
                    { label: "Total", value: importResult.totalRecords, color: "text-slate-600 dark:text-slate-300", bg: "bg-slate-500/10", icon: Layers },
                    { label: "Imported", value: importResult.successCount, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/10", icon: UserCheck },
                    { label: "Duplicates", value: importResult.duplicateCount, color: "text-sky-600 dark:text-sky-400", bg: "bg-sky-500/10", icon: Copy },
                    { label: "Skipped", value: importResult.skippedCount, color: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10", icon: Layers },
                    { label: "Errors", value: importResult.errorCount, color: "text-rose-600 dark:text-rose-400", bg: "bg-rose-500/10", icon: AlertCircle },
                  ].map((res) => (
                    <div key={res.label} className={cn("p-3 rounded-xl text-center", res.bg)}>
                      <res.icon className={cn("h-4 w-4 mx-auto mb-1.5", res.color)} />
                      <p className={cn("text-2xl font-bold", res.color)}>{res.value}</p>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{res.label}</p>
                    </div>
                  ))}
                </div>

                {importResult.issues.length > 0 && (
                  <div className="mb-5 overflow-hidden rounded-xl border border-border/60 text-left">
                    <div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-4 py-3">
                      <div>
                        <h3 className="text-xs font-semibold">Errors and warnings</h3>
                        <p className="text-[11px] text-muted-foreground">Review every duplicate, skipped row, validation error, and warning.</p>
                      </div>
                      <Badge variant="outline" className="text-[10px]">{importResult.issues.length} issue{importResult.issues.length !== 1 ? "s" : ""}</Badge>
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/20 hover:bg-muted/20">
                            <TableHead className="h-8 w-20 px-4 text-[10px] uppercase">Row</TableHead>
                            <TableHead className="h-8 w-28 px-4 text-[10px] uppercase">Type</TableHead>
                            <TableHead className="h-8 px-4 text-[10px] uppercase">Details</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {importResult.issues.map((issue, index) => (
                            <TableRow key={`${issue.row}-${issue.type}-${index}`} className="hover:bg-muted/20">
                              <TableCell className="px-4 py-2 text-xs font-medium">{issue.row}</TableCell>
                              <TableCell className="px-4 py-2">
                                <Badge variant="outline" className={cn(
                                  "text-[9px] capitalize",
                                  issue.type === "error" && "border-rose-500/30 bg-rose-500/10 text-rose-600",
                                  issue.type === "skipped" && "border-amber-500/30 bg-amber-500/10 text-amber-600",
                                  issue.type === "duplicate" && "border-sky-500/30 bg-sky-500/10 text-sky-600",
                                  issue.type === "warning" && "border-indigo-500/30 bg-indigo-500/10 text-indigo-600",
                                )}>{issue.type}</Badge>
                              </TableCell>
                              <TableCell className="px-4 py-2 text-xs text-muted-foreground">{issue.message}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}

                <div className="flex items-start gap-2.5 p-3 rounded-xl bg-indigo-500/5 border border-indigo-500/15 text-left mb-4">
                  <Info className="h-4 w-4 text-indigo-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground">
                    {importResult.successCount} contact record{importResult.successCount !== 1 ? 's' : ''} imported into your CRM. Existing contacts matched by phone are reused.
                    {importResult.warningCount > 0 && ` ${importResult.warningCount} imported record${importResult.warningCount !== 1 ? "s have" : " has"} warnings shown above.`}
                  </p>
                </div>

                <div className="flex gap-2">
                  <Button className="flex-1 h-9 rounded-xl text-xs gap-1.5" onClick={() => router.push("/dashboard/crm/contacts")}>
                    View Contacts <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="outline" className="flex-1 h-9 rounded-xl text-xs border-border/60"
                    onClick={() => {
                      setStep(1); setFile(null); setCsvHeaders([]);
                      setPreviewRows([]); setColumnMapping({}); setAutoMappedFields({}); setImportResult(null); recovery.clear();
                    }}>
                    Import Another
                  </Button>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

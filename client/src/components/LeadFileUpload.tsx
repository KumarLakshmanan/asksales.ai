import { useState, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Callout } from '@/components/ui/callout';
import { Spinner } from '@/components/ui/spinner';
import { Upload, FileSpreadsheet, CheckCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api';

interface UploadedLead {
  first_name?: string;
  firstName?: string;
  last_name?: string;
  lastName?: string;
  email?: string;
  company?: string;
  role?: string;
  job_title?: string;
  phone?: string;
  [key: string]: string | undefined;
}

interface LeadFileUploadProps {
  onUploadComplete?: (leads: UploadedLead[]) => void;
}

export default function LeadFileUpload({ onUploadComplete }: LeadFileUploadProps) {
  const { toast } = useToast();
  const [isDragging, setIsDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadedLeads, setUploadedLeads] = useState<UploadedLead[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const validateFile = useCallback((file: File): boolean => {
    // Check file type
    const allowedTypes = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    const allowedExtensions = ['.csv', '.xls', '.xlsx'];
    
    const fileExtension = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
    const isValidType = allowedTypes.includes(file.type) || allowedExtensions.includes(fileExtension);
    
    if (!isValidType) {
      toast({
        title: 'Invalid File Type',
        description: 'Please upload a CSV or Excel file (.csv, .xls, .xlsx)',
        variant: 'destructive',
      });
      return false;
    }

    // Check file size (10MB limit)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      toast({
        title: 'File Too Large',
        description: 'File size must be less than 10MB',
        variant: 'destructive',
      });
      return false;
    }

    return true;
  }, [toast]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile && validateFile(droppedFile)) {
      setFile(droppedFile);
      setUploadError(null);
    }
  }, [validateFile]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && validateFile(selectedFile)) {
      setFile(selectedFile);
      setUploadError(null);
    }
  };

  const handleUpload = async () => {
    if (!file) return;

    setUploading(true);
    setUploadError(null);

    try {
      const formData = new FormData();
      formData.append('leads_file', file);

      interface UploadResponse {
        success: boolean;
        leads?: UploadedLead[];
        leads_count?: number;
        imported_count?: number;
        duplicate_count?: number;
        message?: string;
      }

      const data = await api.postForm<UploadResponse>('/api/outreach/leads/upload-file', formData);

      if (data.success) {
        setUploadedLeads(data.leads || []);
        onUploadComplete?.(data.leads || []);
        
        toast({
          title: 'Upload Successful!',
          description: `Imported ${data.imported_count || 0} new lead${data.imported_count === 1 ? '' : 's'}${data.duplicate_count ? `; ${data.duplicate_count} duplicate${data.duplicate_count === 1 ? '' : 's'} reused` : ''}.`,
        });
      } else {
        throw new Error(data.message || 'Upload failed');
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to upload file';
      setUploadError(errorMessage);
      toast({
        title: 'Upload Failed',
        description: errorMessage,
        variant: 'destructive',
      });
    } finally {
      setUploading(false);
    }
  };

  const handleReset = () => {
    setFile(null);
    setUploadedLeads([]);
    setUploadError(null);
  };

  return (
    <Card className="w-full rounded-xl border border-border/40 bg-card/30 backdrop-blur-xl shadow-sm">
      <CardHeader className="p-5 border-b border-border/40">
        <CardTitle className="text-[10px] font-black uppercase tracking-widest flex items-center gap-2 text-muted-foreground/60">
          <FileSpreadsheet className="h-3.5 w-3.5 text-primary" />
          Upload Lead File
        </CardTitle>
        <CardDescription className="text-[11px] font-medium text-muted-foreground/50 mt-1">
          Supported: CSV, Excel (.csv, .xls, .xlsx) | Limit: 10MB
        </CardDescription>
      </CardHeader>
      <CardContent className="p-5 space-y-4">
        {!file && (
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`
              border border-dashed rounded-xl p-8 text-center cursor-pointer
              transition-all duration-300
              ${isDragging 
                ? 'border-primary bg-primary/10 scale-[0.99]' 
                : 'border-border/40 hover:border-primary/40 hover:bg-primary/5'
              }
            `}
          >
            <input
              type="file"
              id="file-upload"
              className="sr-only"
              accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={handleFileSelect}
            />
            <label htmlFor="file-upload" className="cursor-pointer">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary mx-auto mb-4 border border-primary/20">
                <Upload className="h-5 w-5" />
              </div>
              <p className="text-xs font-black uppercase tracking-widest mb-1.5">
                Drop your file here or click to browse
              </p>
              <p className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60">
                Supported formats: CSV, Excel (.csv, .xls, .xlsx)
              </p>
            </label>
          </div>
        )}

        {file && !uploading && uploadedLeads.length === 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between p-3 border border-border/40 rounded-xl bg-background/50">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                  <FileSpreadsheet className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-bold truncate max-w-[200px]">{file.name}</p>
                  <p className="text-[10px] font-medium text-muted-foreground">
                    {(file.size / 1024).toFixed(2)} KB
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  onClick={handleReset}
                  className="h-8 text-[9px] font-black uppercase tracking-widest px-3 rounded-lg hover:bg-destructive/10 hover:text-destructive"
                >
                  Remove
                </Button>
                <Button
                  onClick={handleUpload}
                  className="h-8 text-[9px] font-black uppercase tracking-widest px-4 rounded-lg bg-primary text-white shadow-lg shadow-primary/10"
                >
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                  Upload
                </Button>
              </div>
            </div>

            {uploadError && (
              <Callout tone="danger">
                <p>{uploadError}</p>
              </Callout>
            )}
          </div>
        )}

        {uploading && (
          <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-4" role="status" aria-live="polite">
            <Spinner size="md" label={null} className="text-primary" />
            <div>
              <p className="text-sm font-medium">Importing {file?.name}…</p>
              <p className="text-xs text-muted-foreground">Validating rows, removing duplicates, and saving usable leads.</p>
            </div>
          </div>
        )}

        {uploadedLeads.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900 rounded-lg">
              <div className="flex items-center gap-3">
                <CheckCircle className="h-6 w-6 text-green-600" />
                <div>
                  <p className="font-medium text-green-900 dark:text-green-100">
                    Upload Successful!
                  </p>
                  <p className="text-sm text-green-700 dark:text-green-300">
                    Processed {uploadedLeads.length} leads
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleReset}
              >
                Upload Another
              </Button>
            </div>

            <div>
              <h4 className="font-medium mb-2">Lead Preview (First 10 rows)</h4>
              <ScrollArea className="h-96 rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[50px]">#</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Company</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Phone</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {uploadedLeads.slice(0, 10).map((lead, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="font-medium">{idx + 1}</TableCell>
                        <TableCell>
                          {lead.first_name || lead.firstName || ''} {lead.last_name || lead.lastName || ''}
                        </TableCell>
                        <TableCell className="text-sm">
                          {lead.email || 'N/A'}
                        </TableCell>
                        <TableCell>{lead.company || 'N/A'}</TableCell>
                        <TableCell className="text-sm">
                          {lead.role || lead.job_title || 'N/A'}
                        </TableCell>
                        <TableCell className="text-sm">
                          {lead.phone || 'N/A'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
              {uploadedLeads.length > 10 && (
                <p className="text-sm text-muted-foreground mt-2">
                  + {uploadedLeads.length - 10} more leads
                </p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

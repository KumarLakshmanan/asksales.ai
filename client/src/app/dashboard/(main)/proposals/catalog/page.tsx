"use client";
import { useCallback, useEffect, useState } from "react";
import { Info, Package } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ProposalPageHeader } from "@/components/proposals/ProposalPageHeader";
import styles from "@/components/proposals/proposals.module.css";

type Item = { id?: number; name: string; description: string; currency: string; unitPrice: number; unit: string; active: boolean };
const empty: Item = { name: "", description: "", currency: "USD", unitPrice: 0, unit: "unit", active: true };

export default function ProposalCatalog() {
  const [items, setItems] = useState<Item[]>([]), [form, setForm] = useState<Item>({...empty}), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setItems(await api.get("/api/proposals/catalog")); }
    catch(e) { setError(e instanceof Error ? e.message : "Unable to load catalog"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <div className={`page-shell ${styles.workspace}`}>
    <ProposalPageHeader back title="Products and services" description="Approved pricing for manual and AI proposals."/>
    <div className={styles.notice}><Info aria-hidden="true"/><p>Retiring an item preserves existing proposals.</p></div>
    <div className={styles.catalogGrid}>
      <form className={`${styles.panel} ${styles.catalogForm}`} onSubmit={async event=>{
        event.preventDefault(); setBusy(true); setError("");
        try {
          const {id,...payload}=form;
          if(id) await api.put(`/api/proposals/catalog/${id}`,payload);
          else await api.post("/api/proposals/catalog",payload);
          setForm({...empty}); await load();
        } catch(e) { setError(e instanceof Error ? e.message : "Unable to save item"); }
        finally { setBusy(false); }
      }}>
        <h2 className={styles.panelTitle}>{form.id ? "Edit item" : "Add item"}</h2>
        <div className={styles.field}>
          <Label htmlFor="catalog-name">Name <span aria-hidden="true" className="text-destructive">*</span></Label>
          <Input id="catalog-name" aria-label="Name" required value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/>
        </div>
        <div className={styles.field}>
          <Label htmlFor="catalog-currency">Currency <span aria-hidden="true" className="text-destructive">*</span></Label>
          <Input id="catalog-currency" aria-label="Currency" required maxLength={3} pattern="[A-Z]{3}" aria-describedby="catalog-currency-help" value={form.currency} onChange={e=>setForm({...form,currency:e.target.value.toUpperCase()})}/>
          <p id="catalog-currency-help" className={styles.fieldHelp}>3 uppercase letters</p>
        </div>
        <div className={styles.fieldPair}>
          <div className={styles.field}>
            <Label htmlFor="catalog-price">Unit price <span aria-hidden="true" className="text-destructive">*</span></Label>
            <Input id="catalog-price" aria-label="Unit price" required type="number" min="0" step="0.01" aria-describedby="catalog-price-help" value={form.unitPrice} onChange={e=>setForm({...form,unitPrice:Number(e.target.value)})}/>
            <p id="catalog-price-help" className={styles.fieldHelp}>Minimum 0 · increments of 0.01</p>
          </div>
          <div className={styles.field}>
            <Label htmlFor="catalog-unit">Unit <span aria-hidden="true" className="text-destructive">*</span></Label>
            <Input id="catalog-unit" aria-label="Unit" required value={form.unit} onChange={e=>setForm({...form,unit:e.target.value})}/>
          </div>
        </div>
        <div className={styles.field}>
          <Label htmlFor="catalog-description">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Textarea id="catalog-description" rows={3} value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/>
        </div>
        <div>
          <label className="flex min-h-10 items-center gap-3 text-sm"><input type="checkbox" className="h-4 w-4 accent-primary" checked={form.active} onChange={e=>setForm({...form,active:e.target.checked})}/>Available for new proposals</label>
          <p className={`ml-7 ${styles.fieldHelp}`}>Retired items are excluded from new proposals. Existing proposals keep their current items.</p>
        </div>
        {error&&<Callout tone="danger">{error}</Callout>}
        <div className={styles.actions}>
          <Button loading={busy} loadingText="Saving item…" type="submit">Save item</Button>
          {form.id&&<Button type="button" variant="outline" onClick={()=>setForm({...empty})}>Cancel</Button>}
        </div>
      </form>
      <section aria-label="Catalog items" className={`${styles.panel} ${styles.catalogList}`}>
        <h2 className={styles.panelTitle}>Items</h2>
        {items.length>0?<div className={styles.tableWrap}><table className={`${styles.table} min-w-[460px]`} aria-label="Products and services"><thead><tr><th scope="col">Item</th><th scope="col">Unit price</th><th scope="col">Status</th><th scope="col" className="text-right">Actions</th></tr></thead><tbody>
          {items.map(item=><tr key={item.id} data-selected={form.id===item.id}>
            <td className="font-medium">{item.name}</td>
            <td className="whitespace-nowrap tabular-nums">{item.currency} {item.unitPrice.toFixed(2)} <span className="text-xs text-muted-foreground">per {item.unit}</span></td>
            <td><span className={styles.status} data-active={item.active}>{item.active?"Active":"Retired"}</span></td>
            <td className="text-right"><Button variant="outline" size="sm" onClick={()=>setForm(item)}>Edit<span className="sr-only"> {item.name}</span></Button></td>
          </tr>)}
        </tbody></table></div>:<div className="flex min-h-64 flex-col items-center justify-center gap-4 text-center"><span className={styles.emptyIcon}><Package aria-hidden="true" className="h-6 w-6"/></span><p className="text-sm text-muted-foreground">Add your first approved product or service.</p></div>}
      </section>
    </div>
  </div>;
}

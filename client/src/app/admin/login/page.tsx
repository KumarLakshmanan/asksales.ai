"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff } from "lucide-react";
import { useAdminAuth } from "@/contexts/AdminAuthContext";
import { api, ApiError } from "@/lib/admin-api";
import { AdminAuthShell } from "@/components/admin/AdminAuthShell";

export default function Login() {
  const router = useRouter();
  const { toast } = useToast();
  const { login, isAuthenticated } = useAdminAuth();
  const [formData, setFormData] = useState({ email: "", password: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (isAuthenticated) router.push("/admin/dashboard/home");
  }, [isAuthenticated, router]);

  // Bootstrap CSRF token on mount
  useEffect(() => {
    void api.get("/api/auth/csrf-token", { skipAuth: true }).catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const data = await api.post<{ admin: { id: number; email: string; name: string; role: string } }>("/api/admin/login", formData, { skipAuth: true });
      login(data.admin);
      toast({ title: "Login Successful!", description: "Welcome to Admin Panel" });
      router.push("/admin/dashboard/home");
    } catch (error) {
      if (error instanceof ApiError) {
        toast({ title: "Login Failed", description: error.message || "Invalid credentials", variant: "destructive" });
      } else {
        toast({ title: "Error", description: "Failed to connect to server", variant: "destructive" });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  return (
    <AdminAuthShell
      title="Manage users, services, and platform health from one place."
    >
          <div className="mb-8">
            <h2 className="mb-2 text-3xl font-semibold tracking-tight">Welcome back</h2>
            <p className="text-sm text-muted-foreground">Sign in to access the admin dashboard.</p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label htmlFor="email" className="block text-sm font-medium">Email</label>
              <input id="email" name="email" type="email" autoComplete="email" value={formData.email} onChange={handleChange} placeholder="admin@example.com" required className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-shadow placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" />
            </div>
            <div className="space-y-2">
              <label htmlFor="password" className="block text-sm font-medium">Password</label>
              <div className="relative">
                <input id="password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" value={formData.password} onChange={handleChange} placeholder="Enter your password" required className="h-11 w-full rounded-lg border border-input bg-background px-3 pr-12 text-sm outline-none transition-shadow placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" />
                <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Hide password" : "Show password"} className="absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div className="flex items-center justify-end">
              <Link href="/admin/forgot-password" className="text-sm font-medium text-primary hover:underline">Forgot password?</Link>
            </div>
            <button type="submit" disabled={isSubmitting} className="h-11 w-full rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60">
              {isSubmitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
    </AdminAuthShell>
  );
}

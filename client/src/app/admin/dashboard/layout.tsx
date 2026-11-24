import AdminDashboardLayout from "@/components/admin/AdminDashboardLayout";
import { AdminProtectedRoute } from "@/components/admin/AdminProtectedRoute";

export default function AdminDashboardRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AdminProtectedRoute>
      <AdminDashboardLayout>{children}</AdminDashboardLayout>
    </AdminProtectedRoute>
  );
}

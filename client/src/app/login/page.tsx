import ClientAuthPage from "@/components/auth/ClientAuthPage";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode } = await searchParams;
  return <ClientAuthPage initialMode={mode === "register" ? "register" : "login"} />;
}

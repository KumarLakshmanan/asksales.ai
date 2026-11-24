import PublicHeader from "./PublicHeader";
import BigFooter from "./BigFooter";

type Props = {
  children: React.ReactNode;
};

export default function PublicLayout({ children }: Props) {
  return (
    <div className="flex min-h-screen min-w-0 max-w-full flex-col overflow-x-clip bg-background text-foreground transition-colors duration-500">
      <PublicHeader />
      <main id="main-content" className="flex min-w-0 max-w-full flex-1 flex-col overflow-x-clip">{children}</main>
      <BigFooter />
    </div>
  );
}

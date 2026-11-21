export function PageHeader({ title, desc, children }: { title: React.ReactNode; desc: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex items-end gap-4">
      <div className="grid gap-1">
        <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{desc}</p>
      </div>
      {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
    </div>
  );
}

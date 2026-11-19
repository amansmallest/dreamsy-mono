export function Window({ title, children, className, tone }: { title: string; children: React.ReactNode; className?: string; tone?: "sky" | "mist" | "ice" }) {
  return (
    <div className={`window ${tone ? `window-${tone}` : ""} ${className ?? ""}`}>
      <div className="titlebar">
        <span className="close" aria-hidden />
        <span className="title">{title}</span>
      </div>
      <div className="window-body">{children}</div>
    </div>
  );
}

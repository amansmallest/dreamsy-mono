import type { Sprite } from "@/lib/pixel/sprites";

export function PixelArt({ sprite, className, ink = "var(--ink)", paper = "var(--paper)", label }: { sprite: Sprite; className?: string; ink?: string; paper?: string; label?: string }) {
  const rects: React.ReactNode[] = [];
  sprite.rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c === "#" || (c === "+" && (x + y) % 2 === 0)) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={ink} />);
      else if (c === "o" || c === "+") rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={paper} />);
    });
  });
  return (
    <svg className={className} viewBox={`0 0 ${sprite.w} ${sprite.h}`} shapeRendering="crispEdges" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {rects}
    </svg>
  );
}

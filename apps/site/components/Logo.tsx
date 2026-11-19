const GLYPHS: Record<string, string[]> = {
  d: ["....##", "....##", "....##", ".#####", "######", "##..##", "##..##", "##..##", "##..##", "######", ".#####"],
  r: ["", "", "", "##.###", "######", "###...", "##....", "##....", "##....", "##....", "##...."],
  e: ["", "", "", ".####.", "######", "##..##", "######", "######", "##....", "######", ".#####"],
  a: ["", "", "", ".####.", "######", "....##", ".#####", "######", "##..##", "######", ".#####"],
  m: ["", "", "", ".########.", "##########", "##..##..##", "##..##..##", "##..##..##", "##..##..##", "##..##..##", "##..##..##"],
  s: ["", "", "", ".#####", "######", "##....", "#####.", ".#####", "....##", "######", "#####."],
  y: ["", "", "", "##..##", "##..##", "##..##", "##..##", "##..##", "##..##", "######", ".#####", "....##", ".####."],
};

const SPARK = ["..#..", "..#..", "##.##", "..#..", "..#.."];


const H = 13;
const WORD_X = 0;

function cells() {
  const out: { x: number; y: number; w: number }[] = [];
  const add = (row: string, x0: number, y: number) => {
    let i = 0;
    while (i < row.length) {
      if (row[i] !== "#") { i++; continue; }
      let j = i;
      while (row[j] === "#") j++;
      out.push({ x: x0 + i, y, w: j - i });
      i = j;
    }
  };
  let x = WORD_X;
  for (const ch of "dreamsy") {
    const g = GLYPHS[ch]!;
    g.forEach((row, y) => add(row, x, y));
    x += Math.max(...g.map((r) => r.length)) + 1;
  }
  SPARK.forEach((row, y) => add(row, x + 1, y));
  return { runs: out, width: x + 1 + SPARK[0]!.length };
}

const { runs, width } = cells();

export function Logo({ className }: { className?: string }) {
  return (
    <svg className={`logo ${className ?? ""}`} viewBox={`0 0 ${width} ${H}`} shapeRendering="crispEdges" role="img" aria-label="Dreamsy">
      {runs.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill="currentColor" />
      ))}
    </svg>
  );
}

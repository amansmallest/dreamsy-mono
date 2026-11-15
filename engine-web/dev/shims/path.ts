// Minimal browser stub for node:path (used by Package.fromDir/toDir only).
export const join = (...p: string[]) => p.join("/").replace(/\/+/g, "/");
export const dirname = (p: string) => p.split("/").slice(0, -1).join("/") || ".";
export const relative = (from: string, to: string) => (to.startsWith(from + "/") ? to.slice(from.length + 1) : to);
export default { join, dirname, relative };

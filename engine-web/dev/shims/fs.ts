// Browser stub for node:fs/promises (only Package.fromDir/toDir use it, never called in the browser).
const unsupported = () => { throw new Error("filesystem access is not available in the browser"); };
export const readdir = unsupported, readFile = unsupported, mkdir = unsupported, writeFile = unsupported;
export default { readdir, readFile, mkdir, writeFile };

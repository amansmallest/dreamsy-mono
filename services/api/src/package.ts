import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAX_PACKAGE_BYTES, Package, registerKitDependencies, validatePackage, type Issue, type Manifest } from "@dreamsy/format";

// Kit dependency map (engine-web/kits/<kit>/kit.json), so validation accepts kit-to-kit requires.
{
  const dir = fileURLToPath(new URL("../../../engine-web/kits/", import.meta.url));
  const map: Record<string, string[]> = {};
  if (existsSync(dir)) {
    for (const kit of readdirSync(dir)) {
      const f = `${dir}${kit}/kit.json`;
      if (!existsSync(f)) continue;
      try { map[kit] = (JSON.parse(readFileSync(f, "utf8")) as { requires?: string[] }).requires ?? []; } catch { /* ignore broken kit.json */ }
    }
  }
  registerKitDependencies(map);
}

export { MAX_PACKAGE_BYTES };
export type { Manifest };

export class PackageError extends Error {
  constructor(message: string, readonly issues: Issue[] = []) {
    super(message);
  }
}

/** Full static validation via @dreamsy/format. A version can never hold an invalid package. */
export function inspectPackage(zip: Uint8Array): { sha256: string; manifest: Manifest } {
  if (zip.byteLength > MAX_PACKAGE_BYTES) throw new PackageError("package too large");
  let pkg: Package;
  try {
    pkg = Package.fromZip(zip);
  } catch {
    throw new PackageError("package is not a valid zip");
  }
  const result = validatePackage(pkg);
  if (!result.ok || !result.manifest) {
    const errors = result.issues.filter((i) => i.severity === "error");
    throw new PackageError(
      `invalid package: ${errors.slice(0, 5).map((i) => `[${i.code}] ${i.message}`).join("; ")}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ""}`,
      errors,
    );
  }
  return { sha256: createHash("sha256").update(zip).digest("hex"), manifest: result.manifest };
}

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = process.env.DREAMSY_ROOT ? resolve(process.env.DREAMSY_ROOT) : fileURLToPath(new URL("../../", import.meta.url));
export const repoPath = (...parts: string[]) => join(REPO_ROOT, ...parts);

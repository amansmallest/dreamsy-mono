import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TOOL } from "./paths";

const run = promisify(execFile);

export async function tool(...args: string[]) {
  const { stdout } = await run(TOOL, args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

import { z } from "zod";
import { defineTool } from "./tool.js";

export const readFiles = defineTool({
  name: "read_files",
  label: "reading files",
  description: "Read package files (scripts, scene JSON, data, dreamsy.toml, asset meta).",
  strict: true,
  input: z.object({ paths: z.array(z.string()).max(50) }),
  run: ({ paths }, { ws }) => ({ text: ws.readFiles(paths) }),
});

export const getEntities = defineTool({
  name: "get_entities",
  label: "inspecting entities",
  description: "Full JSON (type, props, scripts, tags, children) of specific entities by id.",
  strict: true,
  input: z.object({ ids: z.array(z.string()).max(200) }),
  run: ({ ids }, { ws }) => ({ text: ws.getEntities(ids) }),
});

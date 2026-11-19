"use client";

import { useState } from "react";

export function CopyCommand({ command, label = "MCP" }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <button className="cmd" type="button" onClick={copy} aria-label={`Copy: ${command}`}>
      <span className="cmd-tag">{label}</span>
      <code>$ {command}</code>
      <span className="cmd-copy">{copied ? "copied!" : "copy"}</span>
    </button>
  );
}

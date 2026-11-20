import type { NextConfig } from "next";

// /mcp is the hosted MCP server (harness/src/mcp/http.ts), a separate process next to the site.
const MCP = process.env.DREAMSY_MCP_ORIGIN ?? "http://127.0.0.1:8090";

const config: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: "/mcp", destination: `${MCP}/mcp` },
      { source: "/mcp/:path*", destination: `${MCP}/mcp/:path*` },
    ];
  },
};

export default config;

#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../mcp.ts";

const server = createServer();
await server.connect(new StdioServerTransport());

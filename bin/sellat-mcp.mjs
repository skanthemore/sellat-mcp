#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION, createSellatServer } from '../src/server.mjs';

if (process.argv.includes('--version')) {
  console.log(VERSION);
  process.exit(0);
}

// stdout carries the protocol; anything for a human goes to stderr.
const server = createSellatServer();
await server.connect(new StdioServerTransport());
console.error(`sellat-mcp ${VERSION} ready${process.env.SELLAT_API_TOKEN || process.env.SELLAT_API_KEY ? '' : ' (no API key: only sellat_hash and sellat_verify will work)'}`);

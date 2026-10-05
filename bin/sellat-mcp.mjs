#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION, configuredEnv, createSellatServer } from '../src/server.mjs';

if (process.argv.includes('--version')) {
  console.log(VERSION);
  process.exit(0);
}

// stdout carries the protocol; anything for a human goes to stderr.
const server = createSellatServer();
await server.connect(new StdioServerTransport());
console.error(`sellat-mcp ${VERSION} ready${configuredEnv(process.env).SELLAT_API_TOKEN || configuredEnv(process.env).SELLAT_API_KEY ? '' : ' (no API key: only find, hash and verify will work)'}`);

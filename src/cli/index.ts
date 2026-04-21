#!/usr/bin/env bun

import { runCli } from "./app.ts";

await runCli(process.argv.slice(2), process.stdin.isTTY);

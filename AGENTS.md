# pi-acp (ACP adapter for pi-coding-agent)

This repository implements an **Agent Client Protocol (ACP)** adapter for **pi** (`@mariozechner/pi-coding-agent`) without modifying pi.

- ACP side: **JSON-RPC 2.0 over stdio** using `@agentclientprotocol/sdk` (TypeScript)
- Pi side: spawn `pi --mode rpc` and communicate via **newline-delimited JSON** over stdio

After making a change, rerun `bun run build`.
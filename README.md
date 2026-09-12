# RyeGuru

RYE — source-grounded corpus and MCP application for rye baking.

## Current corpus

The RYE Core contains 6 source documents, page-aware extraction, retrieval, evidence links, and formula candidates.

The corpus policy is strict: documented source content is authoritative; unsupported procedures, quantities, temperatures, times, or recipes are not invented.

## Deployment

The intended architecture is:

ChatGPT → RyeGuru MCP → RYE Retrieval → RYE Core

The deployment package uses Streamable HTTP and exposes `/mcp`.

The complete RYE Core deployment bundle is maintained separately from this repository scaffold because the GitHub connector can write UTF-8 repository files but cannot upload arbitrary binary attachments directly through the Contents API.

## Status

GitHub write access has been verified on 2026-09-12.

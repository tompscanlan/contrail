/**
 * Health checks for the running devnet stack.
 *
 * Assumes `pnpm stack:up` has completed. Reads ports from the environment
 * with fallbacks matching `.env.example` so tests work out of the box.
 *
 * The Contrail handler is covered by ingest-roundtrip.test.ts in-process —
 * this file only verifies the external devnet services are reachable.
 */
import { describe, it, expect } from "vitest";
import net from "node:net";

const PDS_PORT = Number(process.env.DEVNET_PDS_PORT ?? 4000);
const PLC_PORT = Number(process.env.DEVNET_PLC_PORT ?? 2582);
const TAP_PORT = Number(process.env.DEVNET_TAP_PORT ?? 2480);
const JS_PORT = Number(process.env.DEVNET_JETSTREAM_PORT ?? 6008);

async function get(url: string): Promise<Response> {
  return fetch(url);
}

function tcpConnect(port: number, host = "127.0.0.1"): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.setTimeout(3000);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`TCP connect to ${host}:${port} timed out`));
    });
    socket.once("error", reject);
    socket.connect(port, host);
  });
}

describe("devnet services", () => {
  it("PLC responds to /_health", async () => {
    const res = await get(`http://localhost:${PLC_PORT}/_health`);
    expect(res.ok).toBe(true);
  });

  it("PDS responds to /xrpc/_health", async () => {
    const res = await get(`http://localhost:${PDS_PORT}/xrpc/_health`);
    expect(res.ok).toBe(true);
  });

  it("TAP responds to /health", async () => {
    const res = await get(`http://localhost:${TAP_PORT}/health`);
    expect(res.ok).toBe(true);
  });

  it("Jetstream accepts TCP connections", async () => {
    await expect(tcpConnect(JS_PORT)).resolves.toBeUndefined();
  });
});

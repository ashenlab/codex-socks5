#!/usr/bin/env node
import net from "node:net";
import { URL } from "node:url";

const listenHost = process.env.BRIDGE_LISTEN_HOST || "127.0.0.1";
const listenPort = Number(process.env.BRIDGE_LISTEN_PORT || "18083");
const upstream = new URL(process.env.UPSTREAM_SOCKS || "socks5://127.0.0.1:1080");
const upstreamHost = upstream.hostname;
const upstreamPort = Number(upstream.port || "1080");
const parentPid = process.ppid;
const debug = process.env.BRIDGE_DEBUG === "1";

function debugLog(message) {
  if (debug) console.error(`[bridge] ${message}`);
}

if (process.env.BRIDGE_WATCH_PARENT !== "0") {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0);
    }
  }, 5000).unref();
}

function writeError(socket, status, message) {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
}

function parseConnectHead(buffer) {
  const text = buffer.toString("latin1");
  const end = text.indexOf("\r\n\r\n");
  if (end === -1) return null;
  const [requestLine] = text.slice(0, end).split("\r\n");
  const [method, authority] = requestLine.split(" ");
  return { method, authority, headerBytes: end + 4 };
}

function parseAuthority(authority) {
  if (!authority) throw new Error("missing CONNECT authority");
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) throw new Error("invalid IPv6 authority");
    const host = authority.slice(1, close);
    const port = Number(authority.slice(close + 2));
    return { host, port };
  }
  const split = authority.lastIndexOf(":");
  if (split === -1) throw new Error("missing CONNECT port");
  return { host: authority.slice(0, split), port: Number(authority.slice(split + 1)) };
}

function socksConnect(targetHost, targetPort, initialPayload, client) {
  debugLog(`CONNECT ${targetHost}:${targetPort} via ${upstreamHost}:${upstreamPort}`);
  const upstreamSocket = net.connect({ host: upstreamHost, port: upstreamPort });
  let stage = 0;
  let chunks = [];

  upstreamSocket.on("connect", () => {
    upstreamSocket.write(Buffer.from([0x05, 0x01, 0x00]));
  });

  upstreamSocket.on("data", (chunk) => {
    chunks.push(chunk);
    const data = Buffer.concat(chunks);

    if (stage === 0) {
      if (data.length < 2) return;
      chunks = [data.subarray(2)];
      if (data[0] !== 0x05 || data[1] !== 0x00) {
        debugLog(`SOCKS authentication failed: ${data[0]},${data[1]}`);
        client.destroy(new Error("SOCKS authentication failed"));
        upstreamSocket.destroy();
        return;
      }

      const hostBytes = Buffer.from(targetHost);
      if (hostBytes.length > 255) {
        client.destroy(new Error("target host too long"));
        upstreamSocket.destroy();
        return;
      }
      const request = Buffer.alloc(7 + hostBytes.length);
      request[0] = 0x05;
      request[1] = 0x01;
      request[2] = 0x00;
      request[3] = 0x03;
      request[4] = hostBytes.length;
      hostBytes.copy(request, 5);
      request.writeUInt16BE(targetPort, 5 + hostBytes.length);
      upstreamSocket.write(request);
      stage = 1;
    }

    if (stage === 1) {
      const reply = Buffer.concat(chunks);
      if (reply.length < 5) return;
      const atyp = reply[3];
      const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : reply[4];
      const needed = atyp === 0x03 ? 7 + addrLen : 6 + addrLen;
      if (reply.length < needed) return;
      chunks = [reply.subarray(needed)];

      if (reply[1] !== 0x00) {
        debugLog(`SOCKS connect failed with reply code ${reply[1]}`);
        writeError(client, 502, "Bad Gateway");
        upstreamSocket.destroy();
        return;
      }

      debugLog(`SOCKS connected ${targetHost}:${targetPort}`);
      client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: codex-socks-http-bridge\r\n\r\n");
      if (initialPayload.length > 0) upstreamSocket.write(initialPayload);
      const leftover = Buffer.concat(chunks);
      if (leftover.length > 0) client.write(leftover);
      upstreamSocket.pipe(client);
      client.pipe(upstreamSocket);
      stage = 2;
    }
  });

  upstreamSocket.on("error", (error) => {
    debugLog(`upstream socket error: ${error.message}`);
    writeError(client, 502, "Bad Gateway");
  });
  client.on("error", () => upstreamSocket.destroy());
}

const server = net.createServer((client) => {
  let buffer = Buffer.alloc(0);

  client.on("data", function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    const parsed = parseConnectHead(buffer);
    if (!parsed) return;
    client.off("data", onData);

    if (parsed.method !== "CONNECT") {
      writeError(client, 405, "Method Not Allowed");
      return;
    }

    try {
      const { host, port } = parseAuthority(parsed.authority);
      const initialPayload = buffer.subarray(parsed.headerBytes);
      socksConnect(host, port, initialPayload, client);
    } catch {
      writeError(client, 400, "Bad Request");
    }
  });
});

server.listen(listenPort, listenHost);

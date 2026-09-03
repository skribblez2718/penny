import dgram from "node:dgram";
import { appendFileSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import process from "node:process";
import tls from "node:tls";

const logPath = process.env.PENNY_PROVIDER_ACCESS_LOG;

function recordAttempt(surface) {
  if (logPath !== undefined && logPath.length > 0) {
    appendFileSync(logPath, `${surface}\n`, { encoding: "utf8", mode: 0o600 });
  }
  throw new Error(`provider-free conformance forbids network access through ${surface}`);
}

globalThis.fetch = async () => recordAttempt("fetch");
if ("WebSocket" in globalThis) {
  globalThis.WebSocket = class ForbiddenProviderFreeWebSocket {
    constructor() {
      recordAttempt("WebSocket");
    }
  };
}
http.request = () => recordAttempt("http.request");
http.get = () => recordAttempt("http.get");
https.request = () => recordAttempt("https.request");
https.get = () => recordAttempt("https.get");
http2.connect = () => recordAttempt("http2.connect");
net.connect = () => recordAttempt("net.connect");
net.createConnection = () => recordAttempt("net.createConnection");
tls.connect = () => recordAttempt("tls.connect");
dgram.createSocket = () => recordAttempt("dgram.createSocket");
syncBuiltinESMExports();

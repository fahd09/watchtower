// Minimal zero-dependency WebSocket server (RFC 6455).
//
// Node ships a built-in WebSocket *client* (global, since Node 21/22) but no
// server. This implements just enough of the server side for Watchtower's
// dashboard: the opening handshake, sending text frames (server -> browser),
// and handling client close/ping frames. It intentionally does not implement
// permessage-deflate, fragmentation of outgoing messages, or binary frames —
// the dashboard only needs to broadcast JSON text.
//
// API is drop-in compatible with the subset of `ws` we used:
//   const wss = new WebSocketServer({ server });
//   wss.on("connection", (ws) => { ws.send(str); ws.readyState === 1; ws.on("close", ...) });

import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// readyState values match the browser WebSocket constants
const OPEN = 1;
const CLOSED = 3;

// ── Frame encoding (server -> client frames are never masked) ──────────
function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    // 64-bit length; high 32 bits assumed 0 (payloads never exceed 4 GiB)
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = OPEN;
    this._buf = Buffer.alloc(0);
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._markClosed());
    socket.on("error", () => this._markClosed());
  }

  send(data) {
    if (this.readyState !== OPEN) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf-8");
    try {
      this.socket.write(encodeFrame(payload, 0x1)); // 0x1 = text frame
    } catch {
      this._markClosed();
    }
  }

  close() {
    if (this.readyState !== OPEN) return;
    try {
      this.socket.end(encodeFrame(Buffer.alloc(0), 0x8)); // 0x8 = close
    } catch {
      /* ignore */
    }
    this._markClosed();
  }

  _markClosed() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit("close");
  }

  // Parse inbound (masked) client frames. We only care about close/ping;
  // any text/binary the browser sends is drained and ignored.
  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);

    while (this._buf.length >= 2) {
      const buf = this._buf;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }

      let maskKey;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
      }

      if (buf.length < offset + len) return; // wait for full frame

      let payload = buf.subarray(offset, offset + len);
      if (masked) {
        payload = Buffer.from(payload); // copy before unmasking in place
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }
      this._buf = buf.subarray(offset + len);

      if (opcode === 0x8) {
        // close
        this.close();
        return;
      } else if (opcode === 0x9) {
        // ping -> pong
        try {
          this.socket.write(encodeFrame(payload, 0xa));
        } catch {
          this._markClosed();
        }
      } else if (opcode === 0x1) {
        // text frame from the client — surface it (used for control messages)
        this.emit("message", payload.toString("utf-8"));
      }
      // opcode 0x0/0x2/0xa (continuation/binary/pong): ignore
    }
  }
}

export class WebSocketServer extends EventEmitter {
  constructor({ server }) {
    super();
    server.on("upgrade", (req, socket) => this._handleUpgrade(req, socket));
  }

  _handleUpgrade(req, socket) {
    const key = req.headers["sec-websocket-key"];
    if ((req.headers["upgrade"] || "").toLowerCase() !== "websocket" || !key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    this.emit("connection", new WSConnection(socket));
  }
}

export default { WebSocketServer };

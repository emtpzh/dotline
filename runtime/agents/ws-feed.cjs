// A push-only WebSocket for the agents feed, without a dependency: the
// handshake, text frames out, and the client's control frames (ping, close)
// answered. Why beside the SSE feed: a browser keeps at most six HTTP/1.1
// connections per host, and an SSE stream holds one of them for as long as
// the page is open — with a few tabs on the same host, the short requests a
// turn needs (start it, read its session file) queue behind the streams and
// the turn never finishes. WebSockets are counted apart.
'use strict';
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// the page sends nothing but control frames; anything larger is not ours
const MAX_CLIENT_FRAME = 64 * 1024;

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) head = Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]);
  else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/**
 * Upgrade `req` on `socket` to a push-only WebSocket. Returns the client —
 * send(text), ping(), close(), onClose(cb) — or null when the request is not
 * a WebSocket handshake (the socket is then destroyed).
 */
function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay?.(true);

  let open = true;
  const closers = new Set();
  const end = () => {
    if (!open) return;
    open = false;
    try { socket.end(); } catch { /* gone */ }
    for (const cb of closers) cb();
  };
  const write = (buf) => {
    if (!open) return;
    try { socket.write(buf); } catch { end(); }
  };

  let pending = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0] & 0x0f;
      const masked = (pending[1] & 0x80) !== 0;
      let len = pending[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (pending.length < 4) return;
        len = pending.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (pending.length < 10) return;
        len = Number(pending.readBigUInt64BE(2));
        off = 10;
      }
      if (len > MAX_CLIENT_FRAME) { end(); return; }
      const maskAt = off;
      if (masked) off += 4;
      if (pending.length < off + len) return;
      const payload = Buffer.from(pending.subarray(off, off + len));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= pending[maskAt + (i & 3)];
      pending = pending.subarray(off + len);
      if (opcode === 0x8) { write(frame(0x8, payload.subarray(0, 2))); end(); return; }
      if (opcode === 0x9) write(frame(0xa, payload));
      // text, binary, pong: a push-only feed reads nothing
    }
  });
  socket.on('close', end);
  socket.on('end', end);
  socket.on('error', end);

  return {
    send: (text) => write(frame(0x1, Buffer.from(text))),
    ping: () => write(frame(0x9, Buffer.alloc(0))),
    close: () => { write(frame(0x8, Buffer.from([0x03, 0xe8]))); end(); },
    onClose: (cb) => { closers.add(cb); },
  };
}

module.exports = { acceptWebSocket };

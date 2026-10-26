import http from 'node:http';
import net from 'node:net';

// Per-task egress proxy (ADR 5). The sandbox only lets the target connect to this proxy on
// loopback; the proxy only tunnels to allowlisted hosts. That covers the target CLI's own API
// traffic and every command it runs, without needing the CLI's own (non-nestable) sandbox.

// "*.cursor.sh" matches subdomains, "*" matches everything.
export function hostAllowed(host, patterns) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return patterns.some((p) => {
    p = p.toLowerCase();
    if (p === '*') return true;
    if (p.startsWith('*.')) return h.endsWith(p.slice(1)) || h === p.slice(2);
    return h === p;
  });
}

export function startProxy({ allow, ports = [443, 80] }) {
  const seen = { allowed: new Set(), denied: new Set() };
  // CONNECT tunnels are no longer tracked by the HTTP server, so server.close() would wait on them
  // forever; track every socket ourselves and destroy them on close.
  const sockets = new Set();
  const track = (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  };
  const server = http.createServer((req, res) => {
    // Plain-HTTP proxying is not offered: everything we allow speaks TLS through CONNECT.
    seen.denied.add(`${req.headers.host ?? '?'} (plain http ${req.method} ${String(req.url).slice(0, 80)})`);
    res.writeHead(403).end('nuncius: only HTTPS CONNECT is allowed\n');
  });
  server.on('connection', track);
  server.on('connect', (req, client, head) => {
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url ?? '');
    const host = m?.[1];
    const port = Number(m?.[2]);
    if (!host || !ports.includes(port) || !hostAllowed(host, allow) || net.isIP(host)) {
      seen.denied.add(`${host ?? req.url}:${port || '?'}`);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    seen.allowed.add(`${host}:${port}`);
    const upstream = net.connect(port, host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    track(upstream);
    const close = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on('error', close);
    client.on('error', close);
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        seen,
        close: async () => {
          server.close();
          for (const sock of sockets) sock.destroy();
        },
      }),
    );
  });
}

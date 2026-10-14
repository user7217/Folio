import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { ContainedDatabase } from '../../../packages/db/src/index.ts';
import { ReadingPlatformApp } from './app.ts';

export function createHttpServer(app: ReadingPlatformApp): http.Server {
  return http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBuf = Buffer.concat(chunks);
    let parsedBody: unknown = undefined;
    if (rawBuf.length > 0) {
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (ct.includes('application/json')) {
        try {
          parsedBody = JSON.parse(rawBuf.toString('utf8'));
        } catch {
          parsedBody = undefined;
        }
      } else {
        parsedBody = rawBuf.toString('utf8');
      }
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) {
        headers[k] = Array.isArray(v) ? v.join('; ') : String(v);
      }
    }

    const appRes = await app.handleRequest({
      method: req.method || 'GET',
      path: req.url || '/',
      headers,
      body: parsedBody,
      rawBodyBytes: rawBuf.length,
      ip: req.socket?.remoteAddress || '127.0.0.1',
    });

    res.statusCode = appRes.status;
    for (const [hk, hv] of Object.entries(appRes.headers)) {
      res.setHeader(hk, hv);
    }

    if (Buffer.isBuffer(appRes.body)) {
      res.end(appRes.body);
    } else if (typeof appRes.body === 'string') {
      res.end(appRes.body, 'utf8');
    } else {
      res.end(JSON.stringify(appRes.body));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = new ContainedDatabase(process.env.DATA_DIR);
  db.migrate();
  const app = new ReadingPlatformApp(db);
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const srv = createHttpServer(app);

  const shutdown = () => {
    console.log(JSON.stringify({ level: 'info', event: 'web.sigterm' }));
    srv.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  srv.listen(port, host, () => {
    console.log(JSON.stringify({ level: 'info', event: 'web.listening', host, port }));
  });
}

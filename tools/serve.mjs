import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8' };
const s = createServer((req,res)=>{
  // new URL('//', base) throws (protocol-relative form), which used to take the
  // whole server down on GET //. Parse defensively and answer 400 instead.
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; }
  catch { res.writeHead(400).end('bad request'); return; }
  const p = join(DIST, pathname === '/' ? '/index.html' : pathname);
  if(!p.startsWith(DIST)||!existsSync(p)){res.writeHead(404).end('nf');return;}
  const type = MIME[extname(p)]||'application/octet-stream';
  const raw = readFileSync(p);
  // The 411 KB snapshot.json dominated LCP under Lighthouse's simulated
  // throttling; gzipping text payloads cuts the transfer ~6x. Files below
  // ~1.4 KB go out raw — compression overhead is not worth it there.
  if (raw.length > 1400 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.writeHead(200, { 'content-type': type, 'content-encoding': 'gzip' });
    createGzip().end(raw).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': type });
  res.end(raw);
});
const port = Number(process.argv[2]||8099);
s.listen(port,'127.0.0.1',()=>console.log('serving dist on http://127.0.0.1:'+port));

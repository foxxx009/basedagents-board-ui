import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8' };
const s = createServer((req,res)=>{
  const p = join(DIST, (new URL(req.url,'http://x').pathname === '/' ? '/index.html' : new URL(req.url,'http://x').pathname));
  if(!p.startsWith(DIST)||!existsSync(p)){res.writeHead(404).end('nf');return;}
  res.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream'});
  res.end(readFileSync(p));
});
const port = Number(process.argv[2]||8099);
s.listen(port,'127.0.0.1',()=>console.log('serving dist on http://127.0.0.1:'+port));

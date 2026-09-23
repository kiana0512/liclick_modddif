import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('public/qa-pending');
http.createServer(async(req,res)=>{
 try{
 const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/qa-pending\//,'');
 const file=path.resolve(root,name);
 if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]??'application/octet-stream';
 res.writeHead(200,{'Content-Type':mime});res.end(await readFile(file));
 }catch{res.end();}
}).listen(5200,'127.0.0.1');

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import WebSocket, { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { windowsProxy,resolveNetwork,configureRuntimeNetwork } from '../lib/runtime-network.js';


test('Windows proxy parsing obeys the enable switch and supports per-protocol settings',()=>{
 assert.equal(windowsProxy('ProxyEnable REG_DWORD 0x1\r\nProxyServer REG_SZ 127.0.0.1:10808'),'http://127.0.0.1:10808/');
 assert.equal(windowsProxy('ProxyEnable REG_DWORD 0x0\r\nProxyServer REG_SZ 127.0.0.1:10808'),'');
 assert.equal(windowsProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http=localhost:8000;https=localhost:8001;socks=localhost:9000'),'http://localhost:8001/');
 assert.equal(windowsProxy('ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ socks=localhost:9000'),'');
});
test('proxy selection preserves explicit environment settings, custom overrides and local bypasses',()=>{
 const a=resolveNetwork({}, {HTTPS_PROXY:'http://env:8000',NO_PROXY:'.internal'},'http://system:8001');assert.equal(a.source,'environment');assert.equal(a.proxyEnv.https_proxy,'http://env:8000/');assert.match(a.proxyEnv.no_proxy,/127\.0\.0\.1/);assert.match(a.proxyEnv.no_proxy,/\.internal/);
 const b=resolveNetwork({proxyMode:'custom',proxyUrl:'localhost:1234'}, {HTTPS_PROXY:'http://env:8000'},'http://system:8001');assert.equal(b.source,'custom');assert.equal(b.proxyEnv.https_proxy,'http://localhost:1234/');
 const c=resolveNetwork({proxyMode:'direct'}, {HTTPS_PROXY:'http://env:8000'},'http://system:8001');assert.equal(c.source,'direct');assert.equal(c.proxyEnv.https_proxy,'');
 assert.throws(()=>resolveNetwork({proxyMode:'custom',proxyUrl:'socks5://localhost:8000'}),{code:'network-proxy-invalid'});
 assert.throws(()=>resolveNetwork({proxyMode:'typo'}),{code:'network-config-invalid'});
});
test('runtime configuration applies public Node proxy support to fetch and HTTP while loopback stays direct',async()=>{
 const sockets=new Set(),proxy=http.createServer((request,response)=>response.end('proxy:'+new URL(request.url,'http://'+request.headers.host).href)),local=http.createServer((request,response)=>response.end('direct'));
 // Node 24's fetch can tunnel HTTP with CONNECT; Node 26 also uses absolute-form
 // requests. A real HTTP proxy supports both. Route the synthetic origin back to
 // this fixture without contacting an external host.
 proxy.on('connect',(request,client,head)=>{assert.equal(request.url,'discord-network-fixture.invalid:80');const upstream=net.connect(proxy.address().port,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream).pipe(client);});for(const socket of [client,upstream]){sockets.add(socket);socket.on('close',()=>sockets.delete(socket));}upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());});
 proxy.listen(0,'127.0.0.1');local.listen(0,'127.0.0.1');await Promise.all([once(proxy,'listening'),once(local,'listening')]);
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-channel-network-'));
 let network;
 try{
  await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({network:{proxyMode:'custom',proxyUrl:'http://127.0.0.1:'+proxy.address().port}}));
  network=await configureRuntimeNetwork(directory,{env:{}});assert.equal(network.source,'custom');
  const response=await fetch('http://discord-network-fixture.invalid/test',{signal:AbortSignal.timeout(5000)});assert.equal(await response.text(),'proxy:http://discord-network-fixture.invalid/test');
  const httpText=await new Promise((resolve,reject)=>{http.get('http://discord-network-fixture.invalid/sdk',response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve(text));}).on('error',reject);});assert.equal(httpText,'proxy:http://discord-network-fixture.invalid/sdk');
  const direct=await fetch('http://127.0.0.1:'+local.address().port,{signal:AbortSignal.timeout(5000)});assert.equal(await direct.text(),'direct');
 }finally{network?.restore();for(const socket of sockets)socket.destroy();proxy.closeAllConnections();local.closeAllConnections();await Promise.all([new Promise(resolve=>proxy.close(resolve)),new Promise(resolve=>local.close(resolve))]);assert((await fs.realpath(directory)).startsWith(await fs.realpath(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true});}
});

test('SDK WSS uses CONNECT with verified TLS and SNI; loopback bypasses the proxy and cleanup restores globals',async()=>{
 const cert=await fs.readFile(new URL('./fixtures/test-only-cert.pem',import.meta.url)),key=await fs.readFile(new URL('./fixtures/test-only-key.pem',import.meta.url));
 const secure=https.createServer({cert,key}),gateway=new WebSocketServer({server:secure});
 gateway.on('connection',socket=>socket.send('hello'));
 secure.listen(0,'127.0.0.1');await once(secure,'listening');
 const tunnels=[],sockets=new Set(),proxy=http.createServer();
 proxy.on('connect',(request,client,head)=>{
  tunnels.push(request.url);sockets.add(client);client.on('close',()=>sockets.delete(client));
  const upstream=net.connect(secure.address().port,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
  sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());
 });
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-channel-wss-'));
 const before=[http.get,http.request,http.globalAgent,https.get,https.request,https.globalAgent];let network;
 async function connect(url,options={}){const socket=new WebSocket(url,{ca:cert,handshakeTimeout:5000,...options});try{const [message]=await once(socket,'message',{signal:AbortSignal.timeout(7000)});assert.equal(message.toString(),'hello');}finally{socket.terminate();}}
 try{
  await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({network:{proxyMode:'custom',proxyUrl:'http://127.0.0.1:'+proxy.address().port}}));
  network=await configureRuntimeNetwork(directory,{env:{}});
  await connect('wss://discord-network-fixture.invalid:'+secure.address().port);assert.deepEqual(tunnels,['discord-network-fixture.invalid:'+secure.address().port]);
  await connect('wss://localhost:'+secure.address().port,{family:4});assert.equal(tunnels.length,1);
  network.restore();network.restore();assert.deepEqual([http.get,http.request,http.globalAgent,https.get,https.request,https.globalAgent],before);
 }finally{network?.restore();for(const socket of gateway.clients)socket.terminate();for(const socket of sockets)socket.destroy();await Promise.all([new Promise(resolve=>gateway.close(resolve)),new Promise(resolve=>secure.close(resolve)),new Promise(resolve=>proxy.close(resolve))]);assert((await fs.realpath(directory)).startsWith(await fs.realpath(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true});}
});

test('system proxy target refreshes without a second global-agent wrapper or Host restart', async () => {
  const before=[http.get,http.request,http.globalAgent,https.get,https.request,https.globalAgent];
  const proxy1=http.createServer((_req,res)=>res.end('proxy-one'));
  const proxy2=http.createServer((_req,res)=>res.end('proxy-two'));
  proxy1.listen(0,'127.0.0.1');proxy2.listen(0,'127.0.0.1');
  await Promise.all([once(proxy1,'listening'),once(proxy2,'listening')]);
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-proxy-refresh-'));
  const first='http://127.0.0.1:'+proxy1.address().port;
  const second='http://127.0.0.1:'+proxy2.address().port;
  let selection=first,network;
  const read=()=>new Promise((resolve,reject)=>{
    const request=http.get('http://discord-refresh-fixture.invalid/status',response=>{
      const chunks=[];response.on('data',x=>chunks.push(x));response.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('error',reject);
  });
  try {
    await fs.writeFile(path.join(directory,'config.json'),JSON.stringify({network:{proxyMode:'system'}}));
    network=await configureRuntimeNetwork(directory,{env:{},system:async()=>selection});
    assert.equal(await read(),'proxy-one');
    assert.equal(await network.refresh(),false);
    selection=second;
    assert.equal(await network.refresh(),true);
    assert.equal(network.source,'system');
    assert.equal(await read(),'proxy-two');
    assert.equal(await network.refresh(),false);
    network.restore();network.restore();
    assert.deepEqual([http.get,http.request,http.globalAgent,https.get,https.request,https.globalAgent],before);
  } finally {
    network?.restore();proxy1.closeAllConnections();proxy2.closeAllConnections();
    await Promise.all([new Promise(ok=>proxy1.close(ok)),new Promise(ok=>proxy2.close(ok))]);
    await fs.rm(directory,{recursive:true,force:true});
  }
});

test('initial direct mode can adopt a system proxy that starts later', async () => {
  const before=[http.get,http.request,http.globalAgent,https.get,https.request,https.globalAgent];
  const proxy=http.createServer((_req,res)=>res.end('late-proxy'));
  proxy.listen(0,'127.0.0.1');
  await once(proxy,'listening');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-late-proxy-'));
  let systemProxy='',network;
  try {
    await fs.writeFile(path.join(dir,'config.json'),JSON.stringify({network:{proxyMode:'system'}}));
    network=await configureRuntimeNetwork(dir,{env:{},system:async()=>systemProxy});
    assert.equal(network.viaProxy,false);
    systemProxy='http://127.0.0.1:'+proxy.address().port;
    assert.equal(await network.refresh(),true);
    assert.equal(network.viaProxy,true);
    const body=await new Promise((resolve,reject)=>{
      const request=http.get('http://late-discord-fixture.invalid/ping',response=>{
        const chunks=[];response.on('data',x=>chunks.push(x));response.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
      });
      request.on('error',reject);
    });
    assert.equal(body,'late-proxy');
    network.restore();
    assert.deepEqual([http.get,http.request,http.globalAgent,https.get,https.request,https.globalAgent],before);
  } finally {
    network?.restore();proxy.closeAllConnections();await new Promise(ok=>proxy.close(ok));
    await fs.rm(dir,{recursive:true,force:true});
  }
});

'use strict';

/**
 * Bubble v2: Firebase stores only manifest, server presence and membership IDs.
 * Player positions live exclusively in this Node process's RAM.
 * No public endpoint discloses a position without Firebase identity + membership.
 */
const crypto = require('node:crypto');
const {URL} = require('node:url');
const {
  validInstanceId, validUid, validPlayerId,
  membersOf, belongs, normalizeState, bad, listMembers, selectPlayers
} = require('./bubble-v2-core');

function numberEnv(name, fallback, min, max) {
  const raw = process.env[name];
  const n = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${name}: expected ${min}..${max}`);
  return n;
}
function createFromEnvironment() {
  if (process.env.BUBBLE_V2_ENABLED !== 'true') return null;
  const { cert, applicationDefault, initializeApp, getApps } = require('firebase-admin/app');
  const { getDatabase } = require('firebase-admin/database');
  const { getAuth } = require('firebase-admin/auth');
  const {WebSocketServer} = require('ws');
  const databaseURL = process.env.FIREBASE_DATABASE_URL || 'https://worknow-be4bd-default-rtdb.firebaseio.com';
  const projectId = process.env.FIREBASE_PROJECT_ID || 'worknow-be4bd';
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_B64
    ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_JSON_B64, 'base64').toString('utf8')
    : process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  let credential;
  if (raw) {
    let parsed;
    try { parsed=JSON.parse(raw); }
    catch { throw new Error('Credencial inválida: FIREBASE_SERVICE_ACCOUNT_JSON_B64 não contém JSON válido.'); }
    if (!parsed.private_key || !parsed.client_email) throw new Error('Service Account Firebase incompleta.');
    if(parsed.project_id !== projectId) throw new Error('Service Account pertence a outro projeto Firebase.');
    credential=cert(parsed);
  } else {
    // Local development / workload identity only. Render typically needs the service account.
    credential=applicationDefault();
  }
  const name='bubble-v2';
  const app=getApps().find(x=>x.name===name) || initializeApp({credential,databaseURL,projectId},name);
  return createV2({
    db:getDatabase(app),
    verifyIdToken:token=>getAuth(app).verifyIdToken(token),
    WebSocketServer,
    options:{
      playerTtlMs:numberEnv('BUBBLE_V2_PLAYER_TTL_MS',2500,300,120000),
      maxRemotes:numberEnv('BUBBLE_V2_MAX_REMOTES',8,1,64),
      stateRatePerSecond:numberEnv('BUBBLE_V2_STATE_RATE_PER_SEC',15,1,200),
      presenceCacheMs:numberEnv('BUBBLE_V2_BDS_CACHE_MS',2000,200,30000),
      presenceMaxAgeMs:numberEnv('BUBBLE_V2_BDS_MAX_AGE_MS',90000,10000,600000),
      manifestCacheMs:numberEnv('BUBBLE_V2_MANIFEST_CACHE_MS',5000,500,120000),
      viewerTokenMs:numberEnv('BUBBLE_V2_VIEWER_TOKEN_MS',300000,15000,600000)
    }
  });
}

function createV2({db,verifyIdToken,WebSocketServer,options={}}){
  const cfg={playerTtlMs:2500,maxRemotes:8,stateRatePerSecond:15,presenceCacheMs:2000,
    presenceMaxAgeMs:90000,manifestCacheMs:5000,viewerTokenMs:300000,...options};
  const states=new Map(), instances=new Map(), presenceCache=new Map(), manifestCache=new Map();
  const ephemeralTokens=new Map(), writes=new Map(), sockets=new Set();
  let wss=null;
  const MINUTE=60000;
  function stateKey(instanceId,bdsId,playerId){return `${instanceId}|${bdsId}|${playerId}`;}
  function sendJson(res,status,payload){
    const text=JSON.stringify(payload);
    res.writeHead(status,{'content-type':'application/json; charset=utf-8',
      'content-length':Buffer.byteLength(text),'cache-control':'no-store'});
    res.end(text);
  }
  function failed(res,e){
    const status=Number.isInteger(e.status)?e.status:503;
    const code=e.code||'FIREBASE_UNAVAILABLE';
    if(status>=500) console.error('[bubble-v2]',e.message);
    return sendJson(res,status,{error:{code,message:status>=500?'Firebase indisponível ou configuração inválida.':e.message}});
  }
  async function requestBody(req){
    let total=0, chunks=[];
    for await(const chunk of req){
      total+=chunk.length;
      if(total>65536)throw bad('BODY_TOO_LARGE','Body ultrapassou 64 KiB.',413);
      chunks.push(chunk);
    }
    try{return chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}
    catch{throw bad('INVALID_JSON','JSON inválido.',400);}
  }
  function purgeStates(){
    const t=Date.now();
    for(const [key,p] of states) if(t-p.updatedAt>cfg.playerTtlMs)states.delete(key);
    for(const [key,p] of writes)if(t-p.start>3000)writes.delete(key);
    for(const [key,p] of ephemeralTokens)if(t>p.expiresAt)ephemeralTokens.delete(key);
    for(const [key,p] of presenceCache)if(t-p.readAt>cfg.presenceCacheMs*8)presenceCache.delete(key);
    for(const [key,p] of manifestCache)if(t-p.readAt>cfg.manifestCacheMs*8)manifestCache.delete(key);
    for(const [id,p]of instances)if(t-p.lastUsed>120000 && ![...sockets].some(x=>x.bubble?.instanceId===id)){
      p.ref.off('value',p.listener);
      instances.delete(id);
    }
  }
  function removeNoLongerMembers(instanceId, instance){
    for(const [key,p]of states)if(p.instanceId===instanceId && !belongs(instance,p.bdsId,p.playerId))states.delete(key);
    for(const ws of sockets){
      if(ws.bubble?.instanceId===instanceId && !membersOf(instance,ws.bubble.uid).length) {
        try{ws.close(1008,'Instância sem membro autorizado');}catch{}
      }
    }
  }
  // RTDB .on('value') pushes changes only when manifest/IDs/membership change.
  async function instanceEntry(instanceId){
    if(!validInstanceId(instanceId))throw bad('INVALID_INSTANCE','ID da instância inválido.',400);
    const current=instances.get(instanceId);
    if(current){current.lastUsed=Date.now();await current.ready;return current;}
    const ref=db.ref(`bubble/instances/${instanceId}`);
    let resolveReady, rejectReady;
    const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    const obj={ref,ready,value:null,lastUsed:Date.now(),listener:null};
    const timer=setTimeout(()=>rejectReady(bad('FIREBASE_TIMEOUT','Tempo limite consultando instância.',503)),7000);
    timer.unref?.();
    let initialized=false;
    const listener=snap=>{
      obj.value=snap.val();
      removeNoLongerMembers(instanceId,obj.value);
      if(!initialized){initialized=true;clearTimeout(timer);resolveReady();}
    };
    obj.listener=listener;
    instances.set(instanceId,obj);
    try{ref.on('value',listener,err=>{
      console.error('[bubble-v2] Instance listener error:',err.message);
      if(!initialized){initialized=true;clearTimeout(timer);rejectReady(bad('FIREBASE_LISTENER','Não foi possível ler a instância.',503));}
      for(const ws of sockets)if(ws.bubble?.instanceId===instanceId)ws.close(1011,'Firebase indisponível');
    });}
    catch(e){clearTimeout(timer);instances.delete(instanceId);throw e;}
    try{await ready;}catch(e){try{ref.off('value',listener);}catch{}instances.delete(instanceId);throw e;}
    return obj;
  }
  async function getInstance(id){
    const e=await instanceEntry(id);
    if(!e.value || typeof e.value!=='object')throw bad('INSTANCE_NOT_FOUND','Instância não encontrada.',404);
    if(e.value.status==='closed' || e.value.status==='disabled')throw bad('INSTANCE_CLOSED','Instância desativada.',403);
    if(!e.value.manifestId || typeof e.value.manifestId!=='string')throw bad('INVALID_MANIFEST_ID','Instância sem manifesto.',503);
    return e.value;
  }
  async function getManifest(id){
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw bad('INVALID_MANIFEST_ID','Manifesto inválido.',400);
    const cached=manifestCache.get(id);
    if(cached && Date.now()-cached.readAt<cfg.manifestCacheMs)return cached.value;
    const snap=await db.ref(`bubble/manifests/${id}`).get();
    const m=snap.val();
    if(!m || m.enabled!==true || !Number.isSafeInteger(m.numericDimensionId))throw bad('MANIFEST_UNAVAILABLE','Manifesto não encontrado, desativado ou inválido.',503);
    manifestCache.set(id,{value:m,readAt:Date.now()});
    return m;
  }
  async function getBds(uid){
    if(!validUid(uid))throw bad('INVALID_UID','UID inválido.',401);
    const cached=presenceCache.get(uid);
    if(cached && Date.now()-cached.readAt<cfg.presenceCacheMs)return cached.value;
    const snap=await db.ref(`bubble/bds/${uid}`).get();
    const value=snap.val();
    presenceCache.set(uid,{value,readAt:Date.now()});
    return value;
  }
  async function authorize(uid,instanceId,needMember=true){
    const instance=await getInstance(instanceId);
    const bds=await getBds(uid);
    if(!bds || bds.online!==true || bds.instanceId!==instanceId || bds.manifestId!==instance.manifestId ||
      !Number.isFinite(bds.lastSeen) || Date.now()-bds.lastSeen>cfg.presenceMaxAgeMs || bds.lastSeen>Date.now()+MINUTE){
      throw bad('BDS_NOT_PRESENT','BDS offline ou não associado a esta instância.',403);
    }
    if(needMember && !membersOf(instance,uid).length)throw bad('NOT_INSTANCE_MEMBER','BDS sem jogadores nesta instância.',403);
    return {instance,bds};
  }
  async function verifiedUid(token){
    if(typeof token!=='string' || token.length<20 || token.length>10000)throw bad('AUTH_REQUIRED','Firebase ID token obrigatório.',401);
    let decoded;
    try{decoded=await verifyIdToken(token);}catch{throw bad('INVALID_FIREBASE_TOKEN','Firebase ID token inválido ou expirado.',401);}
    if(!validUid(decoded?.uid))throw bad('INVALID_FIREBASE_UID','Firebase UID inválido.',401);
    return {uid:decoded.uid, expiresAt:decoded.exp?decoded.exp*1000:Date.now()+3600000};
  }
  async function httpUid(req){
    const match=/^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization||''));
    if(!match)throw bad('AUTH_REQUIRED','Authorization: Bearer <Firebase ID token> necessário.',401);
    return (await verifiedUid(match[1])).uid;
  }
  function allowedWrite(key){
    const t=Date.now();let b=writes.get(key);
    if(!b || t-b.start>=1000){writes.set(key,{start:t,count:1});return true;}
    if(b.count>=cfg.stateRatePerSecond)return false;
    b.count++;return true;
  }
  async function publish(uid,body){
    const instanceId=body?.instanceId;
    const {instance}=await authorize(uid,instanceId,true);
    const manifest=await getManifest(instance.manifestId);
    const data=normalizeState(body,manifest.numericDimensionId);
    if(data.bdsId!==uid)throw bad('BDS_ID_MISMATCH','bdsId deve ser o UID autenticado.',403);
    if(!belongs(instance,uid,data.playerId))throw bad('PLAYER_NOT_MEMBER','playerId não pertence a este BDS/instância.',403);
    if(!allowedWrite(`${instanceId}|${uid}|${data.playerId}`))throw bad('RATE_LIMIT','Frequência de publicação excedida.',429);
    const t=Date.now();
    const key=stateKey(instanceId,uid,data.playerId);
    const previous=states.get(key);
    const p={instanceId,bdsId:uid,playerId:data.playerId,state:data.state,updatedAt:t,revision:(previous?.revision||0)+1};
    states.set(key,p);
    broadcast(p);
    return {ok:true,instanceId,playerId:p.playerId,revision:p.revision,updatedAt:t,ttlMs:cfg.playerTtlMs};
  }
  function listPlayers(instanceId,uid,includeSelf,limit){
    purgeStates();
    const effectiveMax=Math.min(cfg.maxRemotes,limit||cfg.maxRemotes);
    return selectPlayers(states,instanceId,uid,cfg.playerTtlMs,effectiveMax,includeSelf);
  }
  const paths={
    manifest:/^\/v2\/instances\/([^/]+)\/manifest$/,
    members:/^\/v2\/instances\/([^/]+)\/members$/,
    players:/^\/v2\/instances\/([^/]+)\/players$/
  };
  async function handleHttp(req,res,urlValue){
    const url=urlValue || new URL(req.url,'http://localhost');
    const path=url.pathname;
    if(!path.startsWith('/v2/'))return false;
    try{
      if(req.method==='GET' && path==='/v2/healthz'){
        return sendJson(res,200,{ok:true,service:'bubble-api-v2',firebase:'configured',activeInstances:instances.size,liveStates:states.size}),true;
      }
      const uid=await httpUid(req);
      let m;
      if(req.method==='POST' && path==='/v2/state/publish'){
        const payload=await requestBody(req);
        return sendJson(res,200,await publish(uid,payload)),true;
      }
      if(req.method==='POST' && path==='/v2/access/grant'){
        const body=await requestBody(req),id=body?.instanceId;
        await authorize(uid,id,true);
        const token=crypto.randomBytes(32).toString('base64url');
        const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
        const expiresAt=Date.now()+cfg.viewerTokenMs;
        ephemeralTokens.set(tokenHash,{uid,instanceId:id,expiresAt});
        return sendJson(res,200,{instanceId:id,token,expiresAt,scope:'instance:read',wsPath:'/v2/live'}),true;
      }
      if(req.method==='GET' && (m=path.match(paths.manifest))){
        const id=decodeURIComponent(m[1]);
        const {instance}=await authorize(uid,id,false);
        const manifest=await getManifest(instance.manifestId);
        return sendJson(res,200,{instanceId:id,manifestId:instance.manifestId,manifest}),true;
      }
      if(req.method==='GET' && (m=path.match(paths.members))){
        const id=decodeURIComponent(m[1]);
        const {instance}=await authorize(uid,id,true);
        const members=listMembers(instance);
        return sendJson(res,200,{instanceId:id,count:members.length,members}),true;
      }
      if(req.method==='GET' && (m=path.match(paths.players))){
        const id=decodeURIComponent(m[1]);
        const {instance}=await authorize(uid,id,true);
        const lim=Math.min(cfg.maxRemotes,Math.max(1,Number(url.searchParams.get('limit')||cfg.maxRemotes)));
        const includeSelf=url.searchParams.get('include_self')==='1';
        const selected=listPlayers(id,uid,includeSelf,Number.isFinite(lim)?lim:cfg.maxRemotes);
        return sendJson(res,200,{instanceId:id,serverTime:Date.now(),
          count:selected.count,players:selected.players,memberCount:listMembers(instance).length}),true;
      }
      return sendJson(res,404,{error:{code:'NOT_FOUND',message:'Rota v2 não encontrada.'}}),true;
    }catch(e){failed(res,e);return true;}
  }
  function sendWs(ws,data){
    if(ws.readyState!==1 || ws.bufferedAmount>262144)return;
    try{ws.send(JSON.stringify(data));}catch{}
  }
  function broadcast(p){
    const msg={type:'state',instanceId:p.instanceId,bdsId:p.bdsId,
      playerId:p.playerId,state:p.state,updatedAt:p.updatedAt,revision:p.revision};
    for(const ws of sockets){
      if(ws.bubble?.instanceId!==p.instanceId || (ws.bubble.uid===p.bdsId && !ws.bubble.echoSelf))continue;
      const e=instances.get(p.instanceId)?.value;
      if(!membersOf(e,ws.bubble.uid).length)continue;
      sendWs(ws,msg);
    }
  }
  async function authenticateSocket(ws,payload){
    if(ws.bubble)throw bad('ALREADY_AUTHENTICATED','WebSocket já autenticado.',409);
    const instanceId=payload?.instanceId, token=payload?.token;
    if(!validInstanceId(instanceId))throw bad('INVALID_INSTANCE','instanceId inválido.',400);
    let who;
    if(typeof token==='string'){
      const hashed=crypto.createHash('sha256').update(token).digest('hex');
      const grant=ephemeralTokens.get(hashed);
      if(grant){
        if(grant.expiresAt<Date.now() || grant.instanceId!==instanceId)throw bad('TOKEN_SCOPE','Token expirado ou de outra instância.',403);
        who={uid:grant.uid,expiresAt:grant.expiresAt,readOnly:true};
      }else{
        who={...(await verifiedUid(token)),readOnly:false};
      }
    }else throw bad('AUTH_REQUIRED','Token obrigatório.',401);
    await authorize(who.uid,instanceId,true);
    ws.bubble={...who,instanceId,echoSelf:who.readOnly && payload?.echoSelf === true};
    sendWs(ws,{type:'ready',instanceId,scope:who.readOnly?'instance:read':'instance:readwrite',playerTtlMs:cfg.playerTtlMs});
  }
  function attachWebSocket(server){
    if(!WebSocketServer)return;
    wss=new WebSocketServer({noServer:true,maxPayload:16384,clientTracking:false});
    server.on('upgrade',(req,socket,head)=>{
      let url;
      try{url=new URL(req.url,'http://localhost');}catch{socket.destroy();return;}
      if(url.pathname!=='/v2/live'){
        // v1 has no websocket, reject unexpected upgrades explicitly.
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');socket.destroy();return;
      }
      wss.handleUpgrade(req,socket,head,ws=>{
        sockets.add(ws);
        const timeout=setTimeout(()=>{if(!ws.bubble)ws.close(1008,'Autenticação obrigatória');},10000);
        timeout.unref?.();
        ws.on('message',raw=>{
          (async()=>{
            let payload;
            try{payload=JSON.parse(raw.toString('utf8'));}catch{throw bad('INVALID_JSON','JSON inválido.',400);}
            if(payload?.type==='auth')return authenticateSocket(ws,payload);
            if(!ws.bubble)throw bad('AUTH_REQUIRED','Autentique com type=auth.',401);
            if(Date.now()>ws.bubble.expiresAt){ws.close(1008,'Credencial expirada');return;}
            if(payload?.type==='ping'){sendWs(ws,{type:'pong',t:Date.now()});return;}
            if(payload?.type==='publish'){
              if(ws.bubble.readOnly)throw bad('READ_ONLY','Token de receptor não pode publicar.',403);
              if(payload.instanceId!==ws.bubble.instanceId)throw bad('TOKEN_SCOPE','Instância incorreta.',403);
              const out=await publish(ws.bubble.uid,payload);
              sendWs(ws,{type:'ack',...out});return;
            }
            throw bad('UNKNOWN_ACTION','Mensagem WebSocket desconhecida.',400);
          })().catch(e=>sendWs(ws,{type:'error',code:e.code||'INTERNAL_ERROR',message:e.status>=500?'Falha temporária.':e.message}));
        });
        ws.on('close',()=>{clearTimeout(timeout);sockets.delete(ws);});
        ws.on('error',()=>{clearTimeout(timeout);sockets.delete(ws);});
      });
    });
  }
  const ticker=setInterval(()=>{
    purgeStates();
    for(const ws of sockets)if(ws.bubble){
      if(Date.now()>ws.bubble.expiresAt || !membersOf(instances.get(ws.bubble.instanceId)?.value,ws.bubble.uid).length){
        ws.close(1008,'Sessão expirou ou acesso revogado');continue;
      }
      authorize(ws.bubble.uid,ws.bubble.instanceId,true).catch(()=>ws.close(1008,'BDS offline ou sessão revogada'));
    }
  },10000);
  ticker.unref?.();
  function close(){clearInterval(ticker);for(const s of sockets)s.close();if(wss)wss.close();for(const e of instances.values())e.ref.off('value',e.listener);}
  return {handleHttp,attachWebSocket,close,stats:()=>({instances:instances.size,players:states.size})};
}
module.exports={createV2,createFromEnvironment};

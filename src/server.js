'use strict';
const http=require('node:http');
const {URL}=require('node:url');
const {BetaStore,problem,ROOM_RE}=require('./beta-core');

const VERSION='0.1.0-beta';
const PORT=Number(process.env.PORT||3000);
const DEFAULT_ROOM=process.env.BUBBLE_BETA_ROOM||'bubble-N001z';
const store=new BetaStore({
  defaultRoom:DEFAULT_ROOM,
  ttlMs:Number(process.env.BUBBLE_BETA_TTL_MS||3000),
  maxPlayers:Number(process.env.BUBBLE_BETA_MAX_PLAYERS||64),
  maxRooms:Number(process.env.BUBBLE_BETA_MAX_ROOMS||8),
  ratePerSec:Number(process.env.BUBBLE_BETA_RATE_PER_SEC||30)
});
const sockets=new Set();
let server;

function json(res,status,body) {
  const data=JSON.stringify(body);
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Content-Length':Buffer.byteLength(data),
    'Cache-Control':'no-store',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Headers':'Content-Type, Authorization',
    'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
  });res.end(data);
}
async function readBody(req){
  let size=0,chunks=[];
  for await (const c of req){size+=c.length;if(size>32768)throw problem('BODY_TOO_LARGE','Payload maior que 32 KiB.',413);chunks.push(c);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw problem('INVALID_JSON','Envie um JSON valido.');}
}
function eventForState(entry){
  return {type:'state',room:entry.room,instanceId:entry.room,
    serverId:entry.serverId,bdsId:entry.serverId,playerId:entry.playerId,
    name:entry.name,state:entry.state,updatedAt:entry.updatedAt,revision:entry.revision};
}
function send(ws,message){
  if(ws.readyState!==1 || ws.bufferedAmount>262144)return false;
  try{ws.send(JSON.stringify(message));return true;}catch{return false;}
}
function broadcast(message){
  for(const ws of sockets){
    if(ws.bubbleRoom===message.room)send(ws,message);
  }
}
function createHandler(){
  return async(req,res)=>{
    const url=new URL(req.url,'http://localhost'),path=url.pathname;
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET, POST, OPTIONS'});res.end();return;}
    try {
      if(req.method==='GET'&&path==='/')return json(res,200,{
        name:'Bubble API Beta',version:VERSION,authentication:'none',
        mode:'raw relay',room:store.defaultRoom,
        health:'/beta/healthz',players:`/beta/players?room=${store.defaultRoom}`,
        httpPublish:'/beta/state',httpEvent:'/beta/events',websocket:'/beta/live',
        websocketCompat:'/v2/live'
      });
      if(req.method==='GET'&&['/healthz','/beta/healthz','/v2/healthz'].includes(path)) {
        store.sweep();return json(res,200,{ok:true,name:'Bubble API Beta',version:VERSION,
          authentication:'none',firebase:false,rooms:store.roomsInfo(),
          connectedClients:sockets.size,totalPublished:store.totalPublished,
          totalEvents:store.totalEvents,uptimeSeconds:Math.floor(process.uptime())});
      }
      if(req.method==='GET'&&path==='/beta/rooms')return json(res,200,{rooms:store.roomsInfo()});
      if(req.method==='GET'&&path==='/beta/players'){
        const room=url.searchParams.get('room')||url.searchParams.get('instanceId')||store.defaultRoom;
        const lim=Number(url.searchParams.get('limit')||store.maxPlayers);
        if(!Number.isInteger(lim)||lim<1)throw problem('INVALID_LIMIT','limit invalido.');
        return json(res,200,store.players(room,lim));
      }
      if(req.method==='GET'&&path==='/beta/schema')return json(res,200,{
        version:VERSION,description:'A API nao espelha nem anima. Somente retransmite dados brutos.',
        publish:{method:'POST',path:'/beta/state',required:['playerId ou state.uniqueId','state.position','state.yRot ou state.rotation.yaw'],
          optional:['room','serverId','name','state.pitch','state.velocity','state.flags','state.item','state.animation','state.actions']},
        websocket:{url:'/beta/live',compat:'/v2/live',messages:['subscribe','auth (ignorado)','publish','event','ping'],received:['hello','ready','snapshot','ack','state','event','pong','error']}
      });
      if(req.method==='POST'&&['/beta/state','/beta/publish'].includes(path)){
        const entry=store.publish(await readBody(req));
        broadcast(eventForState(entry));
        return json(res,200,{ok:true,room:entry.room,playerId:entry.playerId,
          revision:entry.revision,updatedAt:entry.updatedAt,ttlMs:store.ttlMs});
      }
      if(req.method==='POST'&&path==='/beta/state/batch'){
        const body=await readBody(req);
        if(!Array.isArray(body.players)||body.players.length>32)throw problem('INVALID_BATCH','players deve conter ate 32 entradas.');
        const results=[];
        for(const player of body.players){
          const entry=store.publish({...player,room:player.room??body.room??body.instanceId??store.defaultRoom,
            serverId:player.serverId??player.bdsId??body.serverId??body.bdsId??'local-bds'});
          broadcast(eventForState(entry));
          results.push({playerId:entry.playerId,revision:entry.revision});
        }
        return json(res,200,{ok:true,count:results.length,players:results});
      }
      if(req.method==='POST'&&path==='/beta/events'){
        const evt=store.event(await readBody(req));
        broadcast(evt);
        return json(res,200,{ok:true,room:evt.room,receivedAt:evt.receivedAt});
      }
      return json(res,404,{error:{code:'NOT_FOUND',message:'Rota inexistente na Bubble Beta.'}});
    }catch(e){
      json(res,e.status||500,{error:{code:e.code||'INTERNAL_ERROR',message:e.status?e.message:'Erro interno.'}});
    }
  };
}
function attachWebSocket(server,WebSocketServer){
  const wss=new WebSocketServer({noServer:true,maxPayload:32768,clientTracking:false});
  server.on('upgrade',(req,socket,head)=>{
    let url;try{url=new URL(req.url,'http://localhost');}catch{socket.destroy();return;}
    if(!['/beta/live','/v2/live'].includes(url.pathname)){
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');socket.destroy();return;
    }
    if(sockets.size>=120){socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,ws=>{
      sockets.add(ws);
      const requested=url.searchParams.get('room');
      ws.bubbleRoom=requested&&ROOM_RE.test(requested)?requested:store.defaultRoom;
      const ready=()=>{
        send(ws,{type:'ready',room:ws.bubbleRoom,instanceId:ws.bubbleRoom,
          scope:'beta:open',authRequired:false,playerTtlMs:store.ttlMs});
        const snapshot=store.players(ws.bubbleRoom);
        send(ws,{type:'snapshot',room:ws.bubbleRoom,players:snapshot.players,count:snapshot.count});
      };
      send(ws,{type:'hello',protocol:'bubble-beta/1',authRequired:false,room:ws.bubbleRoom});
      ready();
      ws.on('message',raw=>{
        try{
          const data=JSON.parse(raw.toString());
          if(!data||typeof data!=='object')throw problem('INVALID_BODY','Objeto obrigatorio.');
          switch(data.type){
          case 'subscribe':
          case 'auth':{
            // Compatibility with BubbleBDSHost /v2/live: token ignored, no Firebase used.
            const room=data.room??data.instanceId??store.defaultRoom;
            if(typeof room!=='string'||!ROOM_RE.test(room))throw problem('INVALID_ROOM','room invalida.');
            ws.bubbleRoom=room;ready();return;
          }
          case 'publish':{
            const e=store.publish({...data,room:data.room??data.instanceId??ws.bubbleRoom});
            broadcast(eventForState(e));
            send(ws,{type:'ack',ok:true,room:e.room,instanceId:e.room,
              playerId:e.playerId,revision:e.revision,updatedAt:e.updatedAt,ttlMs:store.ttlMs});
            return;
          }
          case 'event':{
            const evt=store.event({...data,room:data.room??data.instanceId??ws.bubbleRoom});
            broadcast(evt);send(ws,{type:'ack',ok:true,event:evt.event.type,receivedAt:evt.receivedAt});return;
          }
          case 'ping': send(ws,{type:'pong',t:Date.now()});return;
          default: throw problem('UNKNOWN_ACTION','Use subscribe, publish, event ou ping.');
          }
        }catch(e){send(ws,{type:'error',code:e.code||'INVALID_JSON',message:e.status?e.message:'JSON invalido.'});}
      });
      ws.on('close',()=>sockets.delete(ws));
      ws.on('error',()=>sockets.delete(ws));
    });
  });
  return wss;
}
function start(){
  const {WebSocketServer}=require('ws');
  server=http.createServer(createHandler());
  attachWebSocket(server,WebSocketServer);
  const sweepTimer=setInterval(()=>store.sweep(),1000);sweepTimer.unref();
  server.listen(PORT,'0.0.0.0',()=>console.log(`[bubble-beta] v${VERSION} ready on ${PORT}; no Firebase, no tokens; room=${store.defaultRoom}`));
  return server;
}
if(require.main===module)start();
module.exports={createHandler,attachWebSocket,start,store,eventForState};

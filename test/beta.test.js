'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {BetaStore,normalize}=require('../src/beta-core');
const {createHandler}=require('../src/server');

test('Recebe querytarget bruto e preserva decimais/angulo sem espelhar',()=>{
  const x=1.920806288719177,y=68.62001037597656,z=-1.804710984230042,yRot=50.5970458984375;
  const p=normalize({instanceId:'bubble-N001z',bdsId:'bds1',playerId:'player-1',
    state:{dimension:1000,uniqueId:'player-1',id:-68719476716,position:{x,y,z},yRot}});
  assert.deepEqual(p.state.position,{x,y,z});
  assert.equal(p.state.yRot,yRot);
  assert.equal(p.state.dimension,1000);
  assert.equal(p.state.id,-68719476716);
  assert.equal(p.room,'bubble-N001z');
  assert.equal(p.serverId,'bds1');
});

test('Aceita campos de movimento, rotacao, item e acoes para o futuro addon',()=>{
  const s=new BetaStore({defaultRoom:'bubble-N001z'});
  const state={dimension:1000,position:{x:3.12,y:65,z:5.456},
    rotation:{yaw:35.25,pitch:-17.5},velocity:{x:0.03,y:0.2,z:-0.1},
    flags:{isSneaking:false,isSprinting:true,isJumping:true,isOnGround:false},
    item:{id:'minecraft:diamond_sword',slot:1},animation:'walk'};
  const entry=s.publish({serverId:'bds-local',playerId:'steve',state});
  assert.equal(entry.state.yRot,35.25);
  assert.equal(entry.state.pitch,-17.5);
  assert.deepEqual(entry.state.flags,state.flags);
  assert.deepEqual(entry.state.item,state.item);
  assert.equal(entry.state.animation,'walk');
  assert.equal(entry.state.position.x,3.12);
});

test('Isola salas, remove jogadores inativos e preserva estado ate TTL',()=>{
  let time=100000;
  const s=new BetaStore({now:()=>time,ttlMs:3000,maxRooms:2});
  s.publish({room:'bubble-N001z',serverId:'one',playerId:'steve',state:{position:{x:1,y:2,z:3},yRot:3}});
  s.publish({room:'bubble-N002z',serverId:'two',playerId:'alex',state:{position:{x:4,y:5,z:6},yRot:6}});
  assert.equal(s.players('bubble-N001z').count,1);
  assert.equal(s.players('bubble-N002z').players[0].playerId,'alex');
  time+=3001;
  assert.equal(s.players('bubble-N001z').count,0);
  assert.equal(s.players('bubble-N002z').count,0);
});

test('Recusa coordenadas inválidas, limita frequência e volume de salas',()=>{
  const s=new BetaStore({ratePerSec:2,maxRooms:1});
  const payload={room:'beta',playerId:'steve',state:{position:{x:1,y:2,z:3},yRot:4}};
  s.publish(payload);s.publish(payload);
  assert.throws(()=>s.publish(payload),e=>e.code==='RATE_LIMIT');
  assert.throws(()=>s.publish({...payload,room:'another'}),e=>e.code==='ROOM_LIMIT');
  assert.throws(()=>normalize({...payload,state:{position:{x:'one',y:2,z:3},yRot:4}}),e=>e.code==='INVALID_POSITION');
});

test('Eventos de quebrar, colocar e ataque permanecem brutos; API nao espelha',()=>{
  const s=new BetaStore();
  const e=s.event({playerId:'steve',room:'bubble-N001z',event:{type:'block_break',x:1,y:66,z:-4}});
  assert.equal(e.event.x,1);
  assert.equal(e.event.z,-4);
  assert.equal(e.type,'event');
});

test('Rotas HTTP GET/POST: publicar, consultar e diagnosticar sem token',async t=>{
  const server=http.createServer(createHandler());
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const status=await (await fetch(base+'/beta/healthz')).json();
  assert.equal(status.ok,true);
  assert.equal(status.authentication,'none');
  const response=await fetch(base+'/beta/state',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({room:'beta-test',playerId:'http-steve',state:{position:{x:1.255,y:64,z:2.75},yRot:123.5}})});
  assert.equal(response.status,200);
  assert.equal((await response.json()).playerId,'http-steve');
  const data=await (await fetch(base+'/beta/players?room=beta-test')).json();
  assert.equal(data.players[0].state.position.x,1.255);
  assert.equal(data.players[0].state.yRot,123.5);
  const schema=await (await fetch(base+'/beta/schema')).json();
  assert.equal(schema.websocket.url,'/beta/live');
  const bad=await fetch(base+'/beta/state',{method:'POST',headers:{'content-type':'application/json'},body:'bad-json'});
  assert.equal(bad.status,400);
});

test('WebSocket beta sem token: entra, publica e recebe eco (inclui protocolo app /v2/live)',async t=>{
  const {EventEmitter}=require('node:events');
  const {attachWebSocket}=require('../src/server');
  class Socket extends EventEmitter {
    constructor(){super();this.readyState=1;this.bufferedAmount=0;this.sent=[];}
    send(value){this.sent.push(JSON.parse(value));}
  }
  class WsServer {
    constructor(){}
    handleUpgrade(req,sock,head,callback){callback(sock);}
  }
  const httpServer=new EventEmitter();
  attachWebSocket(httpServer,WsServer);
  const oldApp=new Socket(), receptor=new Socket();
  httpServer.emit('upgrade',{url:'/v2/live'},oldApp,Buffer.alloc(0));
  oldApp.emit('message',Buffer.from(JSON.stringify({type:'auth',instanceId:'bubble-N001z',token:'ignored-firebase-token'})));
  httpServer.emit('upgrade',{url:'/beta/live'},receptor,Buffer.alloc(0));
  receptor.emit('message',Buffer.from(JSON.stringify({type:'subscribe',room:'bubble-N001z'})));
  assert.equal(oldApp.sent.some(x=>x.type==='ready'),true);
  assert.equal(receptor.sent.some(x=>x.type==='ready'&&x.authRequired===false),true);
  oldApp.emit('message',Buffer.from(JSON.stringify({type:'publish',instanceId:'bubble-N001z',bdsId:'my-bds',
    playerId:'player-one',state:{dimension:1000,position:{x:1.42,y:68.5,z:-3.25},yRot:37.7}})));
  assert.equal(oldApp.sent.some(x=>x.type==='ack'),true);
  assert.equal(receptor.sent.some(x=>x.type==='state'&&x.state.position.x===1.42),true);
  // Same-server echo is deliberately enabled: needed when user has only one phone.
  assert.equal(oldApp.sent.some(x=>x.type==='state'&&x.playerId==='player-one'),true);
  assert.equal(receptor.sent.some(x=>x.type==='error'),false);
  oldApp.emit('close');receptor.emit('close');
});

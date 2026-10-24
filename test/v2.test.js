'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {EventEmitter}=require('node:events');
const core=require('../src/bubble-v2-core');
const {createV2}=require('../src/bubble-v2');

const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';

function fakeDb(data){
  const listeners=new Map();
  function at(path){return path.split('/').filter(Boolean).reduce((o,p)=>o?.[p],data);}
  function clone(v){return v==null?v:structuredClone(v);}
  return {
    ref(path){return {
      get:async()=>({val:()=>clone(at(path))}),
      on(event,handler){
        const a=listeners.get(path)||[];a.push(handler);listeners.set(path,a);
        queueMicrotask(()=>handler({val:()=>clone(at(path))}));
      },
      off(event,handler){listeners.set(path,(listeners.get(path)||[]).filter(h=>h!==handler));}
    };},
    emit(path){for(const fn of listeners.get(path)||[])fn({val:()=>clone(at(path))});},
    data
  };
}
async function setup(){
  const data={bubble:{
    bds:{uid_1:{online:true,instanceId:'bubble-N001z',manifestId:'cidade',lastSeen:Date.now()},
      uid_2:{online:true,instanceId:'bubble-N002z',manifestId:'cidade',lastSeen:Date.now()},
      uid_3:{online:true,instanceId:'bubble-N001z',manifestId:'cidade',lastSeen:Date.now()}},
    manifests:{cidade:{enabled:true,numericDimensionId:1000,revision:1,maxRemoteHologramsPerBds:8}},
    instances:{'bubble-N001z':{manifestId:'cidade',status:'open',members:{uid_1:{[A]:true},uid_3:{[B]:true}}},
      'bubble-N002z':{manifestId:'cidade',status:'open',members:{uid_2:{[B]:true}}}}
  }};
  const db=fakeDb(data);
  const v2=createV2({db,verifyIdToken:async token=>{
    if(token==='firebase-id-token-for-uid-1')return {uid:'uid_1',exp:Math.floor(Date.now()/1000)+3600};
    if(token==='firebase-id-token-for-uid-2')return {uid:'uid_2',exp:Math.floor(Date.now()/1000)+3600};
    if(token==='firebase-id-token-for-uid-3')return {uid:'uid_3',exp:Math.floor(Date.now()/1000)+3600};
    throw Error('token invalid');
  },WebSocketServer:FakeWss});
  const server=http.createServer((req,res)=>v2.handleHttp(req,res));
  v2.attachWebSocket(server);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function call(method,path,token='firebase-id-token-for-uid-1',body){
    const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    return {status:r.status,result:await r.json()};
  }
  return {data,db,v2,server,call,async close(){v2.close();await new Promise(res=>server.close(res));}};
}
class FakeSocket extends EventEmitter {
  constructor(){super();this.readyState=1;this.bufferedAmount=0;this.sent=[];}
  send(s){this.sent.push(JSON.parse(s));}
  close(){this.readyState=3;this.emit('close');}
}
class FakeWss {
  constructor(){}
  handleUpgrade(req,sock,head,cb){cb(sock);}
  close(){}
}
const soon=()=>new Promise(resolve=>setTimeout(resolve,25));
test('IDs reais, limites e payload básico são validados',()=>{
  assert.equal(core.validInstanceId('bubble-N001z'),true);
  assert.equal(core.validInstanceId('../danger'),false);
  assert.equal(core.belongs({members:{uid_1:{[A]:true},uid_3:{[B]:true}}},'uid_1',A),true);
  assert.equal(core.belongs({members:{uid_1:{[A]:true},uid_3:{[B]:true}}},'uid_2',A),false);
  assert.equal(core.normalizeState({instanceId:'bubble-N001z',bdsId:'uid_1',playerId:A,
    state:{dimension:1000,uniqueId:A,id:-68719476716,position:{x:1.5,y:68,z:-2.5},yRot:50.5}},1000).state.position.x,1.5);
  assert.throws(()=>core.normalizeState({instanceId:'bubble-N001z',bdsId:'uid_1',playerId:A,
    state:{dimension:0,position:{x:1,y:2,z:3},yRot:1}},1000),/dimensão/);
});
test('só membros autorizados consultam e publicam posições',async t=>{
  const f=await setup(); t.after(()=>f.close());
  const player={instanceId:'bubble-N001z',bdsId:'uid_1',playerId:A,
    state:{dimension:1000,id:-68719476716,uniqueId:A,position:{x:1.5,y:68.5,z:-2.25},yRot:50.6}};
  assert.equal((await f.call('POST','/v2/state/publish','firebase-id-token-for-uid-1',player)).status,200);
  const self=await f.call('GET','/v2/instances/bubble-N001z/players?include_self=1');
  assert.equal(self.status,200);
  assert.equal(self.result.players[0].position.x,1.5);
  assert.equal((await f.call('GET','/v2/instances/bubble-N001z/players','firebase-id-token-for-uid-2')).status,403);
  assert.equal((await f.call('GET','/v2/instances/bubble-N002z/players','firebase-id-token-for-uid-1')).status,403);
  assert.equal((await f.call('POST','/v2/state/publish','firebase-id-token-for-uid-2',player)).status,403);
  assert.equal((await f.call('POST','/v2/state/publish','firebase-id-token-for-uid-1',{...player,playerId:B,
    state:{...player.state,uniqueId:B}})).status,403);
  assert.equal((await f.call('GET','/v2/instances/bubble-N001z/members')).result.count,2);
  assert.equal((await f.call('GET','/v2/instances/bubble-N001z/manifest')).result.manifest.numericDimensionId,1000);
  const grant=await f.call('POST','/v2/access/grant','firebase-id-token-for-uid-1',{instanceId:'bubble-N001z'});
  assert.equal(grant.status,200);assert.equal(grant.result.scope,'instance:read');
  const noAuth=await f.call('GET','/v2/instances/bubble-N001z/players','invalid');
  assert.equal(noAuth.status,401);
  // On value removes player -> immediately expunges RAM cache.
  f.data.bubble.instances['bubble-N001z'].members={};
  f.db.emit('bubble/instances/bubble-N001z');
  assert.equal((await f.call('GET','/v2/instances/bubble-N001z/players?include_self=1')).status,403);
});

test('WebSocket só recebe estados da própria instância e token de receptor não publica',async t=>{
  const f=await setup();t.after(()=>f.close());
  const listener=new FakeSocket();
  f.server.emit('upgrade',{url:'/v2/live'},listener,Buffer.alloc(0));
  listener.emit('message',Buffer.from(JSON.stringify({type:'auth',instanceId:'bubble-N001z',token:'firebase-id-token-for-uid-3'})));
  await soon();
  assert.equal(listener.sent.find(x=>x.type==='ready')?.scope,'instance:readwrite');
  const outsider=new FakeSocket();
  f.server.emit('upgrade',{url:'/v2/live'},outsider,Buffer.alloc(0));
  outsider.emit('message',Buffer.from(JSON.stringify({type:'auth',instanceId:'bubble-N002z',token:'firebase-id-token-for-uid-2'})));
  await soon();
  const player={instanceId:'bubble-N001z',bdsId:'uid_1',playerId:A,state:{dimension:1000,uniqueId:A,position:{x:0,y:68,z:0},yRot:50}};
  assert.equal((await f.call('POST','/v2/state/publish','firebase-id-token-for-uid-1',player)).status,200);
  await soon();
  assert.equal(listener.sent.filter(x=>x.type==='state').length,1);
  assert.equal(outsider.sent.filter(x=>x.type==='state').length,0);
  const grant=await f.call('POST','/v2/access/grant','firebase-id-token-for-uid-3',{instanceId:'bubble-N001z'});
  const readonly=new FakeSocket();
  f.server.emit('upgrade',{url:'/v2/live'},readonly,Buffer.alloc(0));
  readonly.emit('message',Buffer.from(JSON.stringify({type:'auth',instanceId:'bubble-N001z',token:grant.result.token})));
  await soon();
  assert.equal(readonly.sent.find(x=>x.type==='ready')?.scope,'instance:read');
  readonly.emit('message',Buffer.from(JSON.stringify({type:'publish',...player})));
  await soon();
  assert.equal(readonly.sent.find(x=>x.type==='error')?.code,'READ_ONLY');
});

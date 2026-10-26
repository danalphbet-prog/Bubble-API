'use strict';

// Bubble Beta: no Firebase, no credentials, no XYZ persistence.
// The server is TRANSPORT ONLY. Mirroring, GameTest and animations belong to addons.

const ROOM_RE = /^[A-Za-z0-9_-]{1,80}$/;
const ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;

function problem(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
function n(value) { return typeof value === 'number' && Number.isFinite(value); }
function copy(o) { return JSON.parse(JSON.stringify(o)); }

function normalize(body, defaultRoom = 'bubble-N001z') {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw problem('INVALID_BODY', 'Objeto JSON obrigatorio.');
  const room = body.room ?? body.instanceId ?? defaultRoom;
  const serverId = body.serverId ?? body.bdsId ?? 'local-bds';
  const state = body.state ?? body;
  const playerId = body.playerId ?? state.uniqueId ?? (state.id == null ? undefined : String(state.id));
  if (typeof room !== 'string' || !ROOM_RE.test(room)) throw problem('INVALID_ROOM','room invalida.');
  if (typeof serverId !== 'string' || !ID_RE.test(serverId)) throw problem('INVALID_SERVER','serverId invalido.');
  if (typeof playerId !== 'string' || !ID_RE.test(playerId)) throw problem('INVALID_PLAYER','playerId/uniqueId invalido.');
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw problem('INVALID_STATE','state precisa ser objeto.');
  const p = state.position;
  if (!p || !n(p.x) || !n(p.y) || !n(p.z) ||
      Math.abs(p.x)>3e7 || Math.abs(p.z)>3e7 || Math.abs(p.y)>1e6)
    throw problem('INVALID_POSITION','position deve conter x,y,z decimais finitos.');
  const yaw = state.yRot ?? state.rotation?.yaw ?? state.rotation?.y;
  if (!n(yaw) || Math.abs(yaw)>36000) throw problem('INVALID_YAW','yRot ou rotation.yaw obrigatorio.');
  const pitch = state.pitch ?? state.rotation?.pitch ?? state.rotation?.x;
  if (pitch !== undefined && (!n(pitch) || Math.abs(pitch)>36000)) throw problem('INVALID_PITCH','pitch invalido.');
  if (state.dimension != null && (!Number.isSafeInteger(state.dimension) || Math.abs(state.dimension)>1000000))
    throw problem('INVALID_DIMENSION','dimension deve ser inteiro.');
  if (state.velocity != null) {
    const v = state.velocity;
    if (typeof v !== 'object' || !n(v.x) || !n(v.y) || !n(v.z))
      throw problem('INVALID_VELOCITY','velocity invalida.');
  }
  if (state.flags != null && (typeof state.flags!=='object' || Array.isArray(state.flags)))
    throw problem('INVALID_FLAGS','flags precisa ser objeto.');
  if (body.name != null && (typeof body.name!=='string' || body.name.length>64))
    throw problem('INVALID_NAME','name deve ter no maximo 64 caracteres.');
  // Keep all optional action/pose/item fields unchanged; NEVER mirror any coordinate here.
  // Build a copy so another caller cannot mutate a stored state after publishing.
  const clean = copy(state);
  clean.position = { x:p.x, y:p.y, z:p.z };
  clean.yRot = yaw;
  if (pitch !== undefined) clean.pitch = pitch;
  return {room, serverId, playerId, name: body.name ?? state.name ?? null, state:clean};
}

class BetaStore {
  constructor(options={}) {
    this.ttlMs=options.ttlMs ?? 3000;
    this.maxPlayers=options.maxPlayers ?? 64;
    this.maxRooms=options.maxRooms ?? 8;
    this.ratePerSec=options.ratePerSec ?? 30;
    this.defaultRoom=options.defaultRoom ?? 'bubble-N001z';
    this.now=options.now ?? Date.now;
    this.rooms=new Map();
    this.rate=new Map();
    this.revisions=new Map();
    this.totalPublished=0;
    this.totalEvents=0;
  }
  sweep() {
    const t=this.now();
    for (const [room,players] of this.rooms) {
      for (const [key,item] of players) if(t-item.updatedAt>this.ttlMs)players.delete(key);
      if (!players.size) this.rooms.delete(room);
    }
    for (const [key,bucket] of this.rate) if(t-bucket.start>3000)this.rate.delete(key);
    for (const [key,rev] of this.revisions) if(t-rev.seen>60000)this.revisions.delete(key);
  }
  allow(key) {
    const now=this.now();
    let b=this.rate.get(key);
    if(!b || now-b.start>=1000){this.rate.set(key,{start:now,count:1});return true;}
    if(b.count>=this.ratePerSec)return false;
    b.count++;return true;
  }
  publish(body){
    const p=normalize(body,this.defaultRoom);
    this.sweep();
    let room=this.rooms.get(p.room);
    if(!room){
      if(this.rooms.size>=this.maxRooms)throw problem('ROOM_LIMIT','Limite de salas beta atingido.',429);
      room=new Map();this.rooms.set(p.room,room);
    }
    const key=`${p.serverId}|${p.playerId}`;
    if(!this.allow(`${p.room}|${key}`))throw problem('RATE_LIMIT','Muitas atualizacoes deste jogador.',429);
    if(!room.has(key) && room.size>=this.maxPlayers){
      let oldestKey,oldestTime=Infinity;
      for(const [k,v] of room)if(v.updatedAt<oldestTime){oldestKey=k;oldestTime=v.updatedAt;}
      room.delete(oldestKey);
    }
    const updatedAt=this.now();
    const revision=(this.revisions.get(`${p.room}|${key}`)?.value ?? 0)+1;
    this.revisions.set(`${p.room}|${key}`,{value:revision,seen:updatedAt});
    const entry={...p,updatedAt,revision};
    room.set(key,entry);
    this.totalPublished++;
    return entry;
  }
  players(room=this.defaultRoom,limit=this.maxPlayers) {
    if (!ROOM_RE.test(room))throw problem('INVALID_ROOM','room invalida.');
    this.sweep();
    const all=[...(this.rooms.get(room)?.values() ?? [])].sort((a,b)=>b.updatedAt-a.updatedAt);
    return {room,count:all.length,players:all.slice(0,Math.min(this.maxPlayers,Math.max(1,limit))).map(copy),serverTime:this.now(),ttlMs:this.ttlMs};
  }
  roomsInfo(){
    this.sweep();
    return [...this.rooms].map(([id,players])=>({room:id,players:players.size}));
  }
  event(body){
    if (!body || typeof body!=='object')throw problem('INVALID_BODY','Objeto JSON obrigatorio.');
    const room=body.room??body.instanceId??this.defaultRoom;
    const serverId=body.serverId??body.bdsId??'local-bds';
    const playerId=body.playerId;
    const evt=body.event;
    if(typeof room!=='string'||!ROOM_RE.test(room))throw problem('INVALID_ROOM','room invalida.');
    if(typeof serverId!=='string'||!ID_RE.test(serverId))throw problem('INVALID_SERVER','serverId invalido.');
    if(typeof playerId!=='string'||!ID_RE.test(playerId))throw problem('INVALID_PLAYER','playerId invalido.');
    if(!evt||typeof evt!=='object'||Array.isArray(evt)||typeof evt.type!=='string'||!/^[a-z][a-z0-9_-]{1,31}$/i.test(evt.type))
      throw problem('INVALID_EVENT','event.type deve ser texto simples.');
    if(!this.allow(`event|${room}|${serverId}|${playerId}`))throw problem('RATE_LIMIT','Muitos eventos deste jogador.',429);
    this.totalEvents++;
    return {type:'event',room,instanceId:room,serverId,bdsId:serverId,playerId,event:copy(evt),receivedAt:this.now()};
  }
}
module.exports={normalize,BetaStore,problem,ROOM_RE};

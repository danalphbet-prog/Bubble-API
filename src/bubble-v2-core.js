'use strict';

const INSTANCE_RE = /^bubble-[A-Za-z0-9_-]{1,72}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PLAYER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validInstanceId(id) { return typeof id === 'string' && INSTANCE_RE.test(id); }
function validUid(id) { return typeof id === 'string' && UID_RE.test(id); }
function validPlayerId(id) { return typeof id === 'string' && PLAYER_RE.test(id); }
function membersOf(instance, uid) {
  const group = instance?.members?.[uid];
  if (!group || typeof group !== 'object' || Array.isArray(group)) return [];
  return Object.keys(group).filter(key => validPlayerId(key) && group[key] === true);
}
function belongs(instance, uid, playerId) {
  return membersOf(instance, uid).includes(playerId.toLowerCase());
}
function isFiniteNumber(x) { return typeof x === 'number' && Number.isFinite(x); }
function normalizeState(body, expectedDimension) {
  const instanceId = body?.instanceId;
  const bdsId = body?.bdsId;
  const playerId = body?.playerId;
  const input = body?.state;
  if (!validInstanceId(instanceId)) throw bad('INVALID_INSTANCE', 'instanceId inválido.', 400);
  if (!validUid(bdsId)) throw bad('INVALID_BDS', 'bdsId inválido.', 400);
  if (!validPlayerId(playerId)) throw bad('INVALID_PLAYER', 'playerId deve ser UUID.', 400);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('INVALID_STATE', 'state obrigatório.', 400);
  const p = input.position;
  if (!p || ![p.x,p.y,p.z].every(isFiniteNumber) ||
      Math.abs(p.x)>3e7 || Math.abs(p.z)>3e7 || Math.abs(p.y)>1e6) {
    throw bad('INVALID_POSITION', 'XYZ inválidos.', 400);
  }
  if (!Number.isSafeInteger(input.dimension) || input.dimension !== expectedDimension) {
    throw bad('WRONG_DIMENSION', 'Jogador não está na dimensão do manifesto.', 409);
  }
  if (!isFiniteNumber(input.yRot) || Math.abs(input.yRot)>36000) throw bad('INVALID_ROTATION', 'yRot inválido.', 400);
  if (input.uniqueId != null && String(input.uniqueId).toLowerCase() !== playerId.toLowerCase()) {
    throw bad('ID_MISMATCH', 'uniqueId não corresponde a playerId.', 400);
  }
  if (input.id != null && !Number.isSafeInteger(input.id) &&
    !(typeof input.id === 'string' && /^-?\d{1,20}$/.test(input.id))) {
    throw bad('INVALID_ENTITY_ID', 'id de entidade inválido.', 400);
  }
  const normalized = {
    dimension: input.dimension,
    uniqueId: playerId.toLowerCase(),
    position: {x:p.x,y:p.y,z:p.z},
    yRot: input.yRot
  };
  if (input.id != null) normalized.id=input.id;
  if (input.pitch != null) {
    if (!isFiniteNumber(input.pitch) || Math.abs(input.pitch)>36000) throw bad('INVALID_PITCH', 'pitch inválido.',400);
    normalized.pitch=input.pitch;
  }
  return {instanceId,bdsId,playerId:playerId.toLowerCase(),state:normalized};
}
function bad(code,message,status=400){return Object.assign(new Error(message),{code,status});}
function listMembers(instance){
  const out=[];
  for(const [bdsId,group] of Object.entries(instance?.members||{})){
    if(!validUid(bdsId) || !group || typeof group!=='object')continue;
    for(const playerId of Object.keys(group))if(group[playerId]===true && validPlayerId(playerId))out.push({bdsId,playerId});
  }
  return out;
}
function selectPlayers(stateMap,instanceId,ownBdsId,ttlMs,limit,includeSelf=false){
  const t=Date.now();
  const matches=[];
  for(const p of stateMap.values()){
    if(p.instanceId!==instanceId || (!includeSelf && p.bdsId===ownBdsId) || t-p.updatedAt>ttlMs)continue;
    matches.push(p);
  }
  matches.sort((a,b)=>b.updatedAt-a.updatedAt);
  return {count:matches.length,players:matches.slice(0,limit).map(p=>({bdsId:p.bdsId,playerId:p.playerId,...p.state,updatedAt:p.updatedAt}))};
}
module.exports={validInstanceId,validUid,validPlayerId,membersOf,belongs,normalizeState,bad,listMembers,selectPlayers};

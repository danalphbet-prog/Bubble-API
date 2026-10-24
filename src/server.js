'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const {createFromEnvironment} = require('./bubble-v2');
const bubbleV2 = createFromEnvironment();

const cfg = {
  port: Number(process.env.PORT || 3000),
  pollMs: Number(process.env.BUBBLE_POLL_MS || 200),
  playerTtlMs: Number(process.env.BUBBLE_PLAYER_TTL_MS || 2500),
  sessionTtlMs: Number(process.env.BUBBLE_SESSION_TTL_MS || 60000),
  heartbeatMs: Number(process.env.BUBBLE_HEARTBEAT_MS || 10000),
  tokenTtlMs: Number(process.env.BUBBLE_TOKEN_TTL_MS || 1800000),
  aoiRadiusBu: Number(process.env.BUBBLE_AOI_RADIUS_BU || 96),
  maxRemotes: Number(process.env.BUBBLE_MAX_REMOTES || 64),
  syncRatePerSec: Number(process.env.BUBBLE_SYNC_RATE_PER_SEC || 15),
  registerRatePerMin: Number(process.env.BUBBLE_REGISTER_RATE_PER_MIN || 30),
  adminKey: process.env.BUBBLE_ADMIN_KEY || ''
};

function parseServerKeys() {
  const raw = process.env.BUBBLE_SERVER_KEYS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (err) {
      console.error('[config] invalid BUBBLE_SERVER_KEYS JSON:', err.message);
    }
  }
  const fallback = process.env.BUBBLE_SERVER_KEY;
  return fallback ? { '*': fallback } : {};
}

const serverKeys = parseServerKeys();
const sessions = new Map();
const bubblePlayers = new Map();
const rateBuckets = new Map();
let globalTick = 0;
// Alfabeto compartilhado (v1): os dois add-ons possuem a mesma tabela.
const ANIMS = [
  'idle','walk','sprint','sneak','jump','fall','fly','swim',
  'attack','break','place','glide','climb','use','hurt','dead',
  'ride','sleep','crawl','shield','bow','eat','teleport','other'
];
const FLAG_SPRINT=1, FLAG_SNEAK=2, FLAG_JUMP=4, FLAG_GROUND=8;
const FLAG_FLY=16, FLAG_SWIM=32, FLAG_ATTACK=64, FLAG_BREAK=128, FLAG_PLACE=256;

const bubbles = new Map([
  ['n25', {
    bubble_id: 'n25',
    nid: 'bubble:n25',
    uid: '4bd7b6d8-6945-4d60-8cf2-19b6f5c7f025',
    name: 'N25',
    type: 'shared_space',
    world_type: 'shared_dimension',
    protocol: 'bubble/1',
    manifest_version: 2,
    seed: 250064,
    generator_version: 'bubble-gen/1',
    coordinate_system: {
      unit: 'BU',
      axes: { x: 'east-west', y: 'vertical', z: 'north-south' },
      origin_mode: 'bubble-local',
      bedrock: { blocks_per_bu: 1, transform: 'identity' },
      roblox: { status: 'reserved-for-later', studs_per_bu: 1 }
    },
    bounds: {
      origin: [0, 0, 0],
      size: [64, 32, 64],
      horizontal_limit: [256, 256],
      height_policy: 'manifest-defined'
    },
    spawn_position: [32, 2, 32],
    chunk_size_bu: 16,
    game_mode: 'adventure',
    max_players: 64,
    persistent: false,
    rules: {
      bubble_mode: true,
      native_build: false,
      native_break: false,
      native_inventory: false,
      pvp: false,
      creative: false
    },
    portals: []
  }]
]);

function now() { return Date.now(); }
function makeId(prefix) { return `${prefix}_${crypto.randomBytes(12).toString('hex')}`; }
function makeToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashToken(v) { return crypto.createHash('sha256').update(v).digest('hex'); }
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}
function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function fail(res, status, code, message, details) {
  return json(res, status, { error: { code, message, ...(details ? { details } : {}) } });
}
function getIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return String(Array.isArray(xf) ? xf[0] : (xf || req.socket.remoteAddress || 'unknown')).split(',')[0].trim();
}
function bucketAllow(key, limit, windowMs) {
  const t = now();
  const b = rateBuckets.get(key);
  if (!b || t >= b.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: t + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count++;
  return true;
}
function timingSafeEqualText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function expectedServerKey(serverId) { return serverKeys[serverId] || serverKeys['*'] || null; }
function publicSession(s) {
  return {
    session_id: s.session_id,
    server_id: s.server_id,
    instance_id: s.instance_id,
    platform: s.platform,
    created_at: s.created_at,
    last_seen_at: s.last_seen_at,
    joined_bubbles: [...s.joined_bubbles]
  };
}
async function readJson(req) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw Object.assign(new Error('Body too large'), { status: 413, code: 'BODY_TOO_LARGE' });
    parts.push(chunk);
  }
  if (parts.length === 0) return {};
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw Object.assign(new Error('Malformed JSON body.'), { status: 400, code: 'INVALID_JSON' }); }
}
function authenticate(req, res) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) { fail(res, 401, 'AUTH_REQUIRED', 'Bearer session token required.'); return null; }
  const presentedHash = hashToken(m[1]);
  const t = now();
  for (const s of sessions.values()) {
    if (s.token_hash !== presentedHash) continue;
    if (t > s.token_expires_at) { fail(res, 401, 'TOKEN_EXPIRED', 'Session token expired. Register again.'); return null; }
    if (t - s.last_seen_at > cfg.sessionTtlMs) { fail(res, 401, 'SESSION_STALE', 'Session expired by inactivity. Register again.'); return null; }
    s.last_seen_at = t;
    return s;
  }
  fail(res, 401, 'INVALID_TOKEN', 'Invalid session token.');
  return null;
}
function getBubble(id, res) {
  const b = bubbles.get(id);
  if (!b) { fail(res, 404, 'BUBBLE_NOT_FOUND', 'Bubble not found.'); return null; }
  return b;
}
function requireJoin(session, bubbleId, res) {
  if (!session.joined_bubbles.has(bubbleId)) { fail(res, 403, 'JOIN_REQUIRED', 'Join this Bubble before using this route.'); return false; }
  return true;
}
function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function validatePlayerState(bubble, body) {
  const p = body?.player;
  if (!p || typeof p !== 'object') return 'player object required.';
  if (typeof p.id !== 'string' || !p.id || p.id.length > 128) return 'player.id must be a non-empty string up to 128 chars.';
  if (!Array.isArray(p.position) || p.position.length !== 3 || !p.position.every(isFiniteNum)) return 'player.position must be [x,y,z] finite numbers.';
  if (!p.rotation || !isFiniteNum(p.rotation.yaw) || !isFiniteNum(p.rotation.pitch)) return 'player.rotation must contain finite yaw and pitch.';
  if (p.animation != null && (typeof p.animation !== 'string' || p.animation.length > 64)) return 'player.animation must be a string up to 64 chars.';
  if (p.name != null && (typeof p.name !== 'string' || p.name.length > 64)) return 'player.name must be a string up to 64 chars.';
  const [x,y,z] = p.position, [ox,oy,oz] = bubble.bounds.origin, [sx,sy,sz] = bubble.bounds.size;
  if (x < ox || x > ox+sx || y < oy || y > oy+sy || z < oz || z > oz+sz) return 'player.position is outside Bubble bounds.';
  return null;
}
function validateCompact(bubble, body) {
  if (body?.v !== 1 || !body.s || typeof body.s !== 'object' || Array.isArray(body.s)) return 'Expected {v:1,s:{...}}.';
  const s=body.s;
  if (typeof s.i !== 'string' || !s.i || s.i.length>128) return 's.i must be an ID up to 128 chars.';
  if (s.n != null && (typeof s.n!=='string'||s.n.length>64)) return 's.n must be a name up to 64 chars.';
  if (!Array.isArray(s.p)||s.p.length!==3||!s.p.every(isFiniteNum)) return 's.p must be [x,y,z].';
  if (!Array.isArray(s.r)||s.r.length!==2||!s.r.every(isFiniteNum)) return 's.r must be [yaw,pitch].';
  if (!Number.isInteger(s.a)||s.a<0||s.a>=ANIMS.length) return 's.a must be an animation code 0..23.';
  if (!Number.isInteger(s.f)||s.f<0||s.f>511) return 's.f must be a flag bitmask 0..511.';
  if (!Number.isInteger(s.d)||s.d<0||s.d>255) return 's.d must be a dimension code 0..255.';
  if (!Number.isSafeInteger(s.q)||s.q<0) return 's.q must be a nonnegative sequence.';
  const [x,y,z]=s.p,[ox,oy,oz]=bubble.bounds.origin,[sx,sy,sz]=bubble.bounds.size;
  if(x<ox||x>ox+sx||y<oy||y>oy+sy||z<oz||z>oz+sz) return 's.p outside Bubble bounds.';
  return null;
}
function flagsFromBits(f) {
  return {sprinting:!!(f&FLAG_SPRINT),sneaking:!!(f&FLAG_SNEAK),
    jumping:!!(f&FLAG_JUMP),grounded:!!(f&FLAG_GROUND),
    flying:!!(f&FLAG_FLY),swimming:!!(f&FLAG_SWIM),
    attacking:!!(f&FLAG_ATTACK),breaking:!!(f&FLAG_BREAK),placing:!!(f&FLAG_PLACE)};
}
function bitsFromFlags(f={}) {
  return (f.sprinting?FLAG_SPRINT:0)|(f.sneaking?FLAG_SNEAK:0)|
    (f.jumping?FLAG_JUMP:0)|(f.grounded!==false?FLAG_GROUND:0)|
    (f.flying?FLAG_FLY:0)|(f.swimming?FLAG_SWIM:0)|
    (f.attacking?FLAG_ATTACK:0)|(f.breaking?FLAG_BREAK:0)|(f.placing?FLAG_PLACE:0);
}
function compactRecord(p) {
  const a=Number.isInteger(p.anim_id)?p.anim_id:Math.max(0,ANIMS.indexOf(p.animation));
  return {i:p.player_id,p:p.position,r:[p.rotation.yaw,p.rotation.pitch],
    a,f:bitsFromFlags(p.flags),d:p.dimension_code??3,q:p.sequence??p.revision};
}
function distanceSq(a,b) { const x=a[0]-b[0], y=a[1]-b[1], z=a[2]-b[2]; return x*x+y*y+z*z; }
function storeForBubble(id) {
  let m = bubblePlayers.get(id);
  if (!m) { m = new Map(); bubblePlayers.set(id, m); }
  return m;
}
function removeSessionPlayers(session, bubbleId=null) {
  const removed=[];
  for (const [bid,players] of bubblePlayers) {
    if (bubbleId && bid !== bubbleId) continue;
    for (const [pid,p] of players) if (p.session_id === session.session_id) { players.delete(pid); removed.push({bubble_id:bid,player_id:pid}); }
  }
  return removed;
}
function cleanup() {
  const t=now();
  for (const [bid,players] of bubblePlayers) {
    for (const [pid,p] of players) if (t-p.updated_at > cfg.playerTtlMs) players.delete(pid);
    if (!players.size) bubblePlayers.delete(bid);
  }
  for (const [sid,s] of sessions) if (t-s.last_seen_at > cfg.sessionTtlMs || t>s.token_expires_at) { removeSessionPlayers(s); sessions.delete(sid); }
}
setInterval(cleanup, Math.max(1000, Math.min(cfg.playerTtlMs, cfg.sessionTtlMs)/2)).unref();

const openapi = {
  openapi:'3.1.0',
  info:{title:'Bubble API MVP',version:'1.3.0',description:'Bedrock-first Bubble shared-state API over HTTP polling and compact numeric state.'},
  paths:{
    '/healthz':{get:{summary:'Health check'}},
    '/v2/healthz':{get:{summary:'Firebase v2 status (no secret)'}},
    '/v2/state/publish':{post:{summary:'Publish BDS player state; Firebase token + membership required'}},
    '/v2/access/grant':{post:{summary:'Create short-lived read-only WebSocket token'}},
    '/v2/instances/{instanceId}/players':{get:{summary:'Get live player states of authorized instance'}},
    '/v2/instances/{instanceId}/members':{get:{summary:'Get Firebase membership IDs of authorized instance'}},
    '/v2/instances/{instanceId}/manifest':{get:{summary:'Read Firebase manifest of authorized instance'}},
    '/v1/sessions/register':{post:{summary:'Register BDS and obtain temporary token'}},
    '/v1/sessions/heartbeat':{post:{summary:'Keep session alive'}},
    '/v1/sessions/{session_id}':{delete:{summary:'Close current session'}},
    '/v1/bubbles':{get:{summary:'List Bubbles'}},
    '/v1/bubbles/{bubble_id}':{get:{summary:'Bubble detail'}},
    '/v1/bubbles/{bubble_id}/manifest':{get:{summary:'Authoritative manifest'}},
    '/v1/bubbles/{bubble_id}/chunks/{cx}/{cz}':{get:{summary:'Deterministic chunk metadata'}},
    '/v1/bubbles/{bubble_id}/join':{post:{summary:'Join Bubble'}},
    '/v1/bubbles/{bubble_id}/leave':{post:{summary:'Leave Bubble'}},
    '/v1/bubbles/{bubble_id}/sync':{post:{summary:'Publish local movement and receive remote players'}},
    '/v1/bubbles/{bubble_id}/sync-compact':{post:{summary:'Numeric Bubble Link protocol v1: {v:1,s:{i,p,r,a,f,d,q}}'}},
    '/v1/bubbles/{bubble_id}/snapshot':{get:{summary:'Admin/debug snapshot'}}
  }
};

async function handler(req,res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method || 'GET';
  try {
    if (path.startsWith('/v2/')) {
      if (!bubbleV2) return fail(res,503,'V2_DISABLED','Configure BUBBLE_V2_ENABLED=true no Render.');
      if (await bubbleV2.handleHttp(req,res,url)) return;
    }
    if (method==='GET' && path==='/') return json(res,200,{service:'Bubble API MVP',version:'1.3.0',protocol:'bubble/1',mode:'bedrock-first-http-polling',docs:'/docs',health:'/healthz'});
    if (method==='GET' && path==='/healthz') {
      cleanup();
      return json(res,200,{ok:true,service:'bubble-api-mvp',version:'1.3.0',uptime_sec:Math.floor(process.uptime()),sessions:sessions.size,bubbles:bubbles.size,players:[...bubblePlayers.values()].reduce((n,m)=>n+m.size,0),time:new Date().toISOString()});
    }
    if (method==='GET' && path==='/openapi.json') return json(res,200,openapi);
    if (method==='GET' && path==='/docs') return html(res,200,`<!doctype html><html><head><meta charset="utf-8"><title>Bubble API MVP</title><style>body{font-family:system-ui;background:#111;color:#eee;max-width:900px;margin:40px auto;padding:0 20px}code,pre{background:#1d1d1d;padding:3px 6px;border-radius:6px}a{color:#ff6b6b}</style></head><body><h1>Bubble API MVP v1.3.0</h1><p>Bedrock-first shared Bubble state over HTTP polling (compact + legacy).</p><p><a href="/openapi.json">OpenAPI JSON</a> · <a href="/healthz">Health</a></p><pre>register → join → sync-compact ~${cfg.pollMs}ms → leave → close session</pre></body></html>`);

    if (method==='POST' && path==='/v1/sessions/register') {
      if (!bucketAllow(`register:${getIp(req)}`,cfg.registerRatePerMin,60000)) return fail(res,429,'RATE_LIMIT','Too many session registrations.');
      const body=await readJson(req);
      const {server_id,server_key,instance_id,platform='bedrock',metadata={}}=body;
      if (typeof server_id!=='string'||!server_id) return fail(res,400,'BAD_REQUEST','server_id is required.');
      if (platform!=='bedrock') return fail(res,400,'PLATFORM_DISABLED','This MVP currently accepts Bedrock sessions only.');
      const expected=expectedServerKey(server_id);
      if (!expected) return fail(res,403,'SERVER_NOT_ALLOWED','server_id has no configured key.');
      if (!timingSafeEqualText(server_key||'',expected)) return fail(res,403,'BAD_SERVER_KEY','Invalid server key.');
      const raw=makeToken(), t=now();
      const s={session_id:makeId('ses'),server_id,instance_id:String(instance_id||makeId('bds')),platform,metadata:(metadata&&typeof metadata==='object')?metadata:{},token_hash:hashToken(raw),token_expires_at:t+cfg.tokenTtlMs,created_at:t,last_seen_at:t,joined_bubbles:new Set()};
      sessions.set(s.session_id,s);
      return json(res,201,{protocol:'bubble/1',session:publicSession(s),session_token:raw,token_expires_at:s.token_expires_at,heartbeat_interval_ms:cfg.heartbeatMs,recommended_poll_ms:cfg.pollMs});
    }

    if (path.startsWith('/v1/')) {
      const session=authenticate(req,res); if (!session) return;

      if (method==='POST' && path==='/v1/sessions/heartbeat') return json(res,200,{ok:true,session:publicSession(session),server_time:now()});
      let m=path.match(/^\/v1\/sessions\/([^/]+)$/);
      if (method==='DELETE' && m) {
        if (decodeURIComponent(m[1])!==session.session_id) return fail(res,403,'SESSION_MISMATCH','Cannot close another session.');
        const removed=removeSessionPlayers(session); sessions.delete(session.session_id); return json(res,200,{ok:true,removed_players:removed});
      }
      if (method==='GET' && path==='/v1/bubbles') return json(res,200,{bubbles:[...bubbles.values()].map(b=>({bubble_id:b.bubble_id,nid:b.nid,uid:b.uid,name:b.name,type:b.type,size:b.bounds.size,game_mode:b.game_mode,max_players:b.max_players,persistent:b.persistent}))});

      m=path.match(/^\/v1\/bubbles\/([^/]+)$/);
      if (method==='GET' && m) {
        const b=getBubble(decodeURIComponent(m[1]),res); if(!b)return;
        return json(res,200,{bubble:{...b,live_players:storeForBubble(b.bubble_id).size}});
      }
      m=path.match(/^\/v1\/bubbles\/([^/]+)\/manifest$/);
      if (method==='GET' && m) { const b=getBubble(decodeURIComponent(m[1]),res); if(!b)return; return json(res,200,b); }

      m=path.match(/^\/v1\/bubbles\/([^/]+)\/chunks\/(-?\d+)\/(-?\d+)$/);
      if (method==='GET' && m) {
        const b=getBubble(decodeURIComponent(m[1]),res); if(!b)return;
        const cx=Number(m[2]),cz=Number(m[3]),chunksX=Math.ceil(b.bounds.size[0]/b.chunk_size_bu),chunksZ=Math.ceil(b.bounds.size[2]/b.chunk_size_bu);
        if (cx<0||cz<0||cx>=chunksX||cz>=chunksZ) return fail(res,404,'CHUNK_OUT_OF_RANGE','Chunk is outside Bubble bounds.');
        const signature=crypto.createHash('sha256').update(`${b.uid}:${b.seed}:${b.generator_version}:${cx}:${cz}`).digest('hex').slice(0,24);
        return json(res,200,{bubble_id:b.bubble_id,chunk:[cx,cz],size_bu:b.chunk_size_bu,generator_version:b.generator_version,seed:b.seed,signature,content_mode:'deterministic-local-generation',note:'MVP returns deterministic chunk identity/metadata; Add-On/host renders actual content.'});
      }

      m=path.match(/^\/v1\/bubbles\/([^/]+)\/join$/);
      if (method==='POST' && m) {
        const b=getBubble(decodeURIComponent(m[1]),res); if(!b)return; session.joined_bubbles.add(b.bubble_id);
        return json(res,200,{ok:true,bubble_id:b.bubble_id,manifest_version:b.manifest_version,spawn_position:b.spawn_position,recommended_poll_ms:cfg.pollMs,player_ttl_ms:cfg.playerTtlMs,aoi_radius_bu:cfg.aoiRadiusBu,rules:b.rules});
      }
      m=path.match(/^\/v1\/bubbles\/([^/]+)\/leave$/);
      if (method==='POST' && m) {
        const b=getBubble(decodeURIComponent(m[1]),res); if(!b)return; const removed=removeSessionPlayers(session,b.bubble_id); session.joined_bubbles.delete(b.bubble_id);
        return json(res,200,{ok:true,bubble_id:b.bubble_id,removed_players:removed.map(x=>x.player_id)});
      }
      m=path.match(/^\/v1\/bubbles\/([^/]+)\/sync-compact$/);
      if(method==='POST' && m) {
        const b=getBubble(decodeURIComponent(m[1]),res);if(!b)return;
        if(!requireJoin(session,b.bubble_id,res))return;
        if(!bucketAllow(`sync:${session.session_id}`,cfg.syncRatePerSec,1000))return fail(res,429,'RATE_LIMIT','Sync rate exceeded.',{recommended_poll_ms:cfg.pollMs});
        const body=await readJson(req),invalid=validateCompact(b,body);
        if(invalid)return fail(res,400,'INVALID_COMPACT_STATE',invalid);
        cleanup();const t=now(),s=body.s,players=storeForBubble(b.bubble_id),previous=players.get(s.i);globalTick++;
        // O transmissor e o receptor sao duas sessoes autenticadas distintas.
        if(previous && previous.session_id!==session.session_id) return fail(res,409,'PLAYER_OWNED','Player ID belongs to another session.');
        const record={player_id:s.i,name:s.n||previous?.name||s.i,platform:'bedrock',
          server_id:session.server_id,instance_id:session.instance_id,session_id:session.session_id,
          position:s.p,rotation:{yaw:s.r[0],pitch:s.r[1]},animation:ANIMS[s.a],anim_id:s.a,
          flags:flagsFromBits(s.f),dimension_code:s.d,sequence:s.q,
          revision:(previous?.revision||0)+1,tick:globalTick,updated_at:t};
        players.set(s.i,record);const r2=cfg.aoiRadiusBu*cfg.aoiRadiusBu;
        const remotes=[...players.values()].filter(p=>p.player_id!==s.i &&
          p.session_id!==session.session_id&&(t-p.updated_at)<=cfg.playerTtlMs &&
          distanceSq(p.position,record.position)<=r2)
          .sort((a,b2)=>distanceSq(a.position,record.position)-distanceSq(b2.position))
          .slice(0,cfg.maxRemotes).map(compactRecord);
        return json(res,200,{v:1,t, r:remotes});
      }
      m=path.match(/^\/v1\/bubbles\/([^/]+)\/sync$/);
      if (method==='POST' && m) {
        const b=getBubble(decodeURIComponent(m[1]),res); if(!b)return; if(!requireJoin(session,b.bubble_id,res))return;
        if(!bucketAllow(`sync:${session.session_id}`,cfg.syncRatePerSec,1000)) return fail(res,429,'RATE_LIMIT','Sync rate exceeded.',{recommended_poll_ms:cfg.pollMs});
        const body=await readJson(req); const invalid=validatePlayerState(b,body); if(invalid)return fail(res,400,'INVALID_PLAYER_STATE',invalid);
        cleanup(); const t=now(),input=body.player,players=storeForBubble(b.bubble_id),previous=players.get(input.id); globalTick++;
        if(previous && previous.session_id!==session.session_id) return fail(res,409,'PLAYER_OWNED','Player ID belongs to another session.');
        const record={player_id:input.id,name:input.name||previous?.name||input.id,platform:'bedrock',server_id:session.server_id,instance_id:session.instance_id,session_id:session.session_id,position:input.position,rotation:{yaw:input.rotation.yaw,pitch:input.rotation.pitch},animation:input.animation||'idle',flags:{sprinting:!!input.flags?.sprinting,sneaking:!!input.flags?.sneaking,jumping:!!input.flags?.jumping,grounded:input.flags?.grounded!==false},revision:(previous?.revision||0)+1,tick:globalTick,updated_at:t};
        players.set(input.id,record); const r2=cfg.aoiRadiusBu*cfg.aoiRadiusBu;
        const remotes=[...players.values()].filter(p=>p.player_id!==input.id&&p.session_id!==session.session_id&&(t-p.updated_at)<=cfg.playerTtlMs&&distanceSq(p.position,record.position)<=r2).sort((a,b2)=>distanceSq(a.position,record.position)-distanceSq(b2.position,record.position)).slice(0,cfg.maxRemotes).map(p=>({id:p.player_id,name:p.name,platform:p.platform,server_id:p.server_id,position:p.position,rotation:p.rotation,animation:p.animation,flags:p.flags,revision:p.revision,updated_at:p.updated_at}));
        return json(res,200,{protocol:'bubble/1',bubble_id:b.bubble_id,server_time:t,tick:globalTick,self:{id:record.player_id,revision:record.revision},remotes,recommended_poll_ms:cfg.pollMs,player_ttl_ms:cfg.playerTtlMs,interpolation_hint_ms:Math.max(cfg.pollMs*2,300)});
      }
      m=path.match(/^\/v1\/bubbles\/([^/]+)\/snapshot$/);
      if (method==='GET' && m) {
        const b=getBubble(decodeURIComponent(m[1]),res); if(!b)return;
        if (cfg.adminKey && !timingSafeEqualText(String(req.headers['x-bubble-admin-key']||''),cfg.adminKey)) return fail(res,403,'ADMIN_REQUIRED','x-bubble-admin-key required for snapshot route.');
        cleanup();
        return json(res,200,{bubble_id:b.bubble_id,server_time:now(),players:[...storeForBubble(b.bubble_id).values()].map(p=>({id:p.player_id,name:p.name,server_id:p.server_id,position:p.position,rotation:p.rotation,animation:p.animation,flags:p.flags,revision:p.revision,updated_at:p.updated_at}))});
      }
    }
    return fail(res,404,'NOT_FOUND','Route not found.');
  } catch (err) {
    console.error(err);
    return fail(res,err.status||500,err.code||'INTERNAL_ERROR',err.message||'Unexpected server error.');
  }
}

const server=http.createServer(handler);
if (bubbleV2) bubbleV2.attachWebSocket(server);
server.listen(cfg.port,'0.0.0.0',()=>{
  console.log(`[bubble] Bubble API MVP v1.3.0 listening on :${cfg.port}`);
  console.log(`[bubble] configured server ids: ${Object.keys(serverKeys).join(', ') || '(none)'}`);
});

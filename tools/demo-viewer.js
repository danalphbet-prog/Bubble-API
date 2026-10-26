'use strict';
// Node 22 built-in WebSocket client. Subscribes WITHOUT token, prints raw player states.
const base=process.argv[2]||'ws://localhost:3000';
const room=process.argv[3]||'bubble-N001z';
const endpoint=base.replace(/^http:/,'ws:').replace(/^https:/,'wss:').replace(/\/$/,'')+'/beta/live';
console.log('[bubble beta viewer] connecting',endpoint,'room',room);
const socket=new WebSocket(endpoint);
socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'subscribe',room})));
socket.addEventListener('message',message=>{
  try{
    const msg=JSON.parse(message.data);
    if(msg.type==='state'){
      console.log('STATE',msg.playerId,'XYZ=',msg.state.position,'yaw=',msg.state.yRot,'flags=',msg.state.flags??{});
    }else if(msg.type==='event'){
      console.log('EVENT',msg.playerId,msg.event);
    }else if(msg.type==='ready' || msg.type==='snapshot' || msg.type==='error'){
      console.log(msg.type,JSON.stringify(msg).slice(0,1000));
    }
  }catch(e){console.error('bad frame:',e.message);}
});
socket.addEventListener('close',e=>console.log('closed',e.code,e.reason));
socket.addEventListener('error',e=>console.error('websocket failed'));

'use strict';
// Standalone example sender. Does not need Firebase, tokens, websocket or Minecraft.
const base=process.argv[2]||'http://localhost:3000';
const room=process.argv[3]||'bubble-N001z';
let count=0;
console.log('Bubble Beta demo ->',base,room,'(Ctrl+C para encerrar)');
async function tick(){
  const t=count/10;count++;
  try{
    const r=await fetch(base+'/beta/state',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({room,serverId:'demo-bds',playerId:'demo-steve',name:'Steve Demo',state:{
        dimension:1000,position:{x:1.5+2*Math.sin(t),y:65+Math.max(0,Math.sin(t*2)),z:3*Math.cos(t)},
        yRot:(t*55)%360,pitch:Math.sin(t)*12,
        flags:{isSprinting:count%40<20,isSneaking:count%40>=30,isJumping:count%20<6,isOnGround:count%20>=6},
        animation:'walk'
      }})});
    if(!r.ok)console.error('HTTP',r.status,await r.text());
    else if(count%10===0)console.log('publish',count,'ok');
  }catch(e){console.error('publish error:',e.message);}
}
tick();setInterval(tick,100);

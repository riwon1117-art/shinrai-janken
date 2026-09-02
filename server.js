const express=require("express"),http=require("http"),{Server}=require("socket.io"),path=require("path");
const app=express(),server=http.createServer(app),io=new Server(server);
app.use(express.static(path.join(__dirname,"public")));

const rooms=new Map(),ABC="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode=()=>{let x;do{x=[...Array(6)].map(()=>ABC[Math.random()*ABC.length|0]).join("")}while(rooms.has(x));return x};

const PLAYER_COLORS=["#8b5cf6","#ef4444","#3b82f6","#22c55e","#f59e0b","#ec4899","#06b6d4","#84cc16","#f97316","#a855f7"];
function nextPlayerColor(r){return PLAYER_COLORS[r.players.size%PLAYER_COLORS.length]}

function publicState(r,viewerId){
  const viewer=r.players.get(viewerId);
  return {
    code:r.code,round:r.round,phase:r.phase,overlay:r.overlay,winTarget:r.winTarget,hostId:r.hostId,
    yourHand:viewer?.hand||null,
    players:[...r.players.values()].map(p=>({
      id:p.id,name:p.name,active:p.active,reach:p.reach,winner:p.winner,color:p.color,
      submitted:!!p.hand,connected:p.connected
    })),
    history:r.history.slice(0,10)
  };
}

function send(r){
  for(const p of r.players.values()){
    if(p.connected) io.to(p.id).emit("state",publicState(r,p.id));
  }
}

function roomOf(s){return [...rooms.values()].find(r=>r.players.has(s.id))}

function movePlayerSocket(r,p,newId){
  const oldId=p.id;
  r.players.delete(oldId);
  p.id=newId;
  p.connected=true;
  p.disconnectedAt=null;
  r.players.set(newId,p);
  if(r.hostId===oldId)r.hostId=newId;
}

function reclaimByName(r,s,name,wantsHost=false){
  const target=[...r.players.values()].find(p=>p.name===name && !p.connected);
  if(!target)return null;
  const wasHost=r.hostId===target.id;
  if(wantsHost && !wasHost)return null;
  movePlayerSocket(r,target,s.id);
  s.join(r.code);
  return {player:target,isHost:wasHost};
}

function finishIfPossible(r){
  const alive=[...r.players.values()].filter(p=>p.active&&!p.winner);
  if(alive.length<=r.winTarget && alive.length>0){
    alive.forEach(p=>{p.active=false;p.reach=false;p.winner=true;p.hand=null});
    r.phase="finished";
    return true;
  }
  return false;
}

function selectablePlayers(r){
  if(r.phase==="reach"){
    return [...r.players.values()].filter(p=>p.active&&!p.winner&&!p.reach);
  }
  return [...r.players.values()].filter(p=>p.active&&!p.winner);
}

function resolveMain(r){
  const active=[...r.players.values()].filter(p=>p.active&&!p.winner);
  const hs=active.map(p=>p.hand),hasP=hs.includes("paper"),hasS=hs.includes("scissors");
  let title="",lines=[];
  const allSame=hs.length>0 && hs.every(h=>h===hs[0]);

  if(allSame){
    const mark={rock:"✊",paper:"✋",scissors:"✌️"}[hs[0]]||"";
    title=`全員${mark}！ 全員セーフ`;
    active.forEach(p=>lines.push(`${p.name}：セーフ`));
  }else if(hasP){
    title="✋が出た！ リーチ発生";
    active.forEach(p=>{
      if(p.hand==="paper"){p.reach=true;lines.push(`${p.name}：リーチ`)}
      else if(p.hand==="scissors"){p.active=false;p.hand=null;lines.push(`${p.name}：脱落`)}
      else lines.push(`${p.name}：継続`)
    });
    if(finishIfPossible(r)){
      title+=" → 勝利枠確定！";
    }else{
      r.phase="reach";
      active.forEach(p=>{if(p.active)p.hand=null});
    }
  }else{
    title="✌️が脱落";
    active.forEach(p=>{
      if(p.hand==="scissors"){p.active=false;p.hand=null;lines.push(`${p.name}：脱落`)}
      else lines.push(`${p.name}：セーフ`)
    });
    finishIfPossible(r);
  }
  return {title,lines};
}

function resolveReach(r){
  const reachers=[...r.players.values()].filter(p=>p.reach&&p.active&&!p.winner);
  const others=[...r.players.values()].filter(p=>p.active&&!p.winner&&!p.reach);
  const hs=others.map(p=>p.hand),hasP=hs.includes("paper"),hasS=hs.includes("scissors");
  let title="",lines=[];
  const allSame=hs.length>0 && hs.every(h=>h===hs[0]);

  if(allSame){
    title="全員同じ手 → リーチ解除！";
    reachers.forEach(p=>{p.reach=false;lines.push(`${p.name}：引き戻し`)});
    others.forEach(p=>lines.push(`${p.name}：継続`));
    r.phase="selecting";
    [...r.players.values()].forEach(p=>{if(p.active&&!p.winner)p.hand=null});
  }else{
    if(hasP){
      title="新しい✋が出現 → 元リーチ者が勝利確定";
      reachers.forEach(p=>{
        p.reach=false;p.active=false;p.winner=true;p.hand=null;
        lines.push(`${p.name}：勝利確定`)
      });
      others.forEach(p=>{
        if(p.hand==="paper"){p.reach=true;p.hand=null;lines.push(`${p.name}：新しいリーチ`)}
        else if(p.hand==="scissors"){p.active=false;p.hand=null;lines.push(`${p.name}：脱落`)}
        else {p.hand=null;lines.push(`${p.name}：継続`)}
      });
    }else if(hasS){
      title="✌️で脱落者発生 → 元リーチ者が勝利確定";
      reachers.forEach(p=>{
        p.reach=false;p.active=false;p.winner=true;p.hand=null;
        lines.push(`${p.name}：勝利確定`)
      });
      others.forEach(p=>{
        if(p.hand==="scissors"){p.active=false;p.hand=null;lines.push(`${p.name}：脱落`)}
        else {p.hand=null;lines.push(`${p.name}：継続`)}
      });
    }else{
      title="判定継続";
      others.forEach(p=>p.hand=null);
    }
    if(!finishIfPossible(r)){
      const newReach=[...r.players.values()].some(p=>p.reach&&p.active&&!p.winner);
      r.phase=newReach?"reach":"selecting";
    }
  }
  return {title,lines};
}

io.on("connection",s=>{
  s.on("createRoom",({name,winTarget=1},cb)=>{
    const c=makeCode();
    const r={code:c,hostId:s.id,round:1,phase:"selecting",overlay:null,winTarget:Math.max(1,+winTarget||1),history:[],players:new Map()};
    r.players.set(s.id,{
      id:s.id,name:(name||"ホスト").trim()||"ホスト",
      active:true,reach:false,winner:false,hand:null,color:nextPlayerColor(r),
      connected:true,disconnectedAt:null
    });
    rooms.set(c,r);s.join(c);
    cb({ok:true,code:c,isHost:true});
    send(r);
  });

  s.on("joinRoom",({code,name},cb)=>{
    const r=rooms.get((code||"").toUpperCase());
    if(!r)return cb({ok:false,error:"部屋が見つかりません"});
    const finalName=(name||"参加者").trim()||"参加者";

    const existing=[...r.players.values()].find(p=>p.name===finalName);
    if(existing){
      if(existing.connected)return cb({ok:false,error:"その名前は現在使用中です"});
      const oldHost=r.hostId===existing.id;
      movePlayerSocket(r,existing,s.id);
      s.join(r.code);
      cb({ok:true,code:r.code,isHost:oldHost,reconnected:true});
      send(r);
      return;
    }

    r.players.set(s.id,{
      id:s.id,name:finalName,active:true,reach:false,winner:false,hand:null,
      color:nextPlayerColor(r),connected:true,disconnectedAt:null
    });
    s.join(r.code);
    cb({ok:true,code:r.code,isHost:false,reconnected:false});
    send(r);
  });

  s.on("resumeRoom",({code,name,isHost:wantsHost},cb)=>{
    const r=rooms.get((code||"").toUpperCase());
    if(!r)return cb({ok:false,error:"部屋が終了しています"});
    const finalName=(name||"").trim();
    if(!finalName)return cb({ok:false,error:"名前がありません"});

    const already=[...r.players.values()].find(p=>p.name===finalName && p.connected);
    if(already){
      // 同じタブでSocket.IOだけ再接続した場合、古いsocket側は切れているはずだが
      // タイミング差でconnectedが残っていれば、本人として新しい接続へ差し替える。
      const wasHost=r.hostId===already.id;
      movePlayerSocket(r,already,s.id);
      s.join(r.code);
      cb({ok:true,code:r.code,isHost:wasHost,reconnected:true});
      send(r);
      return;
    }

    const reclaimed=reclaimByName(r,s,finalName,!!wantsHost);
    if(!reclaimed)return cb({ok:false,error:"元の参加枠が見つかりません"});
    cb({ok:true,code:r.code,isHost:reclaimed.isHost,reconnected:true});
    send(r);
  });

  s.on("setWinTarget",n=>{
    const r=roomOf(s);
    if(!r||r.hostId!==s.id||r.round!==1)return;
    r.winTarget=Math.max(1,Math.min(20,+n||1));send(r);
  });

  s.on("setPlayerColor",({playerId,color})=>{
    const r=roomOf(s);
    if(!r||r.hostId!==s.id)return;
    if(typeof color!=="string"||!/^#[0-9a-fA-F]{6}$/.test(color))return;
    const p=r.players.get(playerId);
    if(!p)return;
    p.color=color.toLowerCase();
    send(r);
  });

  s.on("choose",h=>{
    const r=roomOf(s),p=r&&r.players.get(s.id);
    if(!r||!p||!p.active||p.winner||r.phase==="finished"||r.phase==="revealed")return;
    if(r.phase==="reach"&&p.reach)return;
    if(!["rock","paper","scissors"].includes(h))return;
    p.hand=h;send(r);
  });

  s.on("reveal",()=>{
    const r=roomOf(s);
    if(!r||r.hostId!==s.id||r.phase==="finished")return;
    const required=selectablePlayers(r);
    if(!required.length||required.some(p=>!p.hand))return;

    const snapshot=required.map(p=>({id:p.id,name:p.name,hand:p.hand,color:p.color}));
    io.to(r.code).emit("revealBurst",{at:Date.now(),round:r.round,players:snapshot,duration:2400});

    const resolvingPhase=r.phase;
    const out=resolvingPhase==="reach"?resolveReach(r):resolveMain(r);
    r.history.unshift({round:r.round,stage:resolvingPhase,title:out.title,lines:out.lines});
    send(r);
  });

  s.on("next",()=>{
    const r=roomOf(s);
    if(!r||r.hostId!==s.id||r.phase==="finished")return;
    r.round++;
    r.phase=[...r.players.values()].some(p=>p.reach&&p.active&&!p.winner)?"reach":"selecting";
    r.players.forEach(p=>{if(p.active&&!p.winner)p.hand=null});
    send(r);
  });

  s.on("reset",()=>{
    const r=roomOf(s);
    if(!r||r.hostId!==s.id)return;
    r.round=1;r.phase="selecting";r.history=[];r.overlay=null;
    r.players.forEach(p=>{p.active=true;p.reach=false;p.winner=false;p.hand=null});
    send(r);
  });

  s.on("overlay",({text="構えて！",duration=2600})=>{
    const r=roomOf(s);
    if(!r||r.hostId!==s.id)return;
    r.overlay={text,duration,at:Date.now()};
    send(r);
    setTimeout(()=>{
      if(r.overlay&&Date.now()-r.overlay.at>=duration){r.overlay=null;send(r)}
    },duration+80);
  });

  s.on("disconnect",()=>{
    for(const r of rooms.values()){
      const p=r.players.get(s.id);
      if(!p)continue;
      p.connected=false;
      p.disconnectedAt=Date.now();
      send(r);
      break;
    }
  });
});

// 全員が30分以上切断された部屋だけ掃除する
setInterval(()=>{
  const now=Date.now();
  for(const [code,r] of rooms){
    const ps=[...r.players.values()];
    if(ps.length && ps.every(p=>!p.connected && p.disconnectedAt && now-p.disconnectedAt>30*60*1000)){
      rooms.delete(code);
    }
  }
},60*1000);

server.listen(process.env.PORT||3000);

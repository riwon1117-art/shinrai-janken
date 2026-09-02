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
    history:r.history.slice(0,20),
    currentResult:r.currentResult||null,
    roundResults:(r.roundResults||[]).slice(0,20)
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
  const winners=[...r.players.values()].filter(p=>p.winner);
  const active=[...r.players.values()].filter(p=>p.active&&!p.winner);
  const remainingSlots=Math.max(0,r.winTarget-winners.length);

  // 勝者数が勝利枠に達したときだけ終了。
  if(remainingSlots===0){
    active.forEach(p=>{
      p.active=false;
      p.reach=false;
      p.hand=null;
    });
    r.phase="finished";
    return true;
  }

  // 残人数と残り勝利枠が「同数」のときだけ、残った全員を勝利にする。
  // active.length < remainingSlots の状態では絶対に終了させない。
  if(active.length===remainingSlots){
    active.forEach(p=>{
      p.winner=true;
      p.active=false;
      p.reach=false;
      p.hand=null;
    });
    r.phase="finished";
    return true;
  }

  return false;
}

function remainingWinSlots(r){
  const winners=[...r.players.values()].filter(p=>p.winner).length;
  return Math.max(0,r.winTarget-winners);
}

function markWinner(p){
  p.winner=true;
  p.active=false;
  p.reach=false;
  p.hand=null;
}

function markLoser(p){
  p.active=false;
  p.reach=false;
  p.hand=null;
}

function keepPlaying(p){
  p.active=true;
  p.winner=false;
  p.reach=false;
  p.hand=null;
}

function selectablePlayers(r){
  if(r.phase==="reach"){
    return [...r.players.values()].filter(p=>p.active&&!p.winner&&!p.reach);
  }
  return [...r.players.values()].filter(p=>p.active&&!p.winner);
}

function resolveMain(r){
  const active=[...r.players.values()].filter(p=>p.active&&!p.winner);

  // 残人数と残り勝利枠が同じなら、その時点で全員勝利。
  if(finishIfPossible(r)){
    const justWon=active.filter(p=>p.winner);
    return {
      title:"残り人数が勝利枠に到達 → 全員勝利！",
      lines:justWon.map(p=>`${p.name}：勝利確定`)
    };
  }

  const slots=remainingWinSlots(r);
  const hs=active.map(p=>p.hand), mark={rock:"✊",paper:"✋",scissors:"✌️"};
  const rocks=active.filter(p=>p.hand==="rock");
  const papers=active.filter(p=>p.hand==="paper");
  const scissors=active.filter(p=>p.hand==="scissors");
  const hasR=rocks.length>0,hasP=papers.length>0,hasS=scissors.length>0;
  let title="",lines=[];
  const allSame=hs.length>0&&hs.every(h=>h===hs[0]);

  if(allSame){
    title=`全員${mark[hs[0]]}！ 全員継続`;
    active.forEach(p=>{p.hand=null;lines.push(`${p.name}：継続`)});
    r.phase="selecting";
    return {title,lines};
  }

  // 残り2人だけは通常のじゃんけん。
  // ただし残り勝利枠も2なら上の finishIfPossible で2人とも勝利済み。
  if(active.length===2){
    let winnerHand=null;
    if(hasR&&hasS)winnerHand="rock";
    else if(hasS&&hasP)winnerHand="scissors";
    else if(hasP&&hasR)winnerHand="paper";

    title=`残り2人：${mark[winnerHand]}の勝ち！`;
    active.forEach(p=>{
      if(p.hand===winnerHand){
        markWinner(p);
        lines.push(`${p.name}：勝利確定`);
      }else{
        markLoser(p);
        lines.push(`${p.name}：敗北`);
      }
    });
    finishIfPossible(r);
    return {title,lines};
  }

  // ===== ✋ と ✌️ がいる場合 =====
  // 基本は✌️が裏切りを見抜く。
  // ただし✋を全員脱落させると勝利枠を満たせなくなる場合は、
  // ✌️側（＋三すくみなら✊側も生存側）を先に勝利扱いにして、
  // ✋は脱落させず「残り枠」を争う。
  if(hasP&&hasS){
    const survivors=active.filter(p=>p.hand!=="paper");

    if(survivors.length<slots){
      title="✌️が裏切りを阻止 → 生存側が勝利、✋で残り枠を再戦！";
      survivors.forEach(p=>{
        markWinner(p);
        lines.push(`${p.name}：勝利確定`);
      });
      papers.forEach(p=>{
        keepPlaying(p);
        lines.push(`${p.name}：残り勝利枠をかけて再戦`);
      });

      if(!finishIfPossible(r))r.phase="selecting";
      return {title,lines};
    }

    // 生存側だけで勝利枠をちょうど満たせるなら、そのまま勝利確定。
    if(survivors.length===slots){
      title="✌️が裏切りを阻止 → 生存側が勝利！";
      survivors.forEach(p=>{
        markWinner(p);
        lines.push(`${p.name}：勝利確定`);
      });
      papers.forEach(p=>{
        markLoser(p);
        lines.push(`${p.name}：敗北（裏切りを警戒された）`);
      });
      finishIfPossible(r);
      return {title,lines};
    }

    // 生存側が勝利枠より多いなら、✋だけ脱落して生存側で続行。
    title="✌️が裏切りを阻止！";
    papers.forEach(p=>{
      markLoser(p);
      lines.push(`${p.name}：敗北（裏切りを警戒された）`);
    });
    survivors.forEach(p=>{
      p.hand=null;
      lines.push(`${p.name}：継続`);
    });
    if(!finishIfPossible(r))r.phase="selecting";
    return {title,lines};
  }

  // ===== ✊ と ✌️（✋なし） =====
  // ✌️は読み外し。考え方は上と同じで、勝利枠不足になるなら✊を先に勝者化し、
  // ✌️は残り枠を争う。
  if(hasR&&hasS&&!hasP){
    if(rocks.length<slots){
      title="✌️の警戒外れ → ✊が勝利、✌️で残り枠を再戦！";
      rocks.forEach(p=>{
        markWinner(p);
        lines.push(`${p.name}：勝利確定`);
      });
      scissors.forEach(p=>{
        keepPlaying(p);
        lines.push(`${p.name}：残り勝利枠をかけて再戦`);
      });
      if(!finishIfPossible(r))r.phase="selecting";
      return {title,lines};
    }

    if(rocks.length===slots){
      title="✌️の警戒外れ → ✊が勝利！";
      rocks.forEach(p=>{
        markWinner(p);
        lines.push(`${p.name}：勝利確定`);
      });
      scissors.forEach(p=>{
        markLoser(p);
        lines.push(`${p.name}：敗北（裏切り警戒が外れた）`);
      });
      finishIfPossible(r);
      return {title,lines};
    }

    title="✌️の警戒外れ！";
    scissors.forEach(p=>{
      markLoser(p);
      lines.push(`${p.name}：敗北（裏切り警戒が外れた）`);
    });
    rocks.forEach(p=>{
      p.hand=null;
      lines.push(`${p.name}：継続`);
    });
    if(!finishIfPossible(r))r.phase="selecting";
    return {title,lines};
  }

  // ===== ✋ と ✊（✌️なし） =====
  // 通常は✋がリーチ。
  // ただし✋の人数が残り勝利枠より多い場合は、全員をリーチにはせず、
  // ✊を脱落させて✋だけで残り枠を再戦する。
  if(hasP&&hasR&&!hasS){
    if(papers.length>slots){
      title="裏切り多数 → ✊が脱落、✋で再戦！";
      rocks.forEach(p=>{
        markLoser(p);
        lines.push(`${p.name}：敗北`);
      });
      papers.forEach(p=>{
        keepPlaying(p);
        lines.push(`${p.name}：リーチなしで再戦`);
      });
      if(!finishIfPossible(r))r.phase="selecting";
      return {title,lines};
    }

    title="✋がリーチ！";
    papers.forEach(p=>{
      p.reach=true;
      p.hand=null;
      lines.push(`${p.name}：リーチ`);
    });
    rocks.forEach(p=>{
      p.hand=null;
      lines.push(`${p.name}：継続`);
    });
    r.phase="reach";
    return {title,lines};
  }

  title="全員継続";
  active.forEach(p=>{p.hand=null;lines.push(`${p.name}：継続`)});
  r.phase="selecting";
  return {title,lines};
}

function resolveReach(r){
  const remaining=[...r.players.values()].filter(p=>p.active&&!p.winner);

  if(finishIfPossible(r)){
    const justWon=remaining.filter(p=>p.winner);
    return {
      title:"残り人数が勝利枠に到達 → 全員勝利！",
      lines:justWon.map(p=>`${p.name}：勝利確定`)
    };
  }

  // 残り2人になったらリーチ状態を解除して通常じゃんけんへ。
  if(remaining.length===2){
    remaining.forEach(p=>{p.reach=false;p.hand=null});
    r.phase="selecting";
    return {title:"残り2人 → 通常じゃんけんへ",lines:remaining.map(p=>`${p.name}：最終じゃんけん`)};
  }

  const reachers=[...r.players.values()].filter(p=>p.reach&&p.active&&!p.winner);
  const others=[...r.players.values()].filter(p=>p.active&&!p.winner&&!p.reach);
  const hs=others.map(p=>p.hand);
  const rocks=others.filter(p=>p.hand==="rock");
  const papers=others.filter(p=>p.hand==="paper");
  const scissors=others.filter(p=>p.hand==="scissors");
  const hasR=rocks.length>0,hasP=papers.length>0,hasS=scissors.length>0;
  let title="",lines=[];
  const allSame=hs.length>0&&hs.every(h=>h===hs[0]);

  if(allSame){
    title="全員同じ手 → リーチ解除！";
    reachers.forEach(p=>{
      p.reach=false;p.hand=null;
      lines.push(`${p.name}：引き戻し`);
    });
    others.forEach(p=>{
      p.hand=null;
      lines.push(`${p.name}：継続`);
    });
    r.phase="selecting";
    return {title,lines};
  }

  // ✋と✌️：元リーチ者は勝利。
  if(hasP&&hasS){
    title="✌️が裏切りを阻止 → 元リーチ者が勝利！";
    reachers.forEach(p=>{
      markWinner(p);
      lines.push(`${p.name}：勝利確定`);
    });

    const slotsAfter=remainingWinSlots(r);
    const safeOthers=others.filter(p=>p.hand!=="paper");

    // ✋を全滅させると残り枠を埋められないなら、✋を再戦へ残す。
    if(safeOthers.length<slotsAfter){
      safeOthers.forEach(p=>{
        p.hand=null;
        lines.push(`${p.name}：継続`);
      });
      papers.forEach(p=>{
        keepPlaying(p);
        lines.push(`${p.name}：残り勝利枠をかけて再戦`);
      });
    }else{
      papers.forEach(p=>{
        markLoser(p);
        lines.push(`${p.name}：敗北（裏切りを警戒された）`);
      });
      safeOthers.forEach(p=>{
        p.hand=null;
        lines.push(`${p.name}：継続`);
      });
    }

    if(!finishIfPossible(r))r.phase="selecting";
    return {title,lines};
  }

  // ✊と✌️：元リーチ者は勝利、✌️は読み外し。
  if(hasR&&hasS&&!hasP){
    title="✌️の警戒外れ → 元リーチ者が勝利！";
    reachers.forEach(p=>{
      markWinner(p);
      lines.push(`${p.name}：勝利確定`);
    });

    const slotsAfter=remainingWinSlots(r);
    if(rocks.length<slotsAfter){
      rocks.forEach(p=>{
        p.hand=null;
        lines.push(`${p.name}：継続`);
      });
      scissors.forEach(p=>{
        keepPlaying(p);
        lines.push(`${p.name}：残り勝利枠をかけて再戦`);
      });
    }else{
      scissors.forEach(p=>{
        markLoser(p);
        lines.push(`${p.name}：敗北（裏切り警戒が外れた）`);
      });
      rocks.forEach(p=>{
        p.hand=null;
        lines.push(`${p.name}：継続`);
      });
    }

    if(!finishIfPossible(r))r.phase="selecting";
    return {title,lines};
  }

  // 新しい✋が出た場合、元リーチ者は勝利。
  if(hasP){
    title="新しい✋が出現 → 元リーチ者が勝利！";
    reachers.forEach(p=>{
      markWinner(p);
      lines.push(`${p.name}：勝利確定`);
    });

    const slotsAfter=remainingWinSlots(r);

    // 新しい✋の人数が残り枠より多いならリーチ化せず、他の手を脱落させて✋で再戦。
    if(papers.length>slotsAfter && hasR){
      rocks.forEach(p=>{
        markLoser(p);
        lines.push(`${p.name}：敗北`);
      });
      papers.forEach(p=>{
        keepPlaying(p);
        lines.push(`${p.name}：リーチなしで再戦`);
      });
      if(!finishIfPossible(r))r.phase="selecting";
      return {title,lines};
    }

    papers.forEach(p=>{
      p.reach=true;p.hand=null;
      lines.push(`${p.name}：新しいリーチ`);
    });
    others.filter(p=>p.hand!=="paper").forEach(p=>{
      p.hand=null;
      lines.push(`${p.name}：継続`);
    });

    if(!finishIfPossible(r))r.phase="reach";
    return {title,lines};
  }

  title="決着なし → リーチ継続";
  reachers.forEach(p=>{
    p.hand=null;
    lines.push(`${p.name}：リーチ継続`);
  });
  others.forEach(p=>{
    p.hand=null;
    lines.push(`${p.name}：再選択`);
  });
  r.phase="reach";
  return {title,lines};
}

io.on("connection",s=>{
  s.on("createRoom",({name,winTarget=1},cb)=>{
    const c=makeCode();
    const r={code:c,hostId:s.id,round:1,phase:"selecting",overlay:null,winTarget:Math.max(1,+winTarget||1),history:[],currentResult:null,roundResults:[],players:new Map()};
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
    const resultEntry={round:r.round,stage:resolvingPhase,title:out.title,lines:out.lines};
    r.currentResult=resultEntry;
    r.history.unshift(resultEntry);
    send(r);
  });

  s.on("next",()=>{
    const r=roomOf(s);
    if(!r||r.hostId!==s.id)return;

    if(r.phase==="finished"){
      // 終了したラウンドの最終結果を保存してから、全員参加で次ラウンドへ。
      const winners=[...r.players.values()]
        .filter(p=>p.winner)
        .map(p=>({name:p.name,color:p.color}));
      const losers=[...r.players.values()]
        .filter(p=>!p.winner)
        .map(p=>({name:p.name,color:p.color}));

      // 二重保存防止
      if(!(r.roundResults||[]).some(x=>x.round===r.round)){
        r.roundResults.unshift({
          round:r.round,
          winners,
          losers,
          result:r.currentResult
            ? {title:r.currentResult.title,lines:[...r.currentResult.lines]}
            : null
        });
      }

      r.round++;
      r.phase="selecting";
      r.overlay=null;
      r.currentResult=null;
      r.players.forEach(p=>{
        p.active=true;
        p.reach=false;
        p.winner=false;
        p.hand=null;
      });
      send(r);
      return;
    }

    // ゲーム途中の「次へ」は従来どおり次の判定へ。
    r.round++;
    r.phase=[...r.players.values()].some(p=>p.reach&&p.active&&!p.winner)?"reach":"selecting";
    r.currentResult=null;
    r.players.forEach(p=>{if(p.active&&!p.winner)p.hand=null});
    send(r);
  });

  s.on("reset",()=>{
    const r=roomOf(s);
    if(!r||r.hostId!==s.id)return;
    r.round=1;r.phase="selecting";r.history=[];r.currentResult=null;r.roundResults=[];r.overlay=null;
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

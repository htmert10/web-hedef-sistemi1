"use strict";
const SIZE=320,TARGET_MM=170,PELLET_MM=4.5,FRAME_COUNT=3,SCAN_INTERVAL_MS=650,$=id=>document.getElementById(id);
const video=$("video"),camera=$("camera"),cctx=camera.getContext("2d",{willReadFrequently:true}),overlay=$("overlay"),octx=overlay.getContext("2d"),warped=$("warped"),wctx=warped.getContext("2d");
let stream,socket,corners=[],reference=null,referenceTarget=null,lastScanFrame=null,previousScanFrame=null,noiseFloor=null,knownHoles=[],knownLuminousHoles=[],armed=false,busy=false,pending=null,scanTimer=null,candidateTrack=null,stableScanCount=0,shotQueue=[];
const status=(text,error=false)=>{$("status").textContent=text;$("status").classList.toggle("error",error)};
function connect(){socket=new WebSocket(`${location.protocol==="https:"?"wss":"ws"}://${location.host}/ws`);socket.onopen=()=>{$("connection").textContent="Bağlı";while(shotQueue.length&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(shotQueue.shift()))};socket.onclose=()=>{$("connection").textContent="Bağlantı yok";setTimeout(connect,1500)}}
function send(data){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(data));else if(data.type==="shot"){shotQueue.push(data);$("connection").textContent=`Kuyrukta ${shotQueue.length}`}}
async function startCamera(){try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1280}},audio:false});video.srcObject=stream;await video.play();const ratio=video.videoWidth/video.videoHeight;camera.width=900;camera.height=Math.round(900/ratio);overlay.width=camera.width;overlay.height=camera.height;drawLoop();$("corners").disabled=false;status("Kâğıdın dört köşesini sırayla seç: sol üst, sağ üst, sağ alt, sol alt.")}catch(e){status(`Kamera açılamadı: ${e.message}`,true)}}
function drawLoop(){cctx.drawImage(video,0,0,camera.width,camera.height);drawOverlay();requestAnimationFrame(drawLoop)}
function drawOverlay(){octx.clearRect(0,0,overlay.width,overlay.height);octx.fillStyle="#d8ff3e";octx.strokeStyle="#d8ff3e";octx.lineWidth=4;corners.forEach((p,i)=>{octx.beginPath();octx.arc(p.x*overlay.width,p.y*overlay.height,10,0,Math.PI*2);octx.fill();octx.fillText(i+1,p.x*overlay.width+14,p.y*overlay.height)});if(corners.length>1){octx.beginPath();octx.moveTo(corners[0].x*overlay.width,corners[0].y*overlay.height);corners.slice(1).forEach(p=>octx.lineTo(p.x*overlay.width,p.y*overlay.height));if(corners.length===4)octx.closePath();octx.stroke()}}
overlay.onpointerdown=e=>{if(!stream||corners.length>=4)return;const r=overlay.getBoundingClientRect();corners.push({x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height});if(corners.length===4){$("reference").disabled=false;status("Köşeler hazır. Hedef temizken referansı kaydet.")}};
$("corners").onclick=()=>{corners=[];reference=null;referenceTarget=null;lastScanFrame=null;previousScanFrame=null;noiseFloor=null;knownHoles=[];knownLuminousHoles=[];candidateTrack=null;stableScanCount=0;armed=false;setAutomaticScanning(false);$("reference").disabled=true;$("arm").disabled=true;$("test").disabled=true;status("Köşeleri yeniden seç.")};
function solve(matrix,vector){const n=vector.length;for(let i=0;i<n;i++){let max=i;for(let j=i+1;j<n;j++)if(Math.abs(matrix[j][i])>Math.abs(matrix[max][i]))max=j;[matrix[i],matrix[max]]=[matrix[max],matrix[i]];[vector[i],vector[max]]=[vector[max],vector[i]];const p=matrix[i][i];if(Math.abs(p)<1e-10)throw Error("Köşe geometrisi geçersiz");for(let j=i;j<n;j++)matrix[i][j]/=p;vector[i]/=p;for(let k=0;k<n;k++){if(k===i)continue;const f=matrix[k][i];for(let j=i;j<n;j++)matrix[k][j]-=f*matrix[i][j];vector[k]-=f*vector[i]}}return vector}
function homography(){const rows=[],values=[];const dst=[[0,0],[1,0],[1,1],[0,1]];for(let i=0;i<4;i++){const [u,v]=dst[i],x=corners[i].x*camera.width,y=corners[i].y*camera.height;rows.push([u,v,1,0,0,0,-u*x,-v*x]);values.push(x);rows.push([0,0,0,u,v,1,-u*y,-v*y]);values.push(y)}return solve(rows,values)}
function warp(){const src=cctx.getImageData(0,0,camera.width,camera.height),out=wctx.createImageData(SIZE,SIZE),h=homography();for(let y=0;y<SIZE;y++){const v=y/(SIZE-1);for(let x=0;x<SIZE;x++){const u=x/(SIZE-1),d=h[6]*u+h[7]*v+1,sx=(h[0]*u+h[1]*v+h[2])/d,sy=(h[3]*u+h[4]*v+h[5])/d,ix=Math.max(0,Math.min(camera.width-1,Math.round(sx))),iy=Math.max(0,Math.min(camera.height-1,Math.round(sy))),si=(iy*camera.width+ix)*4,di=(y*SIZE+x)*4;out.data[di]=src.data[si];out.data[di+1]=src.data[si+1];out.data[di+2]=src.data[si+2];out.data[di+3]=255}}return out}
function gray(img){const out=new Uint8Array(SIZE*SIZE);for(let i=0,j=0;i<img.data.length;i+=4,j++)out[j]=Math.round(img.data[i]*.299+img.data[i+1]*.587+img.data[i+2]*.114);return out}
function median(frames){const out=new Uint8Array(frames[0].length),a=frames[0],b=frames[1],c=frames[2];for(let i=0;i<out.length;i++)out[i]=a[i]>b[i]?(b[i]>c[i]?b[i]:Math.min(a[i],c[i])):(a[i]>c[i]?a[i]:Math.min(b[i],c[i]));return out}
function targetSignature(grayFrame){let weight=0,weightedX=0,weightedY=0;const start=Math.round(SIZE*.2),end=Math.round(SIZE*.8);for(let y=start;y<end;y++)for(let x=start;x<end;x++){const darkness=Math.max(0,125-grayFrame[y*SIZE+x]);if(!darkness)continue;weight+=darkness;weightedX+=x*darkness;weightedY+=y*darkness}if(weight<5000)return null;const cx=weightedX/weight,cy=weightedY/weight,radialSum=new Float64Array(Math.ceil(SIZE*.35)),radialCount=new Uint32Array(radialSum.length);let radialMoment=0;for(let y=start;y<end;y++)for(let x=start;x<end;x++){const i=y*SIZE+x,distance=Math.hypot(x-cx,y-cy),bin=Math.round(distance),darkness=Math.max(0,125-grayFrame[i]);if(darkness)radialMoment+=distance*distance*darkness;if(bin<radialSum.length){radialSum[bin]+=grayFrame[i];radialCount[bin]++}}const radialMean=Array.from(radialSum,(sum,index)=>radialCount[index]?sum/radialCount[index]:0),fallbackRadius=Math.sqrt(2*radialMoment/weight);let radius=fallbackRadius,bestContrast=0;for(let r=Math.round(SIZE*.08);r<Math.round(SIZE*.30);r++){if(!radialMean[r-3]||!radialMean[r+3])continue;const contrast=radialMean[r+3]-radialMean[r-3];if(contrast>bestContrast){bestContrast=contrast;radius=r}}if(bestContrast<18)radius=fallbackRadius;return{cx,cy,radius,edgeContrast:bestContrast}}
function balanceTarget(current){if(!referenceTarget)return{gray:current,shift:0,scale:1,observed:null};const observed=targetSignature(current);if(!observed)return{gray:current,shift:0,scale:1,observed:null};const shift=Math.hypot(observed.cx-referenceTarget.cx,observed.cy-referenceTarget.cy),scale=observed.radius/referenceTarget.radius;if(shift>SIZE*.16||scale<.82||scale>1.18)return{gray:current,shift:0,scale:1,observed:null};const output=new Uint8Array(current.length);for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++){const sx=observed.cx+(x-referenceTarget.cx)*scale,sy=observed.cy+(y-referenceTarget.cy)*scale,x0=Math.max(0,Math.min(SIZE-1,Math.floor(sx))),y0=Math.max(0,Math.min(SIZE-1,Math.floor(sy))),x1=Math.min(SIZE-1,x0+1),y1=Math.min(SIZE-1,y0+1),fx=sx-x0,fy=sy-y0,a=current[y0*SIZE+x0]*(1-fx)+current[y0*SIZE+x1]*fx,b=current[y1*SIZE+x0]*(1-fx)+current[y1*SIZE+x1]*fx;output[y*SIZE+x]=Math.round(a*(1-fy)+b*fy)}return{gray:output,shift,scale,observed}}
function alignment(current){let best={dx:0,dy:0,error:Infinity};const radius=Math.min(SIZE*.47,referenceTarget.radius*2.62),radiusSquared=radius*radius;for(let dy=-6;dy<=6;dy++)for(let dx=-6;dx<=6;dx++){let sum=0,n=0;for(let y=8;y<SIZE-8;y+=4)for(let x=8;x<SIZE-8;x+=4){if((x-referenceTarget.cx)**2+(y-referenceTarget.cy)**2>radiusSquared)continue;const sx=x-dx,sy=y-dy;sum+=Math.abs(reference[y*SIZE+x]-current[sy*SIZE+sx]);n++}if(sum/n<best.error)best={dx,dy,error:sum/n}}return best}
function translateFrame(frame,shift){const output=new Uint8Array(frame.length);for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++){const sx=Math.max(0,Math.min(SIZE-1,x-shift.dx)),sy=Math.max(0,Math.min(SIZE-1,y-shift.dy));output[y*SIZE+x]=frame[sy*SIZE+sx]}return output}
function luminousHoles(frame){
  if(!referenceTarget)return[];
  const radius=referenceTarget.radius*1.12,radiusSquared=radius*radius,values=[];
  for(let y=Math.max(1,Math.floor(referenceTarget.cy-radius));y<=Math.min(SIZE-2,Math.ceil(referenceTarget.cy+radius));y+=2)for(let x=Math.max(1,Math.floor(referenceTarget.cx-radius));x<=Math.min(SIZE-2,Math.ceil(referenceTarget.cx+radius));x+=2){if((x-referenceTarget.cx)**2+(y-referenceTarget.cy)**2<=radiusSquared)values.push(frame[y*SIZE+x])}
  values.sort((a,b)=>a-b);
  const base=values[Math.floor(values.length*.55)]||70,threshold=Math.max(185,Math.min(230,base+85)),mask=new Uint8Array(frame.length),seen=new Uint8Array(frame.length),queue=new Int32Array(frame.length),holes=[];
  for(let y=Math.max(1,Math.floor(referenceTarget.cy-radius));y<=Math.min(SIZE-2,Math.ceil(referenceTarget.cy+radius));y++)for(let x=Math.max(1,Math.floor(referenceTarget.cx-radius));x<=Math.min(SIZE-2,Math.ceil(referenceTarget.cx+radius));x++){if((x-referenceTarget.cx)**2+(y-referenceTarget.cy)**2<=radiusSquared&&frame[y*SIZE+x]>=threshold)mask[y*SIZE+x]=1}
  for(let start=0;start<mask.length;start++){
    if(!mask[start]||seen[start])continue;
    let head=0,tail=0,area=0,wx=0,wy=0,weight=0,minX=SIZE,maxX=0,minY=SIZE,maxY=0;
    queue[tail++]=start;seen[start]=1;
    while(head<tail){const i=queue[head++],y=Math.floor(i/SIZE),x=i-y*SIZE,w=Math.max(1,frame[i]-threshold+1);area++;wx+=x*w;wy+=y*w;weight+=w;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);for(let yy=-1;yy<=1;yy++)for(let xx=-1;xx<=1;xx++){if(!xx&&!yy)continue;const nx=x+xx,ny=y+yy;if(nx<0||ny<0||nx>=SIZE||ny>=SIZE)continue;const ni=ny*SIZE+nx;if(mask[ni]&&!seen[ni]){seen[ni]=1;queue[tail++]=ni}}}
    const width=maxX-minX+1,height=maxY-minY+1,aspect=width/height,fill=area/(width*height);
    if(area>=3&&area<=180&&width<=22&&height<=22&&aspect>=.35&&aspect<=2.85&&fill>=.22)holes.push({x:wx/weight/(SIZE-1),y:wy/weight/(SIZE-1),area,threshold});
  }
  return holes;
}
function analyze(current){const shift=alignment(current),diff=new Uint8Array(SIZE*SIZE),outerRadius=Math.min(SIZE*.47,referenceTarget.radius*2.62),outerRadiusSquared=outerRadius*outerRadius,samples=[];let offsetSum=0,offsetN=0;for(let y=8;y<SIZE-8;y+=4)for(let x=8;x<SIZE-8;x+=4){if((x-referenceTarget.cx)**2+(y-referenceTarget.cy)**2>outerRadiusSquared)continue;offsetSum+=reference[y*SIZE+x]-current[(y-shift.dy)*SIZE+x-shift.dx];offsetN++}const offset=offsetSum/offsetN;for(let y=2;y<SIZE-2;y++)for(let x=2;x<SIZE-2;x++){const i=y*SIZE+x,v=Math.abs(reference[i]-Math.max(0,Math.min(255,current[(y-shift.dy)*SIZE+x-shift.dx]+offset)));diff[i]=v;if((x-referenceTarget.cx)**2+(y-referenceTarget.cy)**2<=outerRadiusSquared&&(x+y)%7===0)samples.push(v)}const mean=samples.reduce((a,b)=>a+b,0)/samples.length,sd=Math.sqrt(samples.reduce((a,b)=>a+(b-mean)**2,0)/samples.length),level=Number($("sensitivity").value),lightThreshold=Math.max(14,mean+sd*[3.8,3.2,2.7][level]),darkThreshold=Math.max(8,mean+sd*[2.8,2.3,1.9][level]),mask=new Uint8Array(diff.length),guardRadius=Math.max(PELLET_MM/TARGET_MM*SIZE*.92,Number($("minSize").value)/TARGET_MM*SIZE),guardRadiusSquared=guardRadius*guardRadius;for(let y=2;y<SIZE-2;y++)for(let x=2;x<SIZE-2;x++){if((x-referenceTarget.cx)**2+(y-referenceTarget.cy)**2>outerRadiusSquared||knownHoles.some(hole=>(x-hole.x*SIZE)**2+(y-hole.y*SIZE)**2<=guardRadiusSquared))continue;const i=y*SIZE+x,g=Math.abs(reference[i+1]-reference[i-1])+Math.abs(reference[i+SIZE]-reference[i-SIZE]),baseThreshold=reference[i]<135?darkThreshold:lightThreshold,threshold=Math.max(baseThreshold,(noiseFloor?.[i]||0)*2.4+4),strongEdgeChange=diff[i]>threshold*(reference[i]<135?1.45:3.2);if(diff[i]>=threshold&&(g<(reference[i]<135?38:28)||strongEdgeChange))mask[i]=1}const clean=new Uint8Array(mask.length);for(let y=2;y<SIZE-2;y++)for(let x=2;x<SIZE-2;x++){const i=y*SIZE+x;if(!mask[i])continue;let n=0;for(let yy=-1;yy<=1;yy++)for(let xx=-1;xx<=1;xx++)n+=mask[(y+yy)*SIZE+x+xx];if(n>=3)clean[i]=1}return components(clean,diff,shift.error,{dark:darkThreshold,light:lightThreshold})}
function components(mask,diff,alignError,thresholds){const seen=new Uint8Array(mask.length),queue=new Int32Array(mask.length),items=[],diameterPx=Number($("minSize").value)/TARGET_MM*SIZE,minArea=Math.max(7,Math.PI*(diameterPx/2)**2*.28),maxArea=Math.max(220,minArea*18);for(let start=0;start<mask.length;start++){if(!mask[start]||seen[start])continue;let head=0,tail=0,area=0,wx=0,wy=0,weight=0,totalDiff=0,totalReference=0,minX=SIZE,maxX=0,minY=SIZE,maxY=0;queue[tail++]=start;seen[start]=1;while(head<tail){const i=queue[head++],y=Math.floor(i/SIZE),x=i-y*SIZE,w=Math.max(1,diff[i]);area++;wx+=x*w;wy+=y*w;weight+=w;totalDiff+=diff[i];totalReference+=reference[i];minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);for(let yy=-1;yy<=1;yy++)for(let xx=-1;xx<=1;xx++){const ni=(y+yy)*SIZE+x+xx;if(xx===0&&yy===0||ni<0||ni>=mask.length||seen[ni]||!mask[ni])continue;seen[ni]=1;queue[tail++]=ni}}if(area<minArea||area>maxArea)continue;const bw=maxX-minX+1,bh=maxY-minY+1,aspect=bw/bh,fill=area/(bw*bh),meanDiff=totalDiff/area,meanReference=totalReference/area,darkRegion=meanReference<135,threshold=darkRegion?thresholds.dark:thresholds.light,minStrength=darkRegion?Math.max(10,threshold*1.04):Math.max(18,threshold*1.22);if(aspect<.35||aspect>2.85||fill<(darkRegion?.13:.18)||meanDiff<minStrength)continue;const sizeScore=Math.min(1,area/(minArea*1.8)),shapeScore=Math.min(aspect,1/aspect)*.5+Math.min(1,fill/(darkRegion?.42:.55))*.5,intensityScore=Math.min(1,(meanDiff-threshold)/Math.max(darkRegion?7:12,threshold*(darkRegion?.55:.9))),alignmentScore=Math.max(0,1-alignError/18),confidence=Math.max(0,Math.min(1,.27*sizeScore+.28*shapeScore+.35*intensityScore+.10*alignmentScore));items.push({x:wx/weight/(SIZE-1),y:wy/weight/(SIZE-1),area,meanDiff,darkRegion,confidence})}items.sort((a,b)=>b.confidence-a.confidence);return items}
async function captureStable(){const frames=[];let preview;for(let i=0;i<FRAME_COUNT;i++){if(i)await new Promise(r=>setTimeout(r,80));preview=warp();frames.push(gray(preview))}return{preview,current:median(frames)}}
function drawCandidate(candidate,preview,balance){let x=candidate.x*SIZE,y=candidate.y*SIZE;if(balance.observed){x=balance.observed.cx+(x-referenceTarget.cx)*balance.scale;y=balance.observed.cy+(y-referenceTarget.cy)*balance.scale}wctx.putImageData(preview,0,0);wctx.strokeStyle="#168cff";wctx.lineWidth=4;wctx.beginPath();wctx.arc(x,y,12,0,Math.PI*2);wctx.stroke()}
function localScanChange(current,candidate){if(!lastScanFrame)return Infinity;const cx=candidate.x*(SIZE-1),cy=candidate.y*(SIZE-1),radius=8,changes=[];for(let y=Math.max(0,Math.floor(cy-radius));y<=Math.min(SIZE-1,Math.ceil(cy+radius));y++)for(let x=Math.max(0,Math.floor(cx-radius));x<=Math.min(SIZE-1,Math.ceil(cx+radius));x++){if((x-cx)**2+(y-cy)**2>radius*radius)continue;const i=y*SIZE+x,raw=Math.abs(current[i]-lastScanFrame[i]),cameraNoise=(noiseFloor?.[i]||0)*1.35;changes.push(Math.max(0,raw-cameraNoise))}changes.sort((a,b)=>b-a);const count=Math.max(12,Math.ceil(changes.length*.2)),strongest=changes.slice(0,count);return strongest.reduce((sum,value)=>sum+value,0)/strongest.length}
function frameMotion(current,previous){if(!previous)return{level:0,ratio:0};const values=[];let changed=0,total=0;const radius=Math.min(SIZE*.47,referenceTarget.radius*2.62),radiusSquared=radius*radius;for(let y=6;y<SIZE-6;y+=4)for(let x=6;x<SIZE-6;x+=4){if((x-referenceTarget.cx)**2+(y-referenceTarget.cy)**2>radiusSquared)continue;const i=y*SIZE+x,residual=Math.max(0,Math.abs(current[i]-previous[i])-(noiseFloor?.[i]||0)*1.4);values.push(residual);if(residual>12)changed++;total++}values.sort((a,b)=>a-b);return{level:values[Math.floor(values.length*.8)]||0,ratio:total?changed/total:0}}
function nearPrintedRing(candidate){const x=candidate.x*(SIZE-1),y=candidate.y*(SIZE-1),distance=Math.hypot(x-referenceTarget.cx,y-referenceTarget.cy),pixelsPerMm=referenceTarget.radius/29.75;if(Math.abs(distance-referenceTarget.radius)<=10)return true;for(let score=1;score<=10;score++){const ringRadius=((11-score)*8-2.25)*pixelsPerMm;if(Math.abs(distance-ringRadius)<=5)return true}return false}
function scoringCoordinates(shot){const pixelsPerMm=referenceTarget.radius/29.75,xMm=(shot.x*(SIZE-1)-referenceTarget.cx)/pixelsPerMm,yMm=(shot.y*(SIZE-1)-referenceTarget.cy)/pixelsPerMm;return{x:Math.max(0,Math.min(1,.5+xMm/TARGET_MM)),y:Math.max(0,Math.min(1,.5+yMm/TARGET_MM))}}
async function detect(){
  if(busy||!reference||pending)return;
  busy=true;
  try{
    status("Hedef dengeleniyor; bütün yeni değişimler karşılaştırılıyor…");
    const data=await captureStable();
    wctx.putImageData(data.preview,0,0);
    const balanced=balanceTarget(data.current);
    data.current=balanced.gray;
    const scanFrame=translateFrame(data.current,alignment(data.current));
    const motion=frameMotion(scanFrame,previousScanFrame);
    previousScanFrame=scanFrame;
    const moving=motion.level>5.5||motion.ratio>.12;
    if(moving){
      stableScanCount=0;
      candidateTrack=null;
      status(`Kâğıt hareketi algılandı; sabitlenmesi bekleniyor · hareket %${Math.round(motion.ratio*100)}`);
      return;
    }
    stableScanCount++;
    if(stableScanCount<2){
      candidateTrack=null;
      status("Kâğıt sabitliği doğrulanıyor 1/2; atış henüz kaydedilmedi.");
      return;
    }
    const luminous=luminousHoles(scanFrame);
    const luminousMatchRadius=PELLET_MM/TARGET_MM*SIZE;
    const newLuminous=luminous.filter(hole=>!knownLuminousHoles.some(known=>Math.hypot(hole.x-known.x,hole.y-known.y)*SIZE<=luminousMatchRadius));
    const lightCandidates=newLuminous.map(hole=>{
      const onset=localScanChange(scanFrame,hole);
      return{...hole,meanDiff:60,darkRegion:true,confidence:.96,onset,eventScore:.96*.55+Math.min(1,onset/24)*.45,ringRisk:false,backlit:true};
    });
    const genericCandidates=analyze(data.current).filter(candidate=>Math.hypot(candidate.x*(SIZE-1)-referenceTarget.cx,candidate.y*(SIZE-1)-referenceTarget.cy)>referenceTarget.radius*1.12).map(candidate=>{
      const onset=localScanChange(scanFrame,candidate);
      const eventScore=candidate.confidence*.55+Math.min(1,onset/24)*.45;
      return{...candidate,onset,eventScore,ringRisk:nearPrintedRing(candidate)};
    });
    const candidates=[...lightCandidates,...genericCandidates];

    let best=null;
    if(candidateTrack){
      best=candidates
        .filter(candidate=>Math.hypot(candidate.x-candidateTrack.x,candidate.y-candidateTrack.y)*SIZE<=9)
        .sort((first,second)=>second.eventScore-first.eventScore)[0]||null;
    }
    if(!best){
      best=candidates.sort((first,second)=>second.eventScore-first.eventScore)[0]||null;
    }

    if(!best){
      candidateTrack=null;
      lastScanFrame=scanFrame;
      status(`Otomatik izleme aktif · kayma ${balanced.shift.toFixed(1)} px`);
      return;
    }

    const same=candidateTrack&&Math.hypot(best.x-candidateTrack.x,best.y-candidateTrack.y)*SIZE<=9;
    const duplicateRadius=PELLET_MM/TARGET_MM*SIZE;
    const repeatsKnownHole=knownHoles.some(hole=>Math.hypot(best.x-hole.x,best.y-hole.y)*SIZE<=duplicateRadius);
    if(!same&&repeatsKnownHole){
      candidateTrack=null;
      lastScanFrame=scanFrame;
      status("Eski deliğin parlaklık kayması elendi; yeni atış bekleniyor.");
      return;
    }
    if(!same&&best.onset<6.2){
      candidateTrack=null;
      lastScanFrame=scanFrame;
      status(`Yeni olmayan değişim elendi · yenilik ${best.onset.toFixed(1)}`);
      return;
    }

    if(!same&&best.ringRisk&&best.onset<10){
      candidateTrack=null;
      lastScanFrame=scanFrame;
      status("Halka kenarı titreşimi elendi; yeni atış bekleniyor.");
      return;
    }

    const clearContrast=best.meanDiff>=(best.darkRegion?20:29);
    const required=best.ringRisk?3:best.confidence<.72||!clearContrast?3:2;
    candidateTrack=same?{
      x:(candidateTrack.x*candidateTrack.count+best.x)/(candidateTrack.count+1),
      y:(candidateTrack.y*candidateTrack.count+best.y)/(candidateTrack.count+1),
      count:candidateTrack.count+1,
      confidenceTotal:candidateTrack.confidenceTotal+best.confidence,
      onset:candidateTrack.onset
    }:{x:best.x,y:best.y,count:1,confidenceTotal:best.confidence,onset:best.onset};
    lastScanFrame=scanFrame;

    if(candidateTrack.count<required){
      drawCandidate(best,data.preview,balanced);
      status(`Atış doğrulanıyor ${candidateTrack.count}/${required} · güven %${Math.round(best.confidence*100)}`);
      return;
    }

    pending={
      ...best,
      x:candidateTrack.x,
      y:candidateTrack.y,
      confidence:candidateTrack.confidenceTotal/candidateTrack.count,
      preview:data.preview,
      current:scanFrame
    };
    candidateTrack=null;
    drawCandidate(pending,data.preview,balanced);
    acceptPending();
    status("Atış otomatik doğrulandı ve dijital hedefe gönderildi.");
  }catch(error){
    candidateTrack=null;
    status(`Algılama hatası: ${error.message}`,true);
  }finally{
    busy=false;
  }
}
function acceptPending(){
  if(!pending)return;
  const accepted=pending;
  const scorePoint=scoringCoordinates(accepted);
  send({type:"shot",x:scorePoint.x,y:scorePoint.y,confidence:accepted.confidence,source:"camera"});
  knownHoles.push({x:accepted.x,y:accepted.y});
  reference=accepted.current.slice();
  referenceTarget=targetSignature(reference)||referenceTarget;
  knownLuminousHoles=luminousHoles(reference);
  lastScanFrame=reference.slice();
  previousScanFrame=reference.slice();
  stableScanCount=0;
  candidateTrack=null;
  wctx.putImageData(accepted.preview,0,0);
  pending=null;
}
async function learnCameraNoise(){if(busy)return;busy=true;try{status("Hedef sabitliği öğreniliyor; 3 saniye hedefe dokunma…");const frames=[];for(let index=0;index<4;index++){if(index)await new Promise(resolve=>setTimeout(resolve,260));const data=await captureStable(),balanced=balanceTarget(data.current),shift=alignment(balanced.gray);frames.push(translateFrame(balanced.gray,shift))}if(!armed)return;noiseFloor=new Uint8Array(SIZE*SIZE);for(let i=0;i<noiseFloor.length;i++){let minimum=255,maximum=0;for(const frame of frames){minimum=Math.min(minimum,frame[i]);maximum=Math.max(maximum,frame[i])}noiseFloor[i]=maximum-minimum}reference=median(frames.slice(-3));referenceTarget=targetSignature(reference)||referenceTarget;lastScanFrame=reference.slice();previousScanFrame=reference.slice();knownHoles=[];knownLuminousHoles=luminousHoles(reference);candidateTrack=null;stableScanCount=0;status(`Işıklı delik kataloğu hazır · ${knownLuminousHoles.length} mevcut parlak nokta · hızlı tarama açık.`);const summary=$("sensorSummary");if(summary)summary.textContent="Algılama açık";$("sensorSetup")?.removeAttribute("open");scanTimer=setInterval(detect,SCAN_INTERVAL_MS)}catch(error){armed=false;status(`Sabitlik öğrenilemedi: ${error.message}`,true)}finally{busy=false}}
function setAutomaticScanning(enabled){clearInterval(scanTimer);scanTimer=null;if(enabled)learnCameraNoise()}
$("reference").onclick=async()=>{try{const data=await captureStable();reference=data.current;referenceTarget=targetSignature(reference);lastScanFrame=reference.slice();previousScanFrame=reference.slice();noiseFloor=null;knownHoles=[];knownLuminousHoles=[];candidateTrack=null;stableScanCount=0;if(!referenceTarget)throw Error("Siyah hedef alanı ölçülemedi. Hedefi kadrajda büyüt ve köşeleri yeniden seç.");knownLuminousHoles=luminousHoles(reference);wctx.putImageData(data.preview,0,0);$("arm").disabled=false;$("test").disabled=false;status(`Temiz referans kilitlendi · siyah çap ${(referenceTarget.radius*2).toFixed(1)} px · ${knownLuminousHoles.length} parlak nokta kataloglandı.`)}catch(e){reference=null;referenceTarget=null;lastScanFrame=null;previousScanFrame=null;noiseFloor=null;knownHoles=[];knownLuminousHoles=[];candidateTrack=null;stableScanCount=0;status(e.message,true)}};
$("arm").onclick=()=>{armed=!armed;setAutomaticScanning(armed);$("arm").textContent=armed?"Otomatik taramayı durdur":"4 · Otomatik taramayı başlat";if(!armed){status("Otomatik tarama durduruldu.");const summary=$("sensorSummary");if(summary)summary.textContent="Algılama durdu"}};$("test").onclick=detect;$("minSize").oninput=e=>$("sizeLabel").textContent=`${Number(e.target.value).toFixed(1)} mm`;$("sensitivity").oninput=e=>$("sensitivityLabel").textContent=["Düşük","Normal","Yüksek"][e.target.value];$("start").onclick=startCamera;connect();

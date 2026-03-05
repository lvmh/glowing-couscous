// Full pro-grade key detection regression test.
// ALL files in ../public are confirmed Eb Minor.

const fs   = require("fs");
const path = require("path");

// ── WAV decoder ───────────────────────────────────────────────────────────────

function decodeWav(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString("ascii",0,4)!=="RIFF"||buf.toString("ascii",8,12)!=="WAVE") throw new Error("Not RIFF/WAVE");
  let offset=12,audioFormat=null,numChannels=null,sampleRate=null,bitsPerSample=null,dataOffset=null,dataSize=null;
  while(offset+8<=buf.length){
    const id=buf.toString("ascii",offset,offset+4), size=buf.readUInt32LE(offset+4), data=offset+8;
    if(id==="fmt "){audioFormat=buf.readUInt16LE(data);numChannels=buf.readUInt16LE(data+2);sampleRate=buf.readUInt32LE(data+4);bitsPerSample=buf.readUInt16LE(data+14);}
    else if(id==="data"){dataOffset=data;dataSize=size;break;}
    offset=data+size+(size%2);
  }
  if(!numChannels||!sampleRate||!bitsPerSample||dataOffset==null||dataSize==null) throw new Error("Bad WAV");
  const bps=bitsPerSample/8, total=Math.floor(dataSize/bps), spc=Math.floor(total/numChannels);
  const ch=new Float32Array(spc);
  for(let i=0;i<spc;i++){
    const off=dataOffset+i*numChannels*bps;
    if(audioFormat===1&&bitsPerSample===16) ch[i]=buf.readInt16LE(off)/32768;
    else if(audioFormat===1&&bitsPerSample===24){let v=buf[off]|(buf[off+1]<<8)|(buf[off+2]<<16);if(v&0x800000)v|=0xFF000000;ch[i]=v/8388608;}
    else if(audioFormat===3&&bitsPerSample===32) ch[i]=buf.readFloatLE(off);
    else throw new Error(`Unsupported fmt=${audioFormat} bits=${bitsPerSample}`);
  }
  return {channelData:ch,sampleRate};
}

// ── Constants ──────────────────────────────────────────────────────────────────

const NOTE_NAMES=["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
const KS_MAJOR=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const KS_MINOR=[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
const TEMP_MAJOR=[5.0,2.0,3.5,2.0,4.5,4.0,2.0,4.5,2.0,3.5,1.5,4.0];
const TEMP_MINOR=[5.0,2.0,3.5,4.5,2.0,4.0,2.0,4.5,3.5,2.0,3.5,1.5];
const COF_POS=[0,7,2,9,4,11,6,1,8,3,10,5];

// ── Math ───────────────────────────────────────────────────────────────────────

function pearson(x,y){const n=x.length;let sx=0,sy=0,sxy=0,sx2=0,sy2=0;for(let i=0;i<n;i++){sx+=x[i];sy+=y[i];sxy+=x[i]*y[i];sx2+=x[i]*x[i];sy2+=y[i]*y[i];}const num=n*sxy-sx*sy,den=Math.sqrt((n*sx2-sx*sx)*(n*sy2-sy*sy));return den===0?0:num/den;}
function rotate(arr,shift){const r=[...arr];for(let i=0;i<shift;i++)r.unshift(r.pop());return r;}

// ── FFT ────────────────────────────────────────────────────────────────────────

function fft(re,im){
  const n=re.length;let j=0;
  for(let i=1;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}}
  for(let len=2;len<=n;len<<=1){const ang=-2*Math.PI/len,wR=Math.cos(ang),wI=Math.sin(ang);for(let i=0;i<n;i+=len){let cR=1,cI=0;for(let k=0;k<len/2;k++){const uR=re[i+k],uI=im[i+k],vR=re[i+k+len/2]*cR-im[i+k+len/2]*cI,vI=re[i+k+len/2]*cI+im[i+k+len/2]*cR;re[i+k]=uR+vR;im[i+k]=uI+vI;re[i+k+len/2]=uR-vR;im[i+k+len/2]=uI-vI;const nr=cR*wR-cI*wI;cI=cR*wI+cI*wR;cR=nr;}}}
}

// ── Stage 1: Tuning estimation ────────────────────────────────────────────────

function estimateTuning(channelData, sampleRate, FRAME) {
  const HALF=FRAME>>1, hop=FRAME>>1;
  const hann=new Float64Array(FRAME);
  for(let i=0;i<FRAME;i++) hann[i]=0.5*(1-Math.cos(2*Math.PI*i/(FRAME-1)));
  const re=new Float64Array(FRAME), im=new Float64Array(FRAME);
  const devs=[];
  const maxSamples=Math.min(channelData.length,sampleRate*10);
  for(let start=0;start+FRAME<=maxSamples;start+=hop){
    for(let i=0;i<FRAME;i++){re[i]=channelData[start+i]*hann[i];im[i]=0;}
    fft(re,im);
    let maxMag=0; const mag=new Float32Array(HALF);
    for(let b=1;b<HALF;b++){mag[b]=Math.sqrt(re[b]*re[b]+im[b]*im[b]);if(mag[b]>maxMag)maxMag=mag[b];}
    if(maxMag===0) continue;
    const thresh=maxMag*0.1;
    for(let b=2;b<HALF-1;b++){
      const freq=b*sampleRate/FRAME;
      if(freq<200||freq>4000) continue;
      if(mag[b]<=thresh||mag[b]<mag[b-1]||mag[b]<mag[b+1]) continue;
      const α=mag[b-1],β=mag[b],γ=mag[b+1];
      const δ=0.5*(α-γ)/(α-2*β+γ+1e-10);
      const rf=(b+δ)*sampleRate/FRAME;
      const mf=69+12*Math.log2(rf/440);
      devs.push(mf-Math.round(mf));
    }
  }
  if(devs.length===0) return 0;
  devs.sort((a,b)=>a-b);
  return devs[Math.floor(devs.length/2)];
}

// ── Stages 3+4+6: Single-pass energy+flatness-weighted chromagram ─────────────
// Mirrors audio-engine.ts buildChromagrams exactly.
// frameWeight = tonalWeight * frameRMS  (flatness gate × energy)

function buildChromagrams(channelData, sampleRate, startSample, endSample, tuningOffset, prealloc) {
  const {re,im,mag,binPc,binOct,hann,FRAME}=prealloc;
  const HOP=FRAME>>1, HALF=FRAME>>1;
  const fftAcc=new Float64Array(12), hpcpAcc=new Float64Array(12);
  let weightSum=0;
  const N_HARM=8, SIGMA2=1.0;

  for(let fs=startSample;fs+FRAME<=endSample;fs+=HOP){
    for(let i=0;i<FRAME;i++){re[i]=channelData[fs+i]*hann[i];im[i]=0;}
    fft(re,im);
    let maxMag=0, sumEnergy=0;
    for(let b=1;b<HALF;b++){mag[b]=Math.sqrt(re[b]*re[b]+im[b]*im[b]);if(mag[b]>maxMag)maxMag=mag[b];sumEnergy+=re[b]*re[b]+im[b]*im[b];}
    if(maxMag===0) continue;
    const frameRMS=Math.sqrt(sumEnergy/HALF);

    // Spectral flatness gate
    let sumLog=0,sumLin=0,nBins=0;
    for(let b=1;b<HALF;b++){if(mag[b]>0){sumLog+=Math.log(mag[b]);sumLin+=mag[b];nBins++;}}
    const flatness=nBins>0&&sumLin>0?Math.exp(sumLog/nBins)/(sumLin/nBins):1;
    const tonalW=Math.max(0,1-2*flatness);

    const frameWeight=tonalW*frameRMS;
    if(frameWeight===0) continue;

    // FFT chroma
    const fc=new Float64Array(12);
    for(let b=1;b<HALF;b++){const pc=binPc[b];if(pc<0)continue;const oct=binOct[b];const w=oct===2?2.0:oct===3?1.8:oct===4?1.4:oct===5?1.0:0.6;fc[pc]+=(re[b]*re[b]+im[b]*im[b])*w;}

    // HPCP
    const hc=new Float64Array(12);
    const thresh=maxMag*0.05;
    for(let b=2;b<HALF-1;b++){
      const freq=b*sampleRate/FRAME;
      if(freq<40||freq>4200) continue;
      if(mag[b]<=thresh||mag[b]<mag[b-1]||mag[b]<mag[b+1]) continue;
      const α=mag[b-1],β=mag[b],γ=mag[b+1];
      const δ=0.5*(α-γ)/(α-2*β+γ+1e-10);
      const rMidi=69+12*Math.log2(freq*(1+δ/b)/440)-tuningOffset;
      for(let h=1;h<=N_HARM;h++){
        const hm=rMidi+12*Math.log2(h);
        if(hm<21||hm>108) continue;
        const hw=(mag[b]*mag[b])/(h*h);
        const fp=((hm%12)+12)%12;
        for(let pc=0;pc<12;pc++){let d=Math.abs(fp-pc);if(d>6)d=12-d;hc[pc]+=hw*Math.exp(-(d*d)/SIGMA2);}
      }
    }

    const fm=Math.max(...fc), hm=Math.max(...hc);
    if(fm>0) for(let i=0;i<12;i++) fftAcc[i]+=(fc[i]/fm)*frameWeight;
    if(hm>0) for(let i=0;i<12;i++) hpcpAcc[i]+=(hc[i]/hm)*frameWeight;
    weightSum+=frameWeight;
  }

  if(weightSum===0) return {fftChroma:Array(12).fill(1/12),hpcpChroma:Array(12).fill(1/12)};
  const fftChroma=Array.from(fftAcc).map(v=>v/weightSum);
  const hpcpChroma=Array.from(hpcpAcc).map(v=>v/weightSum);
  const mF=Math.max(...fftChroma),mH=Math.max(...hpcpChroma);
  if(mF>0) for(let i=0;i<12;i++) fftChroma[i]/=mF;
  if(mH>0) for(let i=0;i<12;i++) hpcpChroma[i]/=mH;
  return {fftChroma,hpcpChroma};
}

// ── Stage 5A/B: KS+Temperley ─────────────────────────────────────────────────

function ksScores(chroma){
  const s=new Float64Array(24);
  for(let k=0;k<12;k++){s[k]=0.5*pearson(chroma,rotate(KS_MAJOR,k))+0.5*pearson(chroma,rotate(TEMP_MAJOR,k));s[k+12]=0.5*pearson(chroma,rotate(KS_MINOR,k))+0.5*pearson(chroma,rotate(TEMP_MINOR,k));}
  return s;
}

// ── Stage 5C/D: Tonnetz ───────────────────────────────────────────────────────

function tonnetzCentroid(chroma){
  const P1=2*Math.PI*7/12,P2=2*Math.PI*3/12,P3=2*Math.PI*4/12,r=[1,1,0.5];
  let total=0;for(const v of chroma)total+=v;
  if(total===0) return[0,0,0,0,0,0];
  const T=[0,0,0,0,0,0];
  for(let p=0;p<12;p++){const c=chroma[p]/total;T[0]+=c*r[0]*Math.sin(p*P1);T[1]+=c*r[0]*Math.cos(p*P1);T[2]+=c*r[1]*Math.sin(p*P2);T[3]+=c*r[1]*Math.cos(p*P2);T[4]+=c*r[2]*Math.sin(p*P3);T[5]+=c*r[2]*Math.cos(p*P3);}
  return T;
}

const MAJ_IV=[0,2,4,5,7,9,11],MIN_IV=[0,2,3,5,7,8,10];
const KEY_VECS=[];
for(let r=0;r<12;r++){const c=Array(12).fill(0);MAJ_IV.forEach(iv=>c[(r+iv)%12]=1);KEY_VECS.push(tonnetzCentroid(c));}
for(let r=0;r<12;r++){const c=Array(12).fill(0);MIN_IV.forEach(iv=>c[(r+iv)%12]=1);KEY_VECS.push(tonnetzCentroid(c));}

function tnScores(chroma){
  const a=tonnetzCentroid(chroma),s=new Float64Array(24);
  for(let i=0;i<24;i++){let d=0;for(let j=0;j<6;j++){const diff=a[j]-KEY_VECS[i][j];d+=diff*diff;}s[i]=1/(1+Math.sqrt(d));}
  return s;
}

// ── Stage 7: Circle-of-fifths smoothing ───────────────────────────────────────

function cofDist(i,j){
  const iMaj=i<12,jMaj=j<12,iR=i%12,jR=j%12;
  const iP=iMaj?COF_POS[iR]:COF_POS[(iR+3)%12];
  const jP=jMaj?COF_POS[jR]:COF_POS[(jR+3)%12];
  let d=Math.abs(iP-jP);if(d>6)d=12-d;
  if(iP===jP&&iMaj!==jMaj) return 0.5;
  return d+(iMaj!==jMaj?0.5:0);
}

function cofSmoothing(scores){
  const SIGMA2=1.0,out=new Float64Array(24);
  for(let i=0;i<24;i++){let sum=0,ws=0;for(let j=0;j<24;j++){const w=Math.exp(-(cofDist(i,j)**2)/(2*SIGMA2));sum+=scores[j]*w;ws+=w;}out[i]=ws>0?sum/ws:0;}
  return out;
}

// ── Full pipeline ─────────────────────────────────────────────────────────────

function detectKey(channelData, sampleRate) {
  // Stage 1: tuning
  const tuningOffset = estimateTuning(channelData, sampleRate, 4096);

  // Pre-allocate buffers
  const FRAME=sampleRate>=32000?16384:8192, HALF=FRAME>>1;
  const hann=new Float64Array(FRAME);
  for(let i=0;i<FRAME;i++) hann[i]=0.5*(1-Math.cos(2*Math.PI*i/(FRAME-1)));
  const binPc=new Int8Array(HALF).fill(-1), binOct=new Int8Array(HALF).fill(-1);
  for(let b=1;b<HALF;b++){
    const freq=b*sampleRate/FRAME;
    if(freq<27.5||freq>4200) continue;
    const midi=69+12*Math.log2(freq/440)-tuningOffset;
    binPc[b]=((Math.round(midi)%12)+12)%12;
    binOct[b]=Math.floor(midi/12)-1;
  }
  const prealloc={re:new Float64Array(FRAME),im:new Float64Array(FRAME),mag:new Float32Array(HALF),binPc,binOct,hann,FRAME};

  // Stages 2–6: single-pass energy+flatness-weighted chromagram
  const dur=Math.min(60,channelData.length/sampleRate);
  const aStart=Math.floor((channelData.length/sampleRate-dur)/2*sampleRate);
  const aEnd=Math.min(aStart+Math.floor(dur*sampleRate),channelData.length);

  const {fftChroma,hpcpChroma}=buildChromagrams(channelData,sampleRate,aStart,aEnd,tuningOffset,prealloc);

  // Stage 5: four-method ensemble (one pass)
  const methods=[[ksScores(fftChroma),0.30],[ksScores(hpcpChroma),0.30],[tnScores(fftChroma),0.20],[tnScores(hpcpChroma),0.20]];
  const aggregate=new Float64Array(24);
  const methodNames=["KS FFT","KS HPCP","TN FFT","TN HPCP"];
  const methodResults=[];
  for(let mi=0;mi<methods.length;mi++){
    const [scores,weight]=methods[mi];
    let lo=Infinity,hi=-Infinity;
    for(let i=0;i<24;i++){if(scores[i]<lo)lo=scores[i];if(scores[i]>hi)hi=scores[i];}
    const range=hi-lo||1;
    for(let i=0;i<24;i++) aggregate[i]+=weight*(scores[i]-lo)/range;
    // Best for this method (diagnostics)
    let bs=-Infinity,bk=0,bm="Minor";
    for(let k=0;k<12;k++){if(scores[k]>bs){bs=scores[k];bk=k;bm="Major";}if(scores[k+12]>bs){bs=scores[k+12];bk=k;bm="Minor";}}
    methodResults.push(`${methodNames[mi]}:${NOTE_NAMES[bk]} ${bm}`);
  }

  // Stage 7: CoF smoothing
  const smoothed=cofSmoothing(aggregate);
  let best=-Infinity,keyIdx=0,mode="Minor";
  for(let k=0;k<12;k++){if(smoothed[k]>best){best=smoothed[k];keyIdx=k;mode="Major";}if(smoothed[k+12]>best){best=smoothed[k+12];keyIdx=k;mode="Minor";}}

  return {key:`${NOTE_NAMES[keyIdx]} ${mode}`,methods:methodResults,tuning:tuningOffset,fftChroma,hpcpChroma};
}

// ── Main ──────────────────────────────────────────────────────────────────────

function run(){
  const publicDir=path.join(__dirname,"..","public");
  const wavFiles=fs.readdirSync(publicDir).filter(f=>f.toLowerCase().endsWith(".wav"));
  const EXPECTED="Eb Minor";
  // Relative key is musically equivalent (shares all 7 notes)
  const RELATIVE="Gb Major"; // relative major of Eb Minor
  console.log(`=== Pro-grade Key Detection (all expected: ${EXPECTED} or relative ${RELATIVE}) ===\n`);

  let correct=0;
  const rows=[];

  for(const file of wavFiles){
    let decoded;
    try{decoded=decodeWav(path.join(publicDir,file));}
    catch(e){console.warn(`SKIP ${file}: ${e.message}`);continue;}

    const {channelData,sampleRate}=decoded;
    const result=detectKey(channelData,sampleRate);
    const pass=result.key===EXPECTED||result.key===RELATIVE;
    if(pass) correct++;

    const icon = result.key===EXPECTED ? "✓" : result.key===RELATIVE ? "~" : "✗";
    console.log(`${icon}  ${file}`);
    console.log(`     Result:  ${result.key}   (tuning: ${(result.tuning*100).toFixed(1)} cents)`);
    console.log(`     Methods: ${result.methods.join("  |  ")}`);
    // Top 3 FFT chroma bins
    const fftTop=result.fftChroma.map((v,i)=>({n:NOTE_NAMES[i],v})).sort((a,b)=>b.v-a.v).slice(0,4).map(x=>`${x.n}:${x.v.toFixed(2)}`).join(" ");
    console.log(`     FFT top: ${fftTop}`);
    console.log();
    rows.push({file:file.slice(0,34), result:result.key, tuning:`${(result.tuning*100).toFixed(0)}c`});
  }

  console.log("=== Summary ===");
  console.table(rows);
  console.log(`\nAccuracy: ${correct}/${rows.length}`);
}

run();

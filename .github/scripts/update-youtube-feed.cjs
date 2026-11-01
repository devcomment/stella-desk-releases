'use strict';

// This standalone publisher runs in the public distribution repository.
// It contains no desktop application code, account cookies or signing keys.
const {createHash}=require('node:crypto');
const REPO='devcomment/stella-desk-releases',TAG='lounge-videos',ASSET='youtube.json',DAY=86400000;
const MEMBERS={
  mary:{query:'토키노 메리|토키노메리|Tokino Mary',full:['토키노메리','tokinomary'],short:'메리'},
  hiyori:{query:'하나요 히요리|하나요히요리|Hanayo Hiyori',full:['하나요히요리','hanayohiyori'],short:'히요리'}
};
function text(value,max=180){return typeof value==='string'?value.replace(/&(?:amp|lt|gt|quot|apos|#39);/g,s=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'"}[s])).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max):'';}
function relevant(member,snippet){
  const words=[snippet.title,snippet.description,snippet.channelTitle].filter(v=>typeof v==='string').join(' ').normalize('NFKC').toLowerCase().replace(/\s+/g,'');
  const m=MEMBERS[member];return m.full.some(name=>words.includes(name))||(words.includes(m.short)&&/스텔라이브|stellive/.test(words));
}
async function json(response){
  if(!response.ok){await response.body?.cancel();throw Error('HTTP_'+response.status);}
  if(!response.body||Number(response.headers.get('content-length'))>2*1024*1024){await response.body?.cancel();throw Error('RESPONSE_SIZE');}
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>2*1024*1024)throw Error('RESPONSE_SIZE');chunks.push(part.value);}}
  finally{await reader.cancel().catch(()=>{});}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('RESPONSE_FORMAT');}
}
async function buildFeed({key,fetcher=fetch,now=Date.now()}={}){
  if(typeof key!=='string'||!/^AIza[A-Za-z0-9_-]{35}$/.test(key))throw Error('YOUTUBE_KEY_REQUIRED');
  const generatedAt=new Date(now).toISOString(),after=new Date(now-30*DAY).toISOString(),members={};
  async function api(method,params){
    const url=new URL('https://www.googleapis.com/youtube/v3/'+method);url.search=new URLSearchParams({...params,key}).toString();
    return json(await fetcher(url.href,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(20000),headers:{Accept:'application/json'}}));
  }
  for(const [member,config]of Object.entries(MEMBERS)){
    const search=await api('search',{part:'snippet',type:'video',q:config.query,order:'viewCount',publishedAfter:after,publishedBefore:generatedAt,maxResults:'50',relevanceLanguage:'ko',regionCode:'KR',safeSearch:'moderate',fields:'items(id/videoId)'});
    if(!Array.isArray(search.items))throw Error('SEARCH_FORMAT');
    const ids=[...new Set(search.items.map(item=>item?.id?.videoId).filter(id=>typeof id==='string'&&/^[A-Za-z0-9_-]{11}$/.test(id)))];
    if(!ids.length){members[member]=[];continue;}
    const videos=await api('videos',{part:'snippet,statistics,status',id:ids.join(','),fields:'items(id,snippet(title,description,channelTitle,publishedAt,liveBroadcastContent),statistics/viewCount,status/privacyStatus)'});
    if(!Array.isArray(videos.items))throw Error('VIDEOS_FORMAT');
    const seen=new Set();members[member]=[];
    for(const row of videos.items){
      const snippet=row?.snippet,views=Number(row?.statistics?.viewCount),date=Date.parse(snippet?.publishedAt);
      if(!ids.includes(row?.id)||seen.has(row.id)||!snippet||!relevant(member,snippet)||row.status?.privacyStatus!=='public'||snippet.liveBroadcastContent!=='none'||!Number.isSafeInteger(views)||views<0||!Number.isFinite(date)||date<now-30*DAY||date>now)continue;
      const title=text(snippet.title),channel=text(snippet.channelTitle,100);if(!title||!channel)continue;
      seen.add(row.id);members[member].push({id:row.id,title,channel,views,publishedAt:new Date(date).toISOString(),thumbnail:'https://i.ytimg.com/vi/'+row.id+'/mqdefault.jpg'});
    }
    members[member].sort((a,b)=>b.views-a.views||b.publishedAt.localeCompare(a.publishedAt)||a.id.localeCompare(b.id));members[member]=members[member].slice(0,12);
  }
  return{schema:1,generatedAt,periodDays:30,refreshHours:6,members};
}
async function publishFeed(feed,{token,sha,fetcher=fetch}={}){
  if(!token||!/^[a-f0-9]{40}$/.test(sha||''))throw Error('PUBLISH_CONFIG');
  async function api(endpoint,method='GET',body,upload=false){
    const u=new URL(endpoint,'https://api.github.com');
    if(u.origin!==(upload?'https://uploads.github.com':'https://api.github.com')||!u.pathname.startsWith('/repos/'+REPO+'/'))throw Error('PUBLISH_DESTINATION');
    const response=await fetcher(u.href,{method,redirect:'error',signal:AbortSignal.timeout(25000),headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':upload?'application/json':'application/json'},...(body===undefined?{}:{body:upload?body:JSON.stringify(body)})});
    if(method==='GET'&&response.status===404){await response.body?.cancel();return null;}
    if(response.status===204)return null;
    return json(response);
  }
  let release=await api('/repos/'+REPO+'/releases/tags/'+TAG);
  if(!release)release=await api('/repos/'+REPO+'/releases','POST',{tag_name:TAG,target_commitish:sha,name:'라운지 영상 목록',body:'앱에서 사용하는 유튜브 영상 목록입니다. 설치 파일은 버전별 배포에서 받아 주세요.',draft:false,prerelease:true,make_latest:'false'});
  if(release.tag_name!==TAG||release.draft||release.prerelease!==true||!Array.isArray(release.assets)||release.assets.some(asset=>asset.name!==ASSET&&!/^youtube-next-[a-f0-9]{16}\.json$/.test(asset.name)))throw Error('PUBLISH_RELEASE');
  const bytes=Buffer.from(JSON.stringify(feed)+'\n'),digest=createHash('sha256').update(bytes).digest('hex'),temp='youtube-next-'+digest.slice(0,16)+'.json';
  // Upload successfully before replacing the one mutable feed. Versioned app
  // releases and their update signatures/blockmaps are never touched here.
  let next=release.assets.find(asset=>asset.name===temp);
  if(!next)next=await api('https://uploads.github.com/repos/'+REPO+'/releases/'+release.id+'/assets?name='+temp,'POST',bytes,true);
  if(next.state!=='uploaded'||next.size!==bytes.length||next.digest!=='sha256:'+digest)throw Error('UPLOAD_VERIFY');
  const previous=release.assets.find(asset=>asset.name===ASSET);
  if(previous)await api('/repos/'+REPO+'/releases/assets/'+previous.id,'DELETE');
  await api('/repos/'+REPO+'/releases/assets/'+next.id,'PATCH',{name:ASSET});
  for(const asset of release.assets)if(asset.name!==ASSET&&asset.id!==next.id)await api('/repos/'+REPO+'/releases/assets/'+asset.id,'DELETE');
  const published=await api('/repos/'+REPO+'/releases/tags/'+TAG);
  if(published?.assets.find(asset=>asset.name===ASSET)?.digest!=='sha256:'+digest)throw Error('PUBLISH_VERIFY');
  return{generatedAt:feed.generatedAt,counts:Object.fromEntries(Object.entries(feed.members).map(([member,items])=>[member,items.length]))};
}
async function main(){
  if(process.env.GITHUB_REPOSITORY!==REPO)throw Error('PUBLISH_DESTINATION');
  await purgeExpiredFeed({token:process.env.GITHUB_TOKEN});
  if(!process.env.YOUTUBE_API_KEY){console.log('::notice::YOUTUBE_API_KEY를 저장소 Actions secret에 등록하면 목록 갱신이 시작됩니다.');return;}
  const feed=await buildFeed({key:process.env.YOUTUBE_API_KEY});
  console.log(JSON.stringify(await publishFeed(feed,{token:process.env.GITHUB_TOKEN,sha:process.env.GITHUB_SHA})));
}
async function purgeExpiredFeed({token,fetcher=fetch,now=Date.now()}={}){
  if(!token)throw Error('PUBLISH_CONFIG');
  const options={redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json'}};
  const response=await fetcher('https://api.github.com/repos/'+REPO+'/releases/tags/'+TAG,options);
  if(response.status===404){await response.body?.cancel();return;}
  const release=await json(response);
  if(release.tag_name!==TAG||release.draft||release.prerelease!==true||!Array.isArray(release.assets))throw Error('PUBLISH_RELEASE');
  for(const asset of release.assets){
    const created=Date.parse(asset.created_at);
    if((asset.name===ASSET||/^youtube-next-[a-f0-9]{16}\.json$/.test(asset.name))&&Number.isSafeInteger(asset.id)&&Number.isFinite(created)&&now-created>=30*DAY){
      const removed=await fetcher('https://api.github.com/repos/'+REPO+'/releases/assets/'+asset.id,{...options,method:'DELETE'});
      if(removed.status!==204){await removed.body?.cancel();throw Error('EXPIRED_FEED_CLEANUP');}
    }
  }
}
if(require.main===module)main().catch(error=>{console.error('YouTube feed update failed: '+(/^[A-Z_0-9]+$/.test(error.message)?error.message:'NETWORK_OR_RESPONSE'));process.exitCode=1;});
module.exports={buildFeed,publishFeed,purgeExpiredFeed,relevant};

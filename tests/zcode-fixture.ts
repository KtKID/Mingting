// Native transport fixture: the fake operation runs only after the real ACP
// permission callback has returned through the bridge's native response channel.
export const fakeZcodeNative = `#!/usr/bin/env node
(async()=>{
const {createInterface}=await import('node:readline'), fs=await import('node:fs');
const write=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const event=(type,payload)=>write({method:'session/event',params:{sessionId:'native-session',type,payload}});
let scenario='', finished=false, replyCount=0;
const finish=response=>{
 if(finished)return;finished=true;
 event('model.streaming',{kind:'text_delta',delta:response});
 event('turn.completed',{resultType:'success'});
};
const permission=(id=901,sessionId='native-session',path='HELLO.txt')=>write({id,method:'interaction/requestPermission',params:{requestId:'permission-1',sessionId,toolCallId:'t',toolName:'Read',reason:'Read requires approval',input:{file_path:path},options:[
 {optionId:'native-allow',name:'Allow once',kind:'allow_once',response:{decision:'allow',reason:'Approved once'}},
 {optionId:'native-project',name:'Allow in project',kind:'allow_always',response:{decision:'allow',permissionUpdates:[{type:'addRules',behavior:'allow',rules:[{toolName:'Read'}]}]}},
 {optionId:'native-deny',name:'Deny',kind:'deny',response:{decision:'deny',reason:'User denied operation'}}
 ]}});
createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);
 if(frame.jsonrpc)throw Error('native frames must omit jsonrpc');
 if(!frame.method){
  if(frame.id===901 || frame.id===902){
   replyCount++;
   if(frame.result?.decision==='allow')fs.writeFileSync('executed.txt','approved');
   if(scenario==='permission-reannounce' && replyCount<2)return;
   finish('native:'+JSON.stringify(frame.result??frame.error));
  }
  return;
 }
 if(frame.method==='provider/updateAccountConfig')return write({id:frame.id,result:{status:'received'}});
 if(frame.method==='session/create'){
  if(frame.params.mode!=='plan'||JSON.stringify(frame.params.toolAllowlist)!=='["Read"]')throw Error('lost read-only fence');
  write({id:900,method:'session/requestRuntimePreferences',params:{sessionId:'native-session'}});
  return write({id:frame.id,result:{session:{sessionId:'native-session'}}});
 }
 if(frame.method==='session/subscribe')return write({id:frame.id,result:{sessionId:'native-session',eventSeq:0,events:[]}});
 if(frame.method==='session/stop'){write({id:frame.id,result:{}});return finish('cancelled')}
 if(frame.method==='session/send'){
  scenario=frame.params.content;write({id:frame.id,result:{accepted:true}});
  if(scenario==='invalid'){console.log('{invalid}');return}
  if(scenario==='exit'){process.exit(7)}
  event('model.streaming',{kind:'reasoning_delta',delta:'读取问候'});
  event('tool.updated',{kind:'scheduled',toolCallId:'t',toolName:'Read',input:{path:'HELLO.txt'}});
  if(scenario.startsWith('permission-')){
   permission(901,scenario==='permission-other-session'?'wrong-session':'native-session');
   if(scenario==='permission-reannounce')setTimeout(()=>permission(902),20);
   return;
  }
  if(scenario==='cancel')return;
  const response=scenario==='env-check'?JSON.stringify({data:process.env.ZCODE_DATA_BASE_DIR,home:process.env.ZCODE_HOME,userHome:process.env.HOME}):'你好';
  const bytes=Buffer.from(JSON.stringify({method:'session/event',params:{sessionId:'native-session',type:'model.streaming',payload:{kind:'text_delta',delta:response}}})+'\\n');
  for(let i=0;i<bytes.length;i+=2)process.stdout.write(bytes.subarray(i,i+2));
  event('tool.updated',{kind:'batch',toolCallIds:[]});
  event('tool.updated',{kind:'result',toolCallId:'t',result:{success:true,content:'hi'}});
  setTimeout(()=>{event('turn.completed',{resultType:'success'});finished=true},200);
 }
});
})();
`;

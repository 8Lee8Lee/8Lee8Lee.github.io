const http=require('node:http');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {capturePair,normalizeURL}=require('./capture.cjs');
const PORT=4318, SITE='https://8lee8lee.github.io/capture/';
const origins=new Set(['https://8lee8lee.github.io',`http://127.0.0.1:${PORT}`,`http://localhost:${PORT}`]);
const key=crypto.randomBytes(24).toString('hex');
let job=null,root;
async function readBody(req){
  const chunks=[];let size=0;
  for await(const chunk of req){if((size+=chunk.length)>8192)throw new Error('요청이 너무 큽니다.');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function capture(input){
  try{
    await fs.rm(root,{recursive:true,force:true});await fs.mkdir(root);
    job.results=await capturePair(input,root,progress=>Object.assign(job,progress));
    job.status='done';job.message='캡처 완료';
  }catch(error){job.status='error';job.error=String(error.message).slice(0,400);}
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const send=(code,data,type='application/json; charset=utf-8')=>{res.writeHead(code,{'Content-Type':type});res.end(Buffer.isBuffer(data)||typeof data==='string'?data:JSON.stringify(data));};
  try{
    if(![`127.0.0.1:${PORT}`,`localhost:${PORT}`].includes(req.headers.host))return send(403,{error:'잘못된 호스트입니다.'});
    const origin=req.headers.origin;
    if(origin&&!origins.has(origin))return send(403,{error:'허용되지 않은 출처입니다.'});
    if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    res.setHeader('Access-Control-Allow-Private-Network','true');
    if(req.method==='OPTIONS'){
      res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, X-Capture-Key');return send(204,'');
    }
    const url=new URL(req.url,`http://127.0.0.1:${PORT}`);
    if(req.method==='GET'&&url.pathname==='/'){
      res.writeHead(302,{Location:`/capture/#key=${key}`});return res.end();
    }
    if(req.method==='GET'&&['/capture/','/capture/index.html'].includes(url.pathname))return send(200,await fs.readFile(path.join(__dirname,'..','index.html')),'text/html; charset=utf-8');
    const supplied=Buffer.from(String(req.headers['x-capture-key']||''));
    if(supplied.length!==key.length||!crypto.timingSafeEqual(supplied,Buffer.from(key)))return send(401,{error:'실행 파일이 연 캡처 페이지를 사용해 주세요. 연결 키가 없거나 만료됐습니다.'});
    if(req.method==='GET'&&url.pathname==='/health')return send(200,{service:'portfolio-capture',version:1});
    if(req.method==='POST'&&url.pathname==='/capture'){
      if(job?.status==='running')return send(409,{error:'캡처가 진행 중입니다. 잠시 기다려 주세요.'});
      const input=await readBody(req);input.url=normalizeURL(input.url);
      job={id:crypto.randomUUID(),status:'running',message:'페이지를 여는 중'};
      send(202,{id:job.id});void capture(input);return;
    }
    if(req.method==='GET'&&url.pathname==='/status'){
      if(!job||url.searchParams.get('id')!==job.id)return send(404,{error:'이전 결과가 만료됐습니다. 다시 캡처해 주세요.'});
      return send(200,job);
    }
    if(req.method==='GET'&&['/desktop.png','/mobile.png'].includes(url.pathname)){
      if(job?.status!=='done'||url.searchParams.get('id')!==job.id)return send(409,{error:'먼저 캡처를 완료해 주세요.'});
      return send(200,await fs.readFile(path.join(root,url.pathname.slice(1))),'image/png');
    }
    send(404,{error:'요청을 찾을 수 없습니다.'});
  }catch(error){if(!res.headersSent)send(400,{error:String(error.message).slice(0,300)});else res.end();}
});
async function main(){
  root=await fs.mkdtemp(path.join(os.tmpdir(),'portfolio-capture-'));
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'이미 실행 중입니다. 기존 터미널을 확인해 주세요.':error.message);process.exitCode=1;});
  server.listen(PORT,'127.0.0.1',()=>{
    console.log('\n캡처 엔진 준비 완료. 이 터미널을 켜 두세요.\n연결이 안 되면 http://127.0.0.1:4318/ 을 열어 주세요.\n종료: Ctrl+C\n');
    if(!process.argv.includes('--no-open')){
      const child=spawn(process.platform==='darwin'?'open':'xdg-open',[SITE+'#key='+key],{stdio:'ignore',detached:true});child.on('error',()=>{});child.unref();
    }
  });
  for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{await fs.rm(root,{recursive:true,force:true});process.exit();});
}
main();

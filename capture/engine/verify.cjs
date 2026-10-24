const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
const { capturePair } = require('./capture.cjs');

const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}html,body{margin:0}body{background:#f7f7f7}
#content{height:3000px}#lazy{height:500px;background:#222}
#popup{position:fixed;inset:0;background:#e33939;z-index:99}
button{position:absolute;right:20px;top:20px}
</style></head><body><main id="content">Full-page capture test</main>
<footer id="lazy">Lazy content</footer>
<div id="popup" role="dialog" aria-label="Newsletter"><button onclick="document.getElementById('popup').remove()">닫기</button></div>
<script>
new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))document.getElementById('lazy').style.background='#ffd93d';}).observe(document.getElementById('lazy'));
</script></body></html>`;

function pixel(image,x,y){
  const offset=(image.width*y+x)*4;
  return [...image.data.subarray(offset,offset+3)];
}
const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fixture);});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-check-'));
  try{
    for(const closePopups of [true,false]){
      const dir=path.join(root,closePopups?'closed':'visible');
      await fs.mkdir(dir);
      const results=await capturePair({url,closePopups},dir,()=>{}, {allowPrivate:true});
      for(const result of results){
        const image=PNG.sync.read(await fs.readFile(path.join(dir,result.id+'.png')));
        const scale=result.id==='mobile'?2:1;
        assert.equal(image.width,result.id==='mobile'?720:1080,'output width');
        assert.equal(image.height,3500*scale,'full-page height');
        assert.deepEqual(pixel(image,100*scale,200*scale),closePopups?[247,247,247]:[227,57,57],'popup visibility');
        assert.deepEqual(pixel(image,100*scale,3400*scale),[255,217,61],'lazy content at page bottom');
        assert.equal(result.dismissed>0,closePopups,'popup close action');
        console.log('PASS',result.id,closePopups?'popup closed':'popup kept',image.width+'x'+image.height,'bottom content visible');
      }
    }
  } finally {await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>server.close());

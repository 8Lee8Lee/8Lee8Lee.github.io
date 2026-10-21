const { chromium } = require('playwright');
const dns = require('node:dns').promises;
const { BlockList, isIP } = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');

const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(ip,bits,'ipv4');
for (const [ip,bits] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8]]) blocked.addSubnet(ip,bits,'ipv6');

function normalizeURL(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('올바른 웹페이지 주소를 입력해 주세요.');
  let u;
  try { u = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : 'https://' + value.trim()); } catch { throw new Error('웹페이지 주소 형식을 확인해 주세요.'); }
  if (!['https:','http:'].includes(u.protocol) || !u.hostname || u.username || u.password) throw new Error('로그인 정보가 없는 http 또는 https 주소를 사용해 주세요.');
  return u.href;
}
async function publicURL(value) {
  const u = new URL(value);
  if (!['http:','https:'].includes(u.protocol)) return;
  const host = u.hostname.replace(/^\[|\]$/g,'');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('공개된 웹사이트 주소를 입력해 주세요.');
  const addresses = isIP(host) ? [{address:host,family:isIP(host)}] : await dns.lookup(host,{all:true});
  if (!addresses.length || addresses.some(a=>blocked.check(a.address,a.family === 6 ? 'ipv6':'ipv4'))) throw new Error('내부 네트워크 주소는 캡처하지 않습니다.');
}

async function dismissOverlays(page) {
  let count = 0;
  const closeName = /^(닫기|창 닫기|팝업 닫기|오늘 하루 보지 않기|오늘은 그만 보기|나중에|아니요|괜찮아요|close|close dialog|close modal|close popup|dismiss|no thanks|no, thanks|not now|maybe later|×|✕|x)$/i;
  const rejectName = /^(거부|모두 거부|선택 쿠키 거부|필수만 허용|필수 쿠키만 허용|reject all|reject optional cookies|decline|deny|necessary only|only necessary|continue without accepting)$/i;
  const containers = '[role="dialog"],[aria-modal="true"],dialog,[class*="modal" i],[id*="modal" i],[class*="popup" i],[id*="popup" i],[class*="cookie" i],[id*="cookie" i],[id*="consent" i],[class*="consent" i]';
  for (const frame of page.frames()) {
    try {
      // Recognized CMP controls; never click Accept or purchase/submit controls.
      for (const selector of ['#onetrust-reject-all-handler','#CybotCookiebotDialogBodyButtonDecline','[data-testid="uc-deny-all-button"]']) {
        const el=frame.locator(selector).first();
        if(await el.isVisible().catch(()=>false)) {await el.click({timeout:700});count++;}
      }
      const dialogs=frame.locator(containers);
      for(let i=0;i<Math.min(await dialogs.count(),35);i++) {
        const box=dialogs.nth(i);
        if(!await box.isVisible().catch(()=>false)) continue;
        let buttons=box.getByRole('button',{name:rejectName});
        if(!await buttons.count()) buttons=box.getByRole('button',{name:closeName});
        if(!await buttons.count()) buttons=box.locator('[aria-label="Close" i],[aria-label="닫기"],[data-dismiss="modal"],[data-bs-dismiss="modal"]');
        for(let j=0;j<Math.min(await buttons.count(),4);j++) {
          const button=buttons.nth(j);
          if(await button.isVisible().catch(()=>false)) {
            await button.click({timeout:700}).then(()=>count++).catch(()=>{}); break;
          }
        }
      }
    } catch { /* Cross-frame navigations and closed frames are harmless. */ }
  }
  return count;
}

async function preparePage(page, options, report) {
  let dismissed=0;
  await page.waitForLoadState('networkidle',{timeout:4000}).catch(()=>{});
  await page.waitForTimeout(options.waitMs);
  if(options.popupMode==='auto') dismissed+=await dismissOverlays(page);
  await page.evaluate(()=>Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,5000))])).catch(()=>{});
  await page.addStyleTag({content:'html { scroll-behavior: auto !important; }'}).catch(()=>{});
  report('이미지와 스크롤 콘텐츠를 불러오는 중');
  let reachedBottom=false;
  const started=Date.now();
  for(let i=0;i<160 && Date.now()-started<45000;i++) {
    const metrics=await page.evaluate(()=>({y:window.scrollY,h:Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0),v:innerHeight}));
    if(metrics.h>options.maxHeight) throw new Error('페이지가 너무 깁니다. 무한 스크롤 페이지이거나 캡처 한도(50,000px)를 넘었습니다.');
    if(metrics.y+metrics.v>=metrics.h-4) {reachedBottom=true;break;}
    await page.evaluate(()=>window.scrollBy(0,Math.round(innerHeight*.8)));
    await page.waitForTimeout(140);
    if(options.popupMode==='auto' && i%8===0) dismissed+=await dismissOverlays(page);
  }
  if(!reachedBottom) throw new Error('페이지 끝까지 스크롤하지 못했습니다. 팝업 자동 닫기를 켜고 다시 시도해 주세요.');
  await page.evaluate(()=>Promise.race([Promise.all([...document.images].map(i=>i.complete?Promise.resolve():new Promise(r=>{i.onload=r;i.onerror=r;}))),new Promise(r=>setTimeout(r,5000))]));
  if(options.popupMode==='auto') dismissed+=await dismissOverlays(page);
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.waitForTimeout(700);
  return dismissed;
}

async function capturePair(input, directory, onProgress=()=>{}, extra={}) {
  const url=normalizeURL(input.url);
  const allowPrivate=extra.allowPrivate===true; // Explicit test harness only; never exposed by HTTP API.
  if(!allowPrivate) await publicURL(url);
  const popupMode=input.closePopups===false?'keep':'auto';
  const waitMs=1200;
  const browser=await chromium.launch({headless:true,...extra.launchOptions});
  const results=[];
  try {
    for (const device of [{id:'desktop',name:'데스크톱',width:1080,height:900,scale:1},{id:'mobile',name:'모바일',width:360,height:800,scale:2}]) {
      const context=await browser.newContext({viewport:{width:device.width,height:device.height},deviceScaleFactor:device.scale,isMobile:device.id==='mobile',hasTouch:device.id==='mobile',locale:'ko-KR',serviceWorkers:'block',acceptDownloads:false,...(device.id==='mobile'?{userAgent:'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36'}:{})});
      if(!allowPrivate) await context.route('**/*',async route=>{
        try {await publicURL(route.request().url());await route.continue();} catch {await route.abort().catch(()=>{});}
      });
      const page=await context.newPage();
      page.setDefaultTimeout(12000);
      page.on('dialog',d=>d.dismiss().catch(()=>{}));
      page.on('popup',p=>p.close().catch(()=>{}));
      const report=message=>onProgress({device:device.id,message:`${device.name} · ${message}`});
      report('페이지를 여는 중');
      const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
      if(response && response.status()>=400) throw new Error(`사이트가 HTTP ${response.status()} 오류를 반환했습니다.`);
      const options={popupMode,waitMs,maxHeight:50000/device.scale};
      const dismissed=await preparePage(page,options,report);
      const hasViewport=await page.locator('meta[name="viewport"]').count();
      const warnings=[];
      if(device.id==='mobile'&&!hasViewport) warnings.push('모바일 viewport 설정이 없는 사이트라 모바일 전용 레이아웃이 아닐 수 있습니다.');
      const remaining=await page.locator('[role="dialog"]:visible,[aria-modal="true"]:visible,dialog[open]').count();
      if(remaining && popupMode==='auto') warnings.push('닫히지 않은 팝업이 있을 수 있습니다. 이미지를 확인해 주세요. 사이트별 닫기 규칙이 필요할 수 있습니다.');
      const height=await page.evaluate(()=>Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0,innerHeight));
      if(height>options.maxHeight) throw new Error('페이지가 이미지 높이 한도(50,000px)를 넘었습니다.');
      report('전체 페이지 PNG를 만드는 중');
      const file=path.join(directory,`${device.id}.png`);
      // An explicit viewport-width clip excludes accidental horizontal overflow.
      await page.screenshot({path:file,fullPage:true,clip:{x:0,y:0,width:device.width,height},animations:'disabled',caret:'hide',scale:'device',timeout:30000});
      const png=await fs.readFile(file);
      const width=png.readUInt32BE(16),actualHeight=png.readUInt32BE(20);
      if(width!==device.width*device.scale) throw new Error('캡처 이미지 폭이 예상과 다릅니다. 다시 시도해 주세요.');
      results.push({id:device.id,width,height:actualHeight,bytes:png.length,dismissed,warnings,filename:`${new URL(url).hostname.replace(/[^a-z0-9.-]/gi,'_')}-${device.id}-${width}.png`});
      await context.close();
    }
    return results;
  } finally {await browser.close();}
}
module.exports={capturePair,normalizeURL,publicURL,dismissOverlays};

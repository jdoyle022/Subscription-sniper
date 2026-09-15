#!/bin/bash
set -e
APP=/opt/subscription-sniper
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p $APP/src/{scripts/services,queue,utils} $APP/public
cp "$SRC_DIR/Adobe.js" $APP/src/scripts/services/adobe.js
echo "✓ adobe.js copied"
JWT=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
ENC=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
cat > $APP/.env << ENVEOF
PORT=3000
NODE_ENV=production
JWT_SECRET=$JWT
ADMIN_PASSWORD=changeme123
REDIS_URL=redis://localhost:6379
ENCRYPTION_KEY=$ENC
ENVEOF
echo "✓ .env done"
cat > $APP/src/utils/crypto.js << 'CEOF'
const crypto=require('crypto');
function getKey(){const k=process.env.ENCRYPTION_KEY;if(!k||k.length!==32)throw new Error('Bad key');return Buffer.from(k,'utf8');}
function encrypt(t){if(!t)return null;const iv=crypto.randomBytes(16);const c=crypto.createCipheriv('aes-256-gcm',getKey(),iv);const e=Buffer.concat([c.update(t,'utf8'),c.final()]);return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${e.toString('hex')}`;}
function decrypt(s){if(!s)return null;const[a,b,c]=s.split(':');const d=crypto.createDecipheriv('aes-256-gcm',getKey(),Buffer.from(a,'hex'));d.setAuthTag(Buffer.from(b,'hex'));return Buffer.concat([d.update(Buffer.from(c,'hex')),d.final()]).toString('utf8');}
module.exports={encrypt,decrypt};
CEOF

cat > $APP/src/utils/auth.js << 'AEOF'
const jwt=require('jsonwebtoken');
function verifyToken(req,res,next){const h=req.headers.authorization;if(!h||!h.startsWith('Bearer '))return res.status(401).json({error:'No token'});try{req.user=jwt.verify(h.slice(7),process.env.JWT_SECRET);next();}catch{return res.status(401).json({error:'Invalid token'});}}
function requireAdmin(req,res,next){if(req.query.key&&req.query.key===process.env.ADMIN_PASSWORD)return next();verifyToken(req,res,()=>{if(req.user?.role!=='admin')return res.status(403).json({error:'Forbidden'});next();});}
module.exports={verifyToken,requireAdmin};
AEOF

cat > $APP/src/queue/jobQueue.js << 'QEOF'
require('dotenv').config();
const{Queue}=require('bullmq');
const IORedis=require('ioredis');
const connection=new IORedis(process.env.REDIS_URL||'redis://localhost:6379',{maxRetriesPerRequest:null});
const cancelQueue=new Queue('cancellations',{connection,defaultJobOptions:{attempts:3,backoff:{type:'exponential',delay:5000},removeOnComplete:false,removeOnFail:false}});
async function addCancelJob(data){return cancelQueue.add('cancel',data,{jobId:`${data.userId}-${data.service}-${Date.now()}`});}
async function getJobStatus(id){const j=await cancelQueue.getJob(id);if(!j)return null;return{jobId:j.id,service:j.data.service,userId:j.data.userId,status:await j.getState(),result:j.returnvalue||null,error:j.failedReason||null,requestedAt:j.data.requestedAt,finishedAt:j.finishedOn?new Date(j.finishedOn).toISOString():null};}
async function getAllJobs(){const[w,a,c,f]=await Promise.all([cancelQueue.getWaiting(),cancelQueue.getActive(),cancelQueue.getCompleted(0,49),cancelQueue.getFailed(0,49)]);const fmt=(jobs,state)=>jobs.map(j=>({jobId:j.id,service:j.data.service,userId:j.data.userId,status:state,result:j.returnvalue||null,error:j.failedReason||null,requestedAt:j.data.requestedAt,finishedAt:j.finishedOn?new Date(j.finishedOn).toISOString():null}));return[...fmt(a,'active'),...fmt(w,'waiting'),...fmt(c,'completed'),...fmt(f,'failed')].sort((a,b)=>new Date(b.requestedAt)-new Date(a.requestedAt));}
module.exports={cancelQueue,connection,addCancelJob,getJobStatus,getAllJobs};
QEOF

cat > $APP/src/queue/worker.js << 'WEOF'
require('dotenv').config();
const{Worker}=require('bullmq');
const{connection}=require('./jobQueue');
const{decrypt}=require('../utils/crypto');
const{runCancellation}=require('../scripts');
const worker=new Worker('cancellations',async(job)=>{const{service,credentials,userId}=job.data;await job.updateProgress(10);const creds=credentials?{email:credentials.email,password:decrypt(credentials.password)}:null;await job.updateProgress(20);const result=await runCancellation(service,creds,job);await job.updateProgress(100);return result;},{connection,concurrency:2});
worker.on('completed',(job)=>console.log(`✓ ${job.data.service} done`));
worker.on('failed',(job,err)=>console.error(`✗ ${job?.data?.service}: ${err.message}`));
process.on('SIGTERM',async()=>{await worker.close();process.exit(0);});
WEOF
echo "✓ queue files done"
cat > $APP/src/scripts/index.js << 'SEOF'
const{chromium}=require('playwright');
const path=require('path');
const fs=require('fs');
async function screenshot(page,label){try{const dir=path.join(__dirname,'../../screenshots');if(!fs.existsSync(dir))fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,`${Date.now()}-${label}.png`);await page.screenshot({path:file});return file;}catch{return null;}}
async function launchBrowser(){return chromium.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']});}
async function runCancellation(service,credentials,job){
const scripts={'netflix':require('./services/netflix'),'spotify':require('./services/spotify'),'adobe':require('./services/adobe'),'hulu':require('./services/hulu'),'disney+':require('./services/disney'),'duolingo':require('./services/duolingo'),'nordvpn':require('./services/nordvpn'),'dropbox':require('./services/dropbox'),'notion':require('./services/notion'),'grammarly':require('./services/grammarly'),'canva':require('./services/canva')};
const script=scripts[service];
if(!script)return{success:false,manual:true,message:`No script for ${service} yet — cancel manually.`};
if(!credentials?.email||!credentials?.password)return{success:false,message:`Credentials required for ${service}.`};
const browser=await launchBrowser();
const page=await(await browser.newContext({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',viewport:{width:1280,height:800}})).newPage();
try{await job.updateProgress(30);const r=await script.cancel(page,credentials,screenshot);await job.updateProgress(90);return r;}
catch(err){return{success:false,message:`Failed: ${err.message}`};}
finally{await browser.close();}}
module.exports={runCancellation};
SEOF

cat > $APP/src/scripts/services/netflix.js << 'NEOF'
async function cancel(page,c,ss){
await page.goto('https://www.netflix.com/login',{waitUntil:'domcontentloaded'});
await page.fill('[name="userLoginId"]',c.email);
await page.fill('[name="password"]',c.password);
await page.click('[type="submit"]');
await page.waitForNavigation({timeout:15000});
if(page.url().includes('login'))return{success:false,message:'Netflix login failed. Check credentials.'};
await page.goto('https://www.netflix.com/cancelplan',{waitUntil:'domcontentloaded'});
await ss(page,'netflix-cancel');
const btn=await page.waitForSelector('button:has-text("Cancel Membership"),a:has-text("Cancel Membership")',{timeout:10000});
await btn.click();await page.waitForTimeout(2000);
const ok=await page.$('button:has-text("Finish Cancellation"),button:has-text("Complete Cancellation")');
if(ok){await ok.click();await page.waitForTimeout(2000);}
return{success:true,message:'Netflix cancelled. Access continues until end of billing period.'};}
module.exports={cancel};
NEOF

cat > $APP/src/scripts/services/spotify.js << 'SPEOF'
async function cancel(page,c,ss){
await page.goto('https://accounts.spotify.com/login',{waitUntil:'domcontentloaded'});
await page.fill('#login-username',c.email);await page.fill('#login-password',c.password);
await page.click('#login-button');await page.waitForNavigation({timeout:15000});
if(page.url().includes('login'))return{success:false,message:'Spotify login failed.'};
await page.goto('https://www.spotify.com/account/subscription/',{waitUntil:'domcontentloaded'});
const ch=await page.waitForSelector('a:has-text("Change Plan"),button:has-text("Change Plan")',{timeout:10000});
await ch.click();await page.waitForTimeout(2000);
const cp=await page.waitForSelector('button:has-text("Cancel Premium"),a:has-text("Cancel Premium")',{timeout:10000});
await cp.click();await page.waitForTimeout(2000);
const ok=await page.$('button:has-text("Confirm"),button:has-text("Yes, cancel")');
if(ok){await ok.click();await page.waitForTimeout(2000);}
return{success:true,message:'Spotify Premium cancelled. Reverts to free plan.'};}
module.exports={cancel};
SPEOF

cat > $APP/src/scripts/services/hulu.js << 'HUEOF'
async function cancel(page,c,ss){
try{
await page.goto('https://auth.hulu.com/web/login',{waitUntil:'domcontentloaded',timeout:20000});
await ss(page,'hulu-01-login');
const email=await page.waitForSelector('input[name=email],input[type=email]',{timeout:10000});
await email.fill(c.email);
const pw=await page.waitForSelector('input[name=password],input[type=password]',{timeout:10000});
await pw.fill(c.password);
await ss(page,'hulu-02-filled');
const loginBtn=await page.waitForSelector('button[type=submit],button:has-text("Log In")',{timeout:8000});
await loginBtn.click();
await page.waitForTimeout(3000);
await ss(page,'hulu-03-signed-in');
if(page.url().includes('login')){
const err=await page.$('.LoginErrorMessage,[data-automationid=error-message]');
return{success:false,message:err?'Hulu login failed: '+(await err.textContent()).trim():'Hulu login failed. Check credentials or complete any verification manually.'};
}
await page.goto('https://secure.hulu.com/account',{waitUntil:'domcontentloaded',timeout:20000});
await ss(page,'hulu-04-account');
const cancelLink=await page.waitForSelector('a:has-text("Cancel"),button:has-text("Cancel")',{timeout:12000});
await cancelLink.click();
await page.waitForTimeout(2000);
await ss(page,'hulu-05-cancel-offer');
try{
const declineOffer=await page.waitForSelector('button:has-text("Continue to Cancel"),a:has-text("No thanks"),button:has-text("No Thanks")',{timeout:8000});
await declineOffer.click();
await page.waitForTimeout(2000);
}catch(e){}
await ss(page,'hulu-06-confirm-screen');
const confirmBtn=await page.waitForSelector('button:has-text("Cancel Subscription"),button:has-text("Confirm Cancellation"),button:has-text("Yes, Cancel")',{timeout:10000});
await confirmBtn.click();
await page.waitForTimeout(3000);
await ss(page,'hulu-07-done');
return{success:true,message:'Hulu subscription cancelled. Access continues until end of your billing period. Check your email for Hulu confirmation.'};
}catch(err){throw new Error('Hulu script error: '+err.message);}
}
module.exports={cancel};
HUEOF
echo "✓ hulu.js done"

cat > $APP/src/scripts/services/disney.js << 'DPEOF'
async function cancel(page,c,ss){
try{
await page.goto('https://www.disneyplus.com/login',{waitUntil:'domcontentloaded',timeout:20000});
await ss(page,'disney-01-login');
const email=await page.waitForSelector('input[type=email],input[name=email]',{timeout:10000});
await email.fill(c.email);
const cont=await page.waitForSelector('button[type=submit],button:has-text("Continue")',{timeout:8000});
await cont.click();
await page.waitForTimeout(1500);
const pw=await page.waitForSelector('input[type=password]',{timeout:10000});
await pw.fill(c.password);
await ss(page,'disney-02-password');
const signIn=await page.waitForSelector('button[type=submit],button:has-text("Log In")',{timeout:8000});
await signIn.click();
await page.waitForTimeout(3000);
await ss(page,'disney-03-signed-in');
if(page.url().includes('login')){
const err=await page.$('[data-testid=error-message],.field-error');
return{success:false,message:err?'Disney+ login failed: '+(await err.textContent()).trim():'Disney+ login failed. Check credentials or complete any verification manually.'};
}
await page.goto('https://www.disneyplus.com/account',{waitUntil:'domcontentloaded',timeout:20000});
await ss(page,'disney-04-account');
const cancelLink=await page.waitForSelector('a:has-text("Cancel Subscription"),button:has-text("Cancel Subscription")',{timeout:12000});
await cancelLink.click();
await page.waitForTimeout(2000);
await ss(page,'disney-05-cancel-flow');
try{
const reason=await page.$('input[type=radio],[role=radio]');
if(reason){await reason.click();await page.waitForTimeout(500);}
const next=await page.waitForSelector('button:has-text("Continue"),button:has-text("Next")',{timeout:6000});
await next.click();
await page.waitForTimeout(2000);
}catch(e){}
await ss(page,'disney-06-confirm-screen');
const confirmBtn=await page.waitForSelector('button:has-text("Complete Cancellation"),button:has-text("Cancel Subscription"),button:has-text("Confirm")',{timeout:10000});
await confirmBtn.click();
await page.waitForTimeout(3000);
await ss(page,'disney-07-done');
return{success:true,message:'Disney+ subscription cancelled. Access continues until end of your billing period. Check your email for Disney+ confirmation.'};
}catch(err){throw new Error('Disney+ script error: '+err.message);}
}
module.exports={cancel};
DPEOF
echo "✓ disney.js done"

cat > $APP/src/scripts/services/duolingo.js << 'DUEOF'
async function cancel(page,c,ss){
try{
await page.goto('https://www.duolingo.com/log-in',{waitUntil:'domcontentloaded',timeout:20000});
await ss(page,'duolingo-01-login');
const idField=await page.waitForSelector('input[data-test="login-username"],input[name=identifier],input[type=email]',{timeout:10000});
await idField.fill(c.email);
const pwField=await page.waitForSelector('input[data-test="login-password"],input[type=password]',{timeout:10000});
await pwField.fill(c.password);
await ss(page,'duolingo-02-filled');
const loginBtn=await page.waitForSelector('button[data-test="register-button"],button:has-text("Log in")',{timeout:8000});
await loginBtn.click();
await page.waitForTimeout(3000);
await ss(page,'duolingo-03-signed-in');
if(page.url().includes('log-in')){
const err=await page.$('[data-test="login-form-error"],.error');
return{success:false,message:err?'Duolingo login failed: '+(await err.textContent()).trim():'Duolingo login failed. Check credentials or complete any verification manually.'};
}
await page.goto('https://www.duolingo.com/settings/subscription',{waitUntil:'domcontentloaded',timeout:20000});
await ss(page,'duolingo-04-subscription');
const cancelBtn=await page.waitForSelector('button:has-text("End subscription"),button:has-text("Cancel plan"),button:has-text("Cancel Super")',{timeout:12000});
await cancelBtn.click();
await page.waitForTimeout(2000);
await ss(page,'duolingo-05-cancel-flow');
try{
const skip=await page.waitForSelector('button:has-text("Continue to cancel"),button:has-text("No thanks")',{timeout:6000});
await skip.click();
await page.waitForTimeout(2000);
}catch(e){}
await ss(page,'duolingo-06-confirm-screen');
const confirmBtn=await page.waitForSelector('button:has-text("End subscription"),button:has-text("Yes, cancel"),button:has-text("Confirm")',{timeout:10000});
await confirmBtn.click();
await page.waitForTimeout(3000);
await ss(page,'duolingo-07-done');
return{success:true,message:'Duolingo subscription cancelled. Access continues until end of your billing period. Check your email for Duolingo confirmation.'};
}catch(err){throw new Error('Duolingo script error: '+err.message);}
}
module.exports={cancel};
DUEOF
echo "✓ duolingo.js done"

cat > $APP/src/scripts/services/nordvpn.js << 'NVEOF'
async function cancel(page,c,ss){
try{
await page.goto('https://my.nordaccount.com/login/',{waitUntil:'domcontentloaded',timeout:20000});
await ss(page,'nordvpn-01-login');
const email=await page.waitForSelector('input[name=username],input[type=email]',{timeout:10000});
await email.fill(c.email);
const cont=await page.waitForSelector('button[type=submit],button:has-text("Continue")',{timeout:8000});
await cont.click();
await page.waitForTimeout(1500);
const pw=await page.waitForSelector('input[type=password]',{timeout:10000});
await pw.fill(c.password);
await ss(page,'nordvpn-02-password');
const signIn=await page.waitForSelector('button[type=submit],button:has-text("Log in")',{timeout:8000});
await signIn.click();
await page.waitForTimeout(3000);
await ss(page,'nordvpn-03-signed-in');
if(page.url().includes('login')){
const err=await page.$('.error-message,[role=alert]');
return{success:false,message:err?'NordVPN login failed: '+(await err.textContent()).trim():'NordVPN login failed. Check credentials or complete any verification manually.'};
}
await page.goto('https://my.nordaccount.com/billing/',{waitUntil:'domcontentloaded',timeout:20000});
await ss(page,'nordvpn-04-billing');
const cancelLink=await page.waitForSelector('a:has-text("Cancel subscription"),button:has-text("Cancel subscription"),button:has-text("Cancel plan")',{timeout:12000});
await cancelLink.click();
await page.waitForTimeout(2000);
await ss(page,'nordvpn-05-cancel-flow');
try{
const reason=await page.$('input[type=radio],[role=radio]');
if(reason){await reason.click();await page.waitForTimeout(500);}
const next=await page.waitForSelector('button:has-text("Continue"),button:has-text("Next")',{timeout:6000});
await next.click();
await page.waitForTimeout(2000);
}catch(e){}
await ss(page,'nordvpn-06-confirm-screen');
const confirmBtn=await page.waitForSelector('button:has-text("Cancel subscription"),button:has-text("Confirm cancellation"),button:has-text("Yes, cancel")',{timeout:10000});
await confirmBtn.click();
await page.waitForTimeout(3000);
await ss(page,'nordvpn-07-done');
return{success:true,message:'NordVPN subscription cancelled. Access continues until end of your billing period. Check your email for NordVPN confirmation.'};
}catch(err){throw new Error('NordVPN script error: '+err.message);}
}
module.exports={cancel};
NVEOF
echo "✓ nordvpn.js done"

cat > $APP/src/scripts/services/dropbox.js << 'DBEOF'
async function cancel(page,c,ss){
try{
await page.goto('https://www.dropbox.com/login',{waitUntil:'domcontentloaded',timeout:20000});
await ss(page,'dropbox-01-login');
const email=await page.waitForSelector('input[name=login_email],input[type=email]',{timeout:10000});
await email.fill(c.email);
const pw=await page.waitForSelector('input[name=login_password],input[type=password]',{timeout:10000});
await pw.fill(c.password);
await ss(page,'dropbox-02-filled');
const loginBtn=await page.waitForSelector('button[type=submit],button:has-text("Log in")',{timeout:8000});
await loginBtn.click();
await page.waitForTimeout(3000);
await ss(page,'dropbox-03-signed-in');
if(page.url().includes('login')){
const err=await page.$('.error-message,[data-testid=error-message]');
return{success:false,message:err?'Dropbox login failed: '+(await err.textContent()).trim():'Dropbox login failed. Check credentials or complete any verification manually.'};
}
await page.goto('https://www.dropbox.com/account/plan',{waitUntil:'domcontentloaded',timeout:20000});
await ss(page,'dropbox-04-plan');
const cancelBtn=await page.waitForSelector('a:has-text("Cancel plan"),button:has-text("Cancel plan")',{timeout:12000});
await cancelBtn.click();
await page.waitForTimeout(2000);
await ss(page,'dropbox-05-cancel-survey');
try{
const reason=await page.$('input[type=radio],[role=radio]');
if(reason){await reason.click();await page.waitForTimeout(500);}
const next=await page.waitForSelector('button:has-text("Continue"),button:has-text("Next")',{timeout:6000});
await next.click();
await page.waitForTimeout(2000);
}catch(e){}
await ss(page,'dropbox-06-confirm-screen');
const confirmBtn=await page.waitForSelector('button:has-text("Cancel plan"),button:has-text("Confirm cancellation"),button:has-text("Yes, cancel")',{timeout:10000});
await confirmBtn.click();
await page.waitForTimeout(3000);
await ss(page,'dropbox-07-done');
return{success:true,message:'Dropbox plan cancelled. Reverts to Basic at end of your billing period. Check your email for Dropbox confirmation.'};
}catch(err){throw new Error('Dropbox script error: '+err.message);}
}
module.exports={cancel};
DBEOF
echo "✓ dropbox.js done"

cat > $APP/src/scripts/services/notion.js << 'NOEOF'
async function cancel(page,c,ss){
try{
await page.goto('https://www.notion.so/login',{waitUntil:'domcontentloaded',timeout:20000});
await ss(page,'notion-01-login');
const email=await page.waitForSelector('input[type=email]',{timeout:10000});
await email.fill(c.email);
const cont=await page.waitForSelector('button[type=submit],div:has-text("Continue with email")',{timeout:8000});
await cont.click();
await page.waitForTimeout(1500);
const pw=await page.waitForSelector('input[type=password]',{timeout:10000});
await pw.fill(c.password);
await ss(page,'notion-02-password');
const signIn=await page.waitForSelector('button[type=submit],div:has-text("Continue with password")',{timeout:8000});
await signIn.click();
await page.waitForTimeout(3000);
await ss(page,'notion-03-signed-in');
if(page.url().includes('login')){
const err=await page.$('.notion-error,[role=alert]');
return{success:false,message:err?'Notion login failed: '+(await err.textContent()).trim():'Notion login failed. Check credentials or complete any verification manually.'};
}
await page.goto('https://www.notion.so/settings/billing',{waitUntil:'domcontentloaded',timeout:20000});
await ss(page,'notion-04-billing');
const changePlan=await page.waitForSelector('div:has-text("Change plan"),button:has-text("Change plan")',{timeout:12000});
await changePlan.click();
await page.waitForTimeout(2000);
await ss(page,'notion-05-plan-list');
const freePlan=await page.waitForSelector('div:has-text("Free"),button:has-text("Downgrade")',{timeout:10000});
await freePlan.click();
await page.waitForTimeout(2000);
await ss(page,'notion-06-confirm-screen');
try{
const confirmBtn=await page.waitForSelector('button:has-text("Downgrade"),button:has-text("Confirm"),button:has-text("Continue")',{timeout:8000});
await confirmBtn.click();
await page.waitForTimeout(3000);
}catch(e){}
await ss(page,'notion-07-done');
return{success:true,message:'Notion workspace downgraded to Free at end of your billing period. Check your email for Notion confirmation.'};
}catch(err){throw new Error('Notion script error: '+err.message);}
}
module.exports={cancel};
NOEOF
echo "✓ notion.js done"

cat > $APP/src/scripts/services/grammarly.js << 'GREOF'
async function cancel(page,c,ss){
try{
await page.goto('https://app.grammarly.com/',{waitUntil:'domcontentloaded',timeout:20000});
await ss(page,'grammarly-01-login');
const email=await page.waitForSelector('input[name=email],input[type=email]',{timeout:10000});
await email.fill(c.email);
const cont=await page.waitForSelector('button[type=submit],button:has-text("Continue")',{timeout:8000});
await cont.click();
await page.waitForTimeout(1500);
const pw=await page.waitForSelector('input[name=password],input[type=password]',{timeout:10000});
await pw.fill(c.password);
await ss(page,'grammarly-02-password');
const signIn=await page.waitForSelector('button[type=submit],button:has-text("Log In")',{timeout:8000});
await signIn.click();
await page.waitForTimeout(3000);
await ss(page,'grammarly-03-signed-in');
if(page.url().includes('login')||page.url().includes('signin')){
const err=await page.$('.error-message,[data-testid=error-message]');
return{success:false,message:err?'Grammarly login failed: '+(await err.textContent()).trim():'Grammarly login failed. Check credentials or complete any verification manually.'};
}
await page.goto('https://account.grammarly.com/subscription',{waitUntil:'domcontentloaded',timeout:20000});
await ss(page,'grammarly-04-subscription');
const cancelLink=await page.waitForSelector('a:has-text("Cancel subscription"),button:has-text("Cancel subscription"),button:has-text("Cancel my subscription")',{timeout:12000});
await cancelLink.click();
await page.waitForTimeout(2000);
await ss(page,'grammarly-05-cancel-survey');
try{
const reason=await page.$('input[type=radio],[role=radio]');
if(reason){await reason.click();await page.waitForTimeout(500);}
const next=await page.waitForSelector('button:has-text("Continue"),button:has-text("Next")',{timeout:6000});
await next.click();
await page.waitForTimeout(2000);
}catch(e){}
await ss(page,'grammarly-06-confirm-screen');
const confirmBtn=await page.waitForSelector('button:has-text("Cancel subscription"),button:has-text("Confirm cancellation"),button:has-text("Yes, cancel")',{timeout:10000});
await confirmBtn.click();
await page.waitForTimeout(3000);
await ss(page,'grammarly-07-done');
return{success:true,message:'Grammarly Premium cancelled. Access continues until end of your billing period. Check your email for Grammarly confirmation.'};
}catch(err){throw new Error('Grammarly script error: '+err.message);}
}
module.exports={cancel};
GREOF
echo "✓ grammarly.js done"

cat > $APP/src/scripts/services/canva.js << 'CAEOF'
async function cancel(page,c,ss){
try{
await page.goto('https://www.canva.com/login',{waitUntil:'domcontentloaded',timeout:20000});
await ss(page,'canva-01-login');
const email=await page.waitForSelector('input[name=email],input[type=email]',{timeout:10000});
await email.fill(c.email);
const cont=await page.waitForSelector('button[type=submit],button:has-text("Continue")',{timeout:8000});
await cont.click();
await page.waitForTimeout(1500);
const pw=await page.waitForSelector('input[name=password],input[type=password]',{timeout:10000});
await pw.fill(c.password);
await ss(page,'canva-02-password');
const signIn=await page.waitForSelector('button[type=submit],button:has-text("Log in")',{timeout:8000});
await signIn.click();
await page.waitForTimeout(3000);
await ss(page,'canva-03-signed-in');
if(page.url().includes('login')){
const err=await page.$('[data-testid=error-message],.error-message');
return{success:false,message:err?'Canva login failed: '+(await err.textContent()).trim():'Canva login failed. Check credentials or complete any verification manually.'};
}
await page.goto('https://www.canva.com/settings/billing',{waitUntil:'domcontentloaded',timeout:20000});
await ss(page,'canva-04-billing');
const cancelLink=await page.waitForSelector('a:has-text("Cancel subscription"),button:has-text("Cancel subscription"),button:has-text("Cancel plan")',{timeout:12000});
await cancelLink.click();
await page.waitForTimeout(2000);
await ss(page,'canva-05-cancel-survey');
try{
const reason=await page.$('input[type=radio],[role=radio]');
if(reason){await reason.click();await page.waitForTimeout(500);}
const next=await page.waitForSelector('button:has-text("Continue"),button:has-text("Next")',{timeout:6000});
await next.click();
await page.waitForTimeout(2000);
}catch(e){}
await ss(page,'canva-06-confirm-screen');
const confirmBtn=await page.waitForSelector('button:has-text("Cancel subscription"),button:has-text("Confirm cancellation"),button:has-text("Yes, cancel")',{timeout:10000});
await confirmBtn.click();
await page.waitForTimeout(3000);
await ss(page,'canva-07-done');
return{success:true,message:'Canva subscription cancelled. Access continues until end of your billing period. Check your email for Canva confirmation.'};
}catch(err){throw new Error('Canva script error: '+err.message);}
}
module.exports={cancel};
CAEOF
echo "✓ canva.js done"

cat > $APP/src/server.js << 'SVEOF'
require('dotenv').config();
const express=require('express');
const cors=require('cors');
const path=require('path');
const{addCancelJob,getJobStatus,getAllJobs}=require('./queue/jobQueue');
const{encrypt}=require('./utils/crypto');
const{verifyToken,requireAdmin}=require('./utils/auth');
const app=express();
app.use(cors());app.use(express.json());app.use(express.static(path.join(__dirname,'../public')));
app.get('/health',(req,res)=>res.json({status:'ok',time:new Date().toISOString()}));
app.post('/api/auth/token',(req,res)=>{if(req.body.password!==process.env.ADMIN_PASSWORD)return res.status(401).json({error:'Invalid password'});const token=require('jsonwebtoken').sign({role:'admin'},process.env.JWT_SECRET,{expiresIn:'30d'});res.json({token});});
app.post('/api/cancel',verifyToken,async(req,res)=>{const{service,credentials,userId,billingSource}=req.body;if(!service||!userId)return res.status(400).json({error:'Missing fields'});if(billingSource==='apple'||billingSource==='google')return res.status(422).json({error:'manual_required',message:`${billingSource==='apple'?'Apple':'Google Play'} subscriptions must be cancelled on your device.`});try{const job=await addCancelJob({service:service.toLowerCase().trim(),credentials:credentials?{email:credentials.email,password:encrypt(credentials.password)}:null,userId,billingSource,requestedAt:new Date().toISOString()});res.json({jobId:job.id,status:'queued',message:`Cancellation queued for ${service}.`});}catch(err){res.status(500).json({error:'Queue failed'});}});
app.get('/api/status/:jobId',verifyToken,async(req,res)=>{const s=await getJobStatus(req.params.jobId);if(!s)return res.status(404).json({error:'Not found'});res.json(s);});
app.get('/api/admin/jobs',requireAdmin,async(req,res)=>res.json(await getAllJobs()));
app.listen(process.env.PORT||3000,()=>console.log('\n  🎯 Subscription Sniper running\n'));
SVEOF

echo ""
echo "✅ All files created successfully!"
echo "Now run: cd /opt/subscription-sniper && npm install && npx playwright install chromium"

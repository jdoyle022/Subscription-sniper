#!/bin/bash
set -e
APP=/opt/subscription-sniper
mkdir -p $APP/src/{scripts/services,queue,utils} $APP/public
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
const scripts={'netflix':require('./services/netflix'),'spotify':require('./services/spotify'),'hulu':require('./services/hulu'),'disney+':require('./services/disney'),'duolingo':require('./services/duolingo'),'nordvpn':require('./services/nordvpn'),'dropbox':require('./services/dropbox'),'notion':require('./services/notion'),'grammarly':require('./services/grammarly'),'canva':require('./services/canva')};
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

for svc in hulu disney duolingo nordvpn dropbox notion grammarly canva; do
cat > $APP/src/scripts/services/$svc.js << STEOF
async function cancel(page,c,ss){return{success:false,manual:true,message:'Script for $svc coming soon. Please cancel manually.'};}
module.exports={cancel};
STEOF
done

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

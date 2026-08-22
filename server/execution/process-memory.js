import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync=promisify(execFile);

function number(v){const n=Number(v);return Number.isFinite(n)&&n>=0?n:null;}
async function linuxRss(pid){const text=await fs.readFile(`/proc/${pid}/statm`,'utf8');const pages=Number(text.trim().split(/\s+/)[1]);if(!Number.isFinite(pages))throw new Error('bad statm');return pages*4096;}
async function psRss(pid){const {stdout}=await execFileAsync('ps',['-o','rss=','-p',String(pid)],{timeout:1500});const kb=number(String(stdout).trim());if(kb===null)throw new Error('bad ps');return kb*1024;}
async function windowsRss(pid){const {stdout}=await execFileAsync('tasklist',['/FI',`PID eq ${pid}`,'/FO','CSV','/NH'],{timeout:2500,windowsHide:true});const line=String(stdout).trim().split(/\r?\n/)[0]||'';if(/No tasks are running/i.test(line))throw new Error('missing process');const fields=[];let cur='',quoted=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){if(quoted&&line[i+1]==='"'){cur+='"';i++;}else quoted=!quoted;}else if(ch===','&&!quoted){fields.push(cur);cur='';}else cur+=ch;}fields.push(cur);const mem=(fields[4]||'').replace(/[^0-9]/g,'');const kb=number(mem);if(kb===null)throw new Error('bad tasklist');return kb*1024;}
export async function sampleProcessRss(pid){const n=Number(pid);if(!Number.isInteger(n)||n<=0)return{pid:n||null,rssBytes:null,estimated:true,source:'unavailable'};try{let rss;if(process.platform==='linux')rss=await linuxRss(n);else if(process.platform==='win32')rss=await windowsRss(n);else rss=await psRss(n);return{pid:n,rssBytes:rss,estimated:false,source:process.platform==='linux'?'/proc':process.platform==='win32'?'tasklist':'ps'};}catch{return{pid:n,rssBytes:null,estimated:true,source:'unavailable'};}}

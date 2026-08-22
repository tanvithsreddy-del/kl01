import { parseHtmlDocument } from './html-reader.js';

const MAX_EXTRACTED_CHARS = 1_000_000;

const WINDOWS_1252_C1 = new Map([
  [0x80,0x20ac],[0x81,0x0081],[0x82,0x201a],[0x83,0x0192],[0x84,0x201e],[0x85,0x2026],[0x86,0x2020],[0x87,0x2021],
  [0x88,0x02c6],[0x89,0x2030],[0x8a,0x0160],[0x8b,0x2039],[0x8c,0x0152],[0x8d,0x008d],[0x8e,0x017d],[0x8f,0x008f],
  [0x90,0x0090],[0x91,0x2018],[0x92,0x2019],[0x93,0x201c],[0x94,0x201d],[0x95,0x2022],[0x96,0x2013],[0x97,0x2014],
  [0x98,0x02dc],[0x99,0x2122],[0x9a,0x0161],[0x9b,0x203a],[0x9c,0x0153],[0x9d,0x009d],[0x9e,0x017e],[0x9f,0x0178],
]);
function decodeWindows1252(body){
  return new TextDecoder('windows-1252',{fatal:true}).decode(body).replace(/[\u0080-\u009f]/gu,ch=>String.fromCodePoint(WINDOWS_1252_C1.get(ch.codePointAt(0))));
}

function encodingFailure(label='') {
  return Object.assign(new Error('unsupported or invalid text encoding'), {
    code:'WEB_ENCODING_UNSUPPORTED',
    publicMessage:'That page used a text encoding KL01 could not read safely.',
    status:415,
    details:{ charset:String(label||'unknown').slice(0,80) },
  });
}
function normalizeCharset(value='') {
  const label=String(value||'').trim().replace(/^['"]|['"]$/gu,'').toLowerCase();
  const aliases=new Map([
    ['utf8','utf-8'],['unicode-1-1-utf-8','utf-8'],['ascii','windows-1252'],['us-ascii','windows-1252'],
    ['iso-8859-1','windows-1252'],['iso8859-1','windows-1252'],['latin1','windows-1252'],['latin-1','windows-1252'],['cp1252','windows-1252'],
    ['utf16','utf-16'],['unicode','utf-16'],['unicodefeff','utf-16le'],
  ]);
  return aliases.get(label)||label;
}
function contentTypeCharset(contentType='') {
  const match=String(contentType||'').match(/(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/iu);
  return normalizeCharset(match?.[1]||match?.[2]||match?.[3]||'');
}
function bomCharset(buffer) {
  if(buffer.length>=3&&buffer[0]===0xef&&buffer[1]===0xbb&&buffer[2]===0xbf)return'utf-8';
  if(buffer.length>=2&&buffer[0]===0xff&&buffer[1]===0xfe)return'utf-16le';
  if(buffer.length>=2&&buffer[0]===0xfe&&buffer[1]===0xff)return'utf-16be';
  return'';
}
function htmlMetaCharset(buffer) {
  const head=buffer.subarray(0,Math.min(buffer.length,8192)).toString('latin1');
  const direct=head.match(/<meta\b[^>]*\bcharset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>"']+))/iu);
  if(direct)return normalizeCharset(direct[1]||direct[2]||direct[3]||'');
  const legacy=head.match(/<meta\b[^>]*\bcontent\s*=\s*(?:"[^"]*charset\s*=\s*([^;\s"]+)[^"]*"|'[^']*charset\s*=\s*([^;\s']+)[^']*')/iu);
  return normalizeCharset(legacy?.[1]||legacy?.[2]||'');
}
function decoder(label){
  try{return new TextDecoder(label,{fatal:true});}
  catch{throw encodingFailure(label);}
}
function decodeBuffer(body,{contentType='',htmlLikely=false}={}) {
  if(!Buffer.isBuffer(body))return{raw:String(body||''),encoding:'string'};
  const explicit=contentTypeCharset(contentType);
  const bom=bomCharset(body);
  const meta=htmlLikely?htmlMetaCharset(body):'';
  // A byte-order mark is physical byte evidence and wins over a generic or
  // contradictory transport label. Meta is used only when transport/BOM did
  // not already establish an encoding.
  const requested=bom||explicit||meta||'utf-8';
  try{
    const raw=requested==='windows-1252'?decodeWindows1252(body):decoder(requested).decode(body);
    return{raw,encoding:requested};
  } catch(error){
    if(error?.code==='WEB_ENCODING_UNSUPPORTED')throw error;
    if(!explicit&&!bom&&!meta&&requested==='utf-8'){
      try{return{raw:decodeWindows1252(body),encoding:'windows-1252'};}catch{}
    }
    throw encodingFailure(requested);
  }
}

export function extractDocument(body, { contentType = '', url = '' } = {}) {
  const type = String(contentType || '').toLowerCase();
  const jsonLike = type.includes('application/json') || type.includes('+json');
  const xmlLike = type.includes('application/xml') || type.includes('+xml');
  if (type && !type.includes('text/') && !type.includes('application/xhtml') && !jsonLike && !xmlLike) {
    throw Object.assign(new Error('unsupported content type'), { code:'WEB_CONTENT_TYPE', publicMessage:'That page did not return readable text.', status:415 });
  }
  const byteHead=Buffer.isBuffer(body)?body.subarray(0,4096).toString('latin1'):String(body||'').slice(0,4096);
  const htmlLikely=type.includes('html') || /<!doctype\s+html|<html\b|<body\b|<head\b|<main\b|<article\b/iu.test(byteHead);
  const {raw,encoding}=decodeBuffer(body,{contentType,htmlLikely});
  if (htmlLikely || xmlLike) return { ...parseHtmlDocument(raw,{baseUrl:url,xml:xmlLike}), encoding };
  const full = raw.replace(/\0/gu, '').trim();
  const text = full.slice(0, MAX_EXTRACTED_CHARS);
  return { title:'', text, links:[], truncated:full.length > MAX_EXTRACTED_CHARS, encoding };
}

export const BROWSER_EXTRACT_EXPRESSION = `(() => {
  const root = document.querySelector('article,main,[role="main"]') || document.body || document.documentElement;
  const clone = root.cloneNode(true);
  for (const node of clone.querySelectorAll('script,style,noscript,template,svg,canvas,iframe,video,audio,picture,source')) node.remove();
  const text = (clone.innerText || clone.textContent || '').replace(/\\r/g,'').replace(/[\\t ]+/g,' ').replace(/ *\\n */g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim().slice(0,1000000);
  const links = Array.from(document.querySelectorAll('a[href]')).slice(0,200).map(a => ({ href:a.href, text:(a.innerText || a.textContent || '').trim().slice(0,300) })).filter(x => /^https?:/.test(x.href));
  return { title:String(document.title || '').slice(0,500), url:String(location.href), text, links, truncated:text.length >= 1000000 };
})()`;

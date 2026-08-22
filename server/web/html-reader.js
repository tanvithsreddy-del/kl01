const MAX_TEXT_CHARS = 1_000_000;
const MAX_TITLE_CHARS = 500;
const MAX_LINKS = 200;
const MAX_LINK_TEXT_CHARS = 300;
const MAX_LINK_URL_CHARS = 4096;
const MAX_ACCUMULATED_CHARS = MAX_TEXT_CHARS + 64_000;

const NAMED_ENTITIES = new Map([
  ['amp','&'],['lt','<'],['gt','>'],['quot','"'],['apos',"'"],['nbsp',' '],
  ['copy','©'],['reg','®'],['trade','™'],['hellip','…'],['ndash','–'],['mdash','—'],
  ['lsquo','‘'],['rsquo','’'],['ldquo','“'],['rdquo','”'],['bull','•'],['middot','·'],
  ['euro','€'],['pound','£'],['yen','¥'],['cent','¢'],['laquo','«'],['raquo','»'],
  ['sect','§'],['para','¶'],['deg','°'],['plusmn','±'],['times','×'],['divide','÷'],
  ['micro','µ'],['middot','·'],['ensp',' '],['emsp',' '],['thinsp',' '],
]);
const BLOCK_TAGS = new Set(['address','article','aside','blockquote','body','dd','div','dl','dt','fieldset','figcaption','figure','footer','form','h1','h2','h3','h4','h5','h6','header','hr','li','main','nav','ol','p','pre','section','table','tbody','td','tfoot','th','thead','tr','ul']);
const VOID_TAGS = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const RAW_SKIP_TAGS = new Set(['script','style']);
const SUBTREE_SKIP_TAGS = new Set(['noscript','template','svg','canvas','iframe','video','audio','picture']);
const PREFERRED_TAGS = new Set(['article','main']);

export function decodeHtmlEntities(value='') {
  return String(value).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/giu,(match,token)=>{
    if(token[0]==='#'){
      const hex=token[1]?.toLowerCase()==='x';
      const number=parseInt(token.slice(hex?2:1),hex?16:10);
      if(!Number.isFinite(number)||number<0||number>0x10ffff||number>=0xd800&&number<=0xdfff)return match;
      try{return String.fromCodePoint(number);}catch{return match;}
    }
    return NAMED_ENTITIES.get(token.toLowerCase())??match;
  });
}
function normalizedText(value=''){
  return String(value).replace(/\0/gu,'').replace(/\r/gu,'').replace(/[\t\f ]+/gu,' ').replace(/ *\n */gu,'\n').replace(/\n{3,}/gu,'\n\n').trim();
}
function appendBounded(parts,value){
  if(!value)return;
  const current=parts._chars||0;
  if(current>=MAX_ACCUMULATED_CHARS)return;
  const take=String(value).slice(0,MAX_ACCUMULATED_CHARS-current);
  parts.push(take);parts._chars=current+take.length;
}
function scanTagEnd(source,start){
  let quote='';
  for(let i=start;i<source.length;i+=1){
    const ch=source[i];
    if(quote){if(ch===quote)quote='';continue;}
    if(ch==='"'||ch==="'"){quote=ch;continue;}
    if(ch==='>')return i;
  }
  return -1;
}
function parseAttributes(source){
  const attrs=new Map();let i=0;
  while(i<source.length){
    while(i<source.length&&/[\s/]/u.test(source[i]))i+=1;
    if(i>=source.length)break;
    const start=i;
    while(i<source.length&&!/[\s=/>]/u.test(source[i]))i+=1;
    const name=source.slice(start,i).toLowerCase();
    if(!name){i+=1;continue;}
    while(i<source.length&&/\s/u.test(source[i]))i+=1;
    let value='';
    if(source[i]==='='){
      i+=1;while(i<source.length&&/\s/u.test(source[i]))i+=1;
      if(source[i]==='"'||source[i]==="'"){
        const quote=source[i++];const vstart=i;
        while(i<source.length&&source[i]!==quote)i+=1;
        value=source.slice(vstart,i);if(source[i]===quote)i+=1;
      }else{
        const vstart=i;while(i<source.length&&!/[\s>]/u.test(source[i]))i+=1;value=source.slice(vstart,i);
      }
    }
    if(!attrs.has(name))attrs.set(name,decodeHtmlEntities(value));
  }
  return attrs;
}
function isHidden(attrs){
  if(attrs.has('hidden'))return true;
  const aria=String(attrs.get('aria-hidden')||'').trim().toLowerCase();
  return aria==='true'||aria==='1';
}
function findRawClose(source,tag,from){
  const re=new RegExp(`</${tag}(?=[\\s>/])`, 'igu');re.lastIndex=from;
  const match=re.exec(source);if(!match)return null;
  const end=scanTagEnd(source,match.index+2+tag.length);
  return{start:match.index,end:end<0?source.length:end+1};
}
function cleanLinkText(parts){return normalizedText(parts.join(' ')).slice(0,MAX_LINK_TEXT_CHARS);}

export function parseHtmlDocument(source,{baseUrl='',xml=false}={}){
  const html=String(source||'');
  const bodyParts=[];const preferredRegions=[];const regionStack=[];const tagStack=[];const activeLinks=[];const links=[];const seenLinks=new Set();
  let title='';let i=0;let hiddenDepth=0;let headDepth=0;let documentBase=baseUrl;

  const append=(raw)=>{
    if(!raw||hiddenDepth>0||headDepth>0)return;
    const text=decodeHtmlEntities(raw);
    appendBounded(bodyParts,text);
    for(const region of regionStack)appendBounded(region.parts,text);
    for(const link of activeLinks)appendBounded(link.parts,text);
  };
  const newline=()=>append('\n');
  const closeLink=(tagIndex)=>{
    for(let n=activeLinks.length-1;n>=0;n-=1){
      const link=activeLinks[n];if(link.tagIndex!==tagIndex)continue;
      activeLinks.splice(n,1);
      const text=cleanLinkText(link.parts);
      if(link.href&&!seenLinks.has(link.href)&&links.length<MAX_LINKS){seenLinks.add(link.href);links.push({href:link.href,text});}
      return;
    }
  };
  const closeTagAt=(index)=>{
    const entry=tagStack[index];
    if(entry?.link)closeLink(index);
    if(entry?.region){
      const rindex=regionStack.lastIndexOf(entry.region);if(rindex>=0)regionStack.splice(rindex,1);
    }
    if(entry?.head)headDepth=Math.max(0,headDepth-1);
    if(entry?.hidden)hiddenDepth=Math.max(0,hiddenDepth-1);
    if(BLOCK_TAGS.has(entry?.name))newline();
  };
  const closeThrough=(name)=>{
    let index=-1;for(let n=tagStack.length-1;n>=0;n-=1){if(tagStack[n].name===name){index=n;break;}}
    if(index<0){if(BLOCK_TAGS.has(name))newline();return;}
    for(let n=tagStack.length-1;n>=index;n-=1)closeTagAt(n);
    tagStack.splice(index);
  };

  while(i<html.length){
    const lt=html.indexOf('<',i);
    if(lt<0){append(html.slice(i));break;}
    if(lt>i)append(html.slice(i,lt));
    if(html.startsWith('<!--',lt)){
      const end=html.indexOf('-->',lt+4);i=end<0?html.length:end+3;continue;
    }
    if(html.startsWith('<![CDATA[',lt)){
      const end=html.indexOf(']]>',lt+9);append(html.slice(lt+9,end<0?html.length:end));i=end<0?html.length:end+3;continue;
    }
    if(/^<!doctype\b/iu.test(html.slice(lt,lt+16))||html.startsWith('<!',lt)||html.startsWith('<?',lt)){
      const end=scanTagEnd(html,lt+2);i=end<0?html.length:end+1;continue;
    }
    const tagEnd=scanTagEnd(html,lt+1);
    if(tagEnd<0){
      const tail=html.slice(lt);
      const rawOpen=tail.match(/^<\s*(script|style|noscript|template|svg|canvas|iframe|video|audio|picture)\b/iu);
      if(!rawOpen)append(tail);
      i=html.length;continue;
    }
    const raw=html.slice(lt+1,tagEnd);const closing=/^\s*\//u.test(raw);const body=raw.replace(/^\s*\/?\s*/u,'');
    const nameMatch=body.match(/^([A-Za-z][A-Za-z0-9:-]*)/u);
    if(!nameMatch){i=tagEnd+1;continue;}
    const name=nameMatch[1].toLowerCase();
    if(closing){closeThrough(name);i=tagEnd+1;continue;}
    const rest=body.slice(nameMatch[0].length);const attrs=parseAttributes(rest);const selfClosing=/\/\s*$/u.test(raw)||VOID_TAGS.has(name);

    if(name==='base'&&attrs.has('href')){
      try{const resolved=new URL(String(attrs.get('href')||''),documentBase||baseUrl);if(/^https?:/iu.test(resolved.protocol))documentBase=resolved.href;}catch{}
    }
    if(xml&&name==='link'&&attrs.has('href')&&links.length<MAX_LINKS){
      try{const resolved=new URL(String(attrs.get('href')||''),documentBase||baseUrl);if(/^https?:/iu.test(resolved.protocol)&&!seenLinks.has(resolved.href)){seenLinks.add(resolved.href);links.push({href:resolved.href,text:String(attrs.get('title')||attrs.get('rel')||'').slice(0,MAX_LINK_TEXT_CHARS)});}}catch{}
    }

    if(RAW_SKIP_TAGS.has(name)){
      const close=findRawClose(html,name,tagEnd+1);i=close?close.end:html.length;continue;
    }
    if(name==='title'){
      const close=findRawClose(html,'title',tagEnd+1);const content=html.slice(tagEnd+1,close?close.start:html.length);
      if(!title)title=normalizedText(decodeHtmlEntities(content)).slice(0,MAX_TITLE_CHARS);
      i=close?close.end:html.length;continue;
    }
    if(name==='textarea'){
      const close=findRawClose(html,'textarea',tagEnd+1);const content=html.slice(tagEnd+1,close?close.start:html.length);
      append(decodeHtmlEntities(content));newline();i=close?close.end:html.length;continue;
    }
    if(name==='plaintext'){
      append(html.slice(tagEnd+1));i=html.length;continue;
    }

    if(BLOCK_TAGS.has(name)||name==='br')newline();
    const parentHidden=hiddenDepth>0;
    const ownHidden=SUBTREE_SKIP_TAGS.has(name)||isHidden(attrs);
    const entry={name,hidden:false,head:false,region:null,link:false};
    if(name==='head'){entry.head=true;headDepth+=1;}
    if(ownHidden){entry.hidden=true;hiddenDepth+=1;}
    if(PREFERRED_TAGS.has(name)||String(attrs.get('role')||'').trim().toLowerCase()==='main'){
      const region={parts:[],tag:name};preferredRegions.push(region);regionStack.push(region);entry.region=region;
    }
    if(name==='a'&&!parentHidden&&!ownHidden&&headDepth===0&&links.length<MAX_LINKS){
      const rawHref=String(attrs.get('href')||'').trim();let href='';
      if(rawHref&&rawHref.length<=MAX_LINK_URL_CHARS){try{const resolved=new URL(rawHref,documentBase||baseUrl).href;if(/^https?:/iu.test(resolved))href=resolved;}catch{}}
      if(href){const link={href,parts:[],tagIndex:tagStack.length};activeLinks.push(link);entry.link=true;}
    }
    if(!selfClosing)tagStack.push(entry);else{
      if(entry.region){const rindex=regionStack.lastIndexOf(entry.region);if(rindex>=0)regionStack.splice(rindex,1);}
      if(entry.head)headDepth=Math.max(0,headDepth-1);
      if(entry.hidden)hiddenDepth=Math.max(0,hiddenDepth-1);
    }
    i=tagEnd+1;
  }
  for(let n=tagStack.length-1;n>=0;n-=1)closeTagAt(n);
  // Close malformed/unclosed anchors at EOF.
  for(const link of [...activeLinks]){
    const text=cleanLinkText(link.parts);if(link.href&&!seenLinks.has(link.href)&&links.length<MAX_LINKS){seenLinks.add(link.href);links.push({href:link.href,text});}
  }
  const bodyText=normalizedText(bodyParts.join(' '));
  const candidates=preferredRegions.map(r=>normalizedText(r.parts.join(' '))).filter(Boolean).sort((a,b)=>b.length-a.length);
  const preferred=candidates[0]||'';
  const selected=preferred.length>=120?preferred:bodyText;
  const text=selected.slice(0,MAX_TEXT_CHARS);
  return{title,text,links,truncated:selected.length>MAX_TEXT_CHARS};
}

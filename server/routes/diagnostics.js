import { sendJson } from './http.js';
import { buildDiagnosticReport } from '../services/diagnostics.js';

export function diagnosticsRoute({preferences,targetManager,governor,flow}){
  return async(request,response,url)=>{
    if(request.method!=='GET'||url.pathname!=='/api/diagnostics')return false;
    const report=await buildDiagnosticReport({
      preferences,targetManager,governor,flow,
      chatId:url.searchParams.get('chatId')||null,
      messageId:url.searchParams.get('messageId')||null,
      includeDeveloperDetail:url.searchParams.has('developerDetail')?url.searchParams.get('developerDetail')==='true':null,
    });
    sendJson(response,200,report);return true;
  };
}

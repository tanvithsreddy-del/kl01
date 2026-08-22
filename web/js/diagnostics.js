export function downloadDiagnostic(report,{filename='kl01-diagnostic.json'}={}){
  const body=JSON.stringify(report,null,2);
  const blob=new Blob([`${body}\n`],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement('a');
  anchor.href=url;anchor.download=filename;anchor.rel='noopener';anchor.style.display='none';
  document.body.append(anchor);
  try{anchor.click();}finally{anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),0);}
}

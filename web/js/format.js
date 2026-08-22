export function bytes(value){const n=Number(value||0);if(n<1000)return `${n} B`;if(n<1e6)return `${(n/1e3).toFixed(1)} KB`;if(n<1e9)return `${(n/1e6).toFixed(n<1e8?1:0)} MB`;return `${(n/1e9).toFixed(2)} GB`}
export function duration(seconds){const n=Math.max(0,Math.round(Number(seconds||0)));if(n<60)return `${n} sec`;const m=Math.floor(n/60),s=n%60;return s?`${m} min ${s} sec`:`${m} min`}
export function indianNumber(value){return new Intl.NumberFormat('en-IN').format(Number(value||0))}
export function percent(value){return `${Math.max(0,Math.min(100,Math.round(Number(value||0)*100)))}%`}
export function dateGroup(iso){const date=new Date(iso),now=new Date();const days=Math.floor((new Date(now.toDateString())-new Date(date.toDateString()))/86400000);return days===0?'Today':days===1?'Yesterday':days<7?'This week':'Earlier'}

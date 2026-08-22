const PERMANENT_POLICY = new Set([
  'WEB_DESTINATION_BLOCKED','WEB_SCHEME_BLOCKED','WEB_PORT_BLOCKED','WEB_URL_INVALID','WEB_CREDENTIAL_URL','WEB_HOST_INVALID','WEB_PROFILE_PATH','WEB_CDP_ENDPOINT_MISMATCH','WEB_BROWSER_POLICY_UNVERIFIED',
  'WEB_REDIRECT_INVALID','WEB_REDIRECT_LOOP','WEB_REDIRECT_LIMIT','WEB_BODY_LIMIT','WEB_RENDER_BYTE_LIMIT','WEB_RENDER_REQUEST_LIMIT','WEB_ENCODING_UNSUPPORTED',
]);
const USER_ACTION = new Set(['WEB_PROXY_URL','WEB_PROXY_AUTH_UNSUPPORTED','WEB_PROXY_AUTH_REQUIRED','WEB_PROXY_PAC_UNSUPPORTED']);
const CANCEL = new Set(['WEB_CANCELLED','WEB_STALE_OPERATION']);
const TRANSIENT = new Set([
  'WEB_CONNECT_FAILED','WEB_RESPONSE_FAILED','WEB_DEADLINE','WEB_SEARCH_DEADLINE','WEB_RENDER_TIMEOUT','WEB_NAVIGATION_FAILED',
  'WEB_CDP_CLOSED','WEB_CDP_FAILED','WEB_CDP_TIMEOUT','WEB_CDP_CONNECT','WEB_CDP_ENDPOINT_TIMEOUT','WEB_BROWSER_EXITED','WEB_CDP_VERSION_FAILED','WEB_CDP_VERSION_TIMEOUT',
  'WEB_HTTP_STATUS','WEB_DISCOVERY_FAILED','WEB_BROWSER_CLEANUP','WEB_PROXY_CONNECT','WEB_PROXY_TIMEOUT','WEB_PROXY_PROTOCOL',
]);

export function classifyWebFailure(errorOrCode) {
  const code=String(typeof errorOrCode==='string'?errorOrCode:errorOrCode?.code||errorOrCode?.name||'WEB_UNKNOWN').slice(0,80);
  if(CANCEL.has(code))return {code,category:'cancel',retryable:false,permanent:true,userAction:false};
  if(PERMANENT_POLICY.has(code)||/^WEB_(?:DESTINATION_BLOCKED|POLICY|SCHEME_BLOCKED|PORT_BLOCKED)/u.test(code))return {code,category:'policy',retryable:false,permanent:true,userAction:false};
  if(USER_ACTION.has(code))return {code,category:'configuration',retryable:false,permanent:true,userAction:true};
  if(code==='WEB_BROWSER_MISSING'||code==='WEB_BROWSER_NOT_FOUND')return {code,category:'capability',retryable:false,permanent:false,userAction:false};
  if(TRANSIENT.has(code)||/^E(?:AI_AGAIN|CONNRESET|CONNREFUSED|TIMEDOUT)$/u.test(code))return {code,category:'transient',retryable:true,permanent:false,userAction:false};
  if(/^WEB_HTTP_STATUS$/u.test(code))return {code,category:'http',retryable:true,permanent:false,userAction:false};
  if(/^WEB_(?:CAPTCHA|LOGIN|SOFT_404|EVIDENCE|EXTRACT)/u.test(code))return {code,category:'content',retryable:false,permanent:false,userAction:false};
  return {code,category:'unknown',retryable:false,permanent:false,userAction:false};
}

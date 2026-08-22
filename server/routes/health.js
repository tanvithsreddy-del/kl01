import { sendJson } from './http.js';
import { PRODUCT_NAME, PRODUCT_STAGE, BUG_REPORT_EMAIL } from '../config.js';
export function healthRoute() {
  return async (request, response, url) => {
    if (request.method !== 'GET' || url.pathname !== '/api/health') return false;
    sendJson(response, 200, { status: 'ok', product: { name: PRODUCT_NAME, stage: PRODUCT_STAGE, bugReportEmail: BUG_REPORT_EMAIL } });
    return true;
  };
}

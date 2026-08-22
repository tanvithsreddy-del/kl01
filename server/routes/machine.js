import { inspectMachine } from '../services/machine.js';
import { sendJson } from './http.js';
export function machineRoute() {
  return async (request, response, url) => {
    if (request.method !== 'GET' || url.pathname !== '/api/machine') return false;
    sendJson(response, 200, await inspectMachine()); return true;
  };
}
